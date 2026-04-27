import React, { useState, useEffect, useMemo } from 'react';
import Icon from './Icon';
import FilterPanel from './FilterPanel';
import { useActiveRun, useActiveProject, useStore } from '../store/useStore';
import {
  query,
  getFilterOptions,
  getLiveScopeCount,
  getCascadingFilterOptions,
  createAnalysisScopeView,
} from '../services/DuckDBService';
import { EMPTY_FILTERS } from '../types';
import type { AnalysisFilters, FilterOptions } from '../types';

interface WorkCenterAuditData {
  workCenter: string;
  description: string;
  totalWOs: number;
  ruleFlagsCount: number;
  aiFlagsCount: number;
}

export default function AuditReportScreen() {
  const run = useActiveRun();
  const project = useActiveProject();
  const { reportingEmails, aiConfig, setScreen } = useStore();

  const [filters, setFilters] = useState<AnalysisFilters>(run?.analysisFilters ?? EMPTY_FILTERS);
  const [baseFilterOptions, setBaseFilterOptions] = useState<FilterOptions | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [, setLiveScopeCount] = useState<number | null>(null);

  const [wcData, setWcData] = useState<WorkCenterAuditData[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  const [selectedWCs, setSelectedWCs] = useState<Set<string>>(new Set());
  const [previewWC, setPreviewWC] = useState<WorkCenterAuditData | null>(null);

  const [sendingStatus, setSendingStatus] = useState<Record<string, 'sending' | 'success' | 'error'>>({});

  // 1. Load initial filter options
  useEffect(() => {
    if (!run?.hasDataInDB || !run.columnMap) return;
    getFilterOptions(run.columnMap).then((opts) => {
      setBaseFilterOptions(opts);
      setFilterOptions(opts);
    }).catch(console.error);
  }, [run?.hasDataInDB, run?.id]);

  // 2. Cascade filters and fetch WC data
  useEffect(() => {
    if (!run?.hasDataInDB || !run.columnMap || !baseFilterOptions) return;

    const t = setTimeout(async () => {
      setLoadingData(true);
      try {
        const [count, cascaded] = await Promise.all([
          getLiveScopeCount(filters, run.columnMap, project),
          getCascadingFilterOptions(filters, run.columnMap, project, baseFilterOptions),
        ]);
        setLiveScopeCount(count);
        setFilterOptions(cascaded);

        await createAnalysisScopeView(filters, run.columnMap, project);

        // Fetch Work Centers in scope
        const rows = await query(`
          SELECT 
            work_center, 
            MAX(work_center_description) as description, 
            COUNT(work_order_number) as total_wos,
            list(work_order_number) as wos
          FROM v_analysis_scope
          WHERE work_center IS NOT NULL
          GROUP BY work_center
        `);

        const data: WorkCenterAuditData[] = rows.map(r => {
          const wos = new Set((r.wos as any[]).map(String));
          const aiCount = run.aiFlags?.filter(f => wos.has(String(f.woNumber))).length || 0;
          const ruleCount = run.ruleChecks?.flaggedWOs.filter(f => wos.has(String(f.wo))).length || 0;
          return {
            workCenter: String(r.work_center),
            description: String(r.description || ''),
            totalWOs: Number(r.total_wos),
            aiFlagsCount: aiCount,
            ruleFlagsCount: ruleCount,
          };
        });

        // Sort alphabetically
        data.sort((a, b) => a.workCenter.localeCompare(b.workCenter));
        setWcData(data);

        // Clear selection if not in new data
        setSelectedWCs(prev => {
          const next = new Set<string>();
          data.forEach(d => {
            if (prev.has(d.workCenter)) next.add(d.workCenter);
          });
          return next;
        });

      } catch (err) {
        console.error(err);
      } finally {
        setLoadingData(false);
      }
    }, 300);

    return () => clearTimeout(t);
  }, [filters, run?.hasDataInDB, run?.id, baseFilterOptions, project, run?.aiFlags, run?.ruleChecks]);

  const handleSelectAll = () => {
    if (selectedWCs.size === wcData.length) {
      setSelectedWCs(new Set());
    } else {
      setSelectedWCs(new Set(wcData.map(w => w.workCenter)));
    }
  };

  const toggleSelect = (wc: string) => {
    const next = new Set(selectedWCs);
    if (next.has(wc)) next.delete(wc);
    else next.add(wc);
    setSelectedWCs(next);
  };

  const getEmailHtml = (wc: WorkCenterAuditData) => {
    const period = (filters.dateFrom || filters.dateTo) 
      ? `${filters.dateFrom || 'Start'} to ${filters.dateTo || 'End'}`
      : 'All time';

    return `
      <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
        <p>Dear ${wc.description || wc.workCenter},</p>
        <p>This is an automated summary of the latest Reliability Audit for your work center.</p>
        
        <h3 style="color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">Audit Scope</h3>
        <ul style="margin: 0; padding-left: 20px;">
          <li><strong>Period:</strong> ${period}</li>
          <li><strong>Work Center:</strong> ${wc.workCenter}</li>
        </ul>

        <h3 style="color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-top: 20px;">Findings Summary</h3>
        <ul style="margin: 0; padding-left: 20px;">
          <li><strong>Total Work Orders Analyzed:</strong> ${wc.totalWOs}</li>
          <li><strong>Work Orders with Rule Flags:</strong> ${wc.ruleFlagsCount}</li>
          <li><strong>Work Orders with AI Semantic Flags:</strong> ${wc.aiFlagsCount}</li>
        </ul>

        <p style="margin-top: 20px;">Please review the SAP Auditor dashboard for detailed insights and to resolve any flagged issues.</p>
        <p style="color: #64748b; font-size: 0.9em; margin-top: 30px;">Generated by SAP Auditor Platform</p>
      </div>
    `;
  };

  const sendEmail = async (wc: WorkCenterAuditData) => {
    if (!aiConfig.powerAutomateUrl) {
      alert("Please configure Power Automate URL in Settings first.");
      return;
    }
    const emailTo = reportingEmails[wc.workCenter];
    if (!emailTo) return;

    setSendingStatus(prev => ({ ...prev, [wc.workCenter]: 'sending' }));

    try {
      const res = await fetch(aiConfig.powerAutomateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailTo: emailTo,
          subject: `Reliability Audit Report - ${wc.description || wc.workCenter}`,
          emailBody: getEmailHtml(wc),
        })
      });
      if (res.ok) {
        setSendingStatus(prev => ({ ...prev, [wc.workCenter]: 'success' }));
      } else {
        throw new Error('Failed');
      }
    } catch (e) {
      console.error(e);
      setSendingStatus(prev => ({ ...prev, [wc.workCenter]: 'error' }));
    }
  };

  const sendBulk = async () => {
    const toSend = wcData.filter(w => selectedWCs.has(w.workCenter) && reportingEmails[w.workCenter]);
    if (toSend.length === 0) return;
    for (const wc of toSend) {
      await sendEmail(wc);
    }
  };

  if (!run) return <div className="p-10 text-slate-500">No active run.</div>;

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Top Filter Panel */}
      <div className="bg-white border-b shrink-0 px-6 py-4 shadow-sm z-10 relative">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <Icon name="mail" className="w-6 h-6 text-brand-600" />
              Audit Report Distribution
            </h1>
            <p className="text-sm text-slate-500 mt-1">Filter scope and dispatch summary reports to Work Center owners.</p>
          </div>
          <button
            onClick={() => setScreen('reporting-settings')}
            className="px-4 py-2 text-sm border border-slate-300 rounded font-bold hover:bg-slate-50 transition flex items-center gap-2"
          >
            <Icon name="gear" className="w-4 h-4" /> Reporting Settings
          </button>
        </div>

        {filterOptions ? (
          <FilterPanel
            filters={filters}
            onChange={setFilters}
            options={filterOptions}
            columnMap={run.columnMap}
            totalWOs={run.dataProfile?.distinctWOs ?? 0}
          />
        ) : (
          <div className="h-[68px] flex items-center justify-center text-xs text-slate-400">Loading filters...</div>
        )}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel: Work Centers Table */}
        <div className="w-1/2 flex flex-col border-r border-slate-200 bg-white">
          <div className="p-4 border-b flex justify-between items-center bg-slate-50/50">
            <div className="flex items-center gap-2">
              <button
                onClick={handleSelectAll}
                className="px-3 py-1.5 text-xs font-bold border border-slate-300 rounded hover:bg-white transition"
              >
                {selectedWCs.size === wcData.length && wcData.length > 0 ? 'Deselect All' : 'Select All'}
              </button>
              <button
                onClick={() => setSelectedWCs(new Set())}
                className="px-3 py-1.5 text-xs font-bold border border-slate-300 rounded hover:bg-white transition"
                disabled={selectedWCs.size === 0}
              >
                Clear
              </button>
            </div>
            <button
              onClick={sendBulk}
              disabled={selectedWCs.size === 0 || !aiConfig.powerAutomateUrl}
              className="px-4 py-1.5 text-sm bg-brand-600 text-white rounded font-bold hover:bg-brand-700 transition disabled:opacity-50 flex items-center gap-2"
            >
              <Icon name="send" className="w-4 h-4" /> Send Selected ({selectedWCs.size})
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingData ? (
              <div className="p-10 text-center text-slate-400 flex flex-col items-center">
                <Icon name="loader" className="w-6 h-6 animate-spin mb-2" />
                Updating scope...
              </div>
            ) : wcData.length === 0 ? (
              <div className="p-10 text-center text-slate-400">No work centers match the current filters.</div>
            ) : (
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] font-bold border-b sticky top-0 z-10">
                  <tr>
                    <th className="px-4 py-2 w-8"></th>
                    <th className="px-4 py-2">Work Center</th>
                    <th className="px-4 py-2">Total WOs</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {wcData.map(wc => {
                    const hasEmail = !!reportingEmails[wc.workCenter];
                    const status = sendingStatus[wc.workCenter];
                    const selected = selectedWCs.has(wc.workCenter);
                    const isPreviewed = previewWC?.workCenter === wc.workCenter;

                    return (
                      <tr 
                        key={wc.workCenter} 
                        className={`transition ${isPreviewed ? 'bg-brand-50/50' : 'hover:bg-slate-50'}`}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelect(wc.workCenter)}
                            className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${hasEmail ? 'bg-green-500' : 'bg-red-500'}`} title={hasEmail ? reportingEmails[wc.workCenter] : 'No email assigned'} />
                            <div>
                              <div className="font-mono font-medium text-slate-700">{wc.workCenter}</div>
                              <div className="text-xs text-slate-400 truncate max-w-[150px]">{wc.description}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-600">
                          {wc.totalWOs}
                        </td>
                        <td className="px-4 py-3 text-right space-x-2">
                          <button
                            onClick={() => setPreviewWC(wc)}
                            className="px-2 py-1 border border-slate-200 text-xs rounded font-bold text-slate-600 hover:bg-slate-100 transition"
                          >
                            Preview
                          </button>
                          <button
                            onClick={() => sendEmail(wc)}
                            disabled={!hasEmail || status === 'sending'}
                            className={`px-3 py-1 border text-xs rounded font-bold transition flex items-center gap-1 inline-flex ${
                              status === 'sending' ? 'bg-slate-100 border-slate-200 text-slate-400' :
                              status === 'success' ? 'bg-green-500 border-green-600 text-white' :
                              status === 'error' ? 'bg-red-500 border-red-600 text-white' :
                              hasEmail ? 'bg-white border-brand-300 text-brand-600 hover:bg-brand-50' :
                              'bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed'
                            }`}
                          >
                            {status === 'sending' ? <Icon name="loader" className="w-3 h-3 animate-spin" /> : 
                             status === 'success' ? <Icon name="check" className="w-3 h-3" /> :
                             status === 'error' ? <Icon name="alertTriangle" className="w-3 h-3" /> :
                             <Icon name="send" className="w-3 h-3" />}
                            Send
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right Panel: Email Preview */}
        <div className="w-1/2 bg-slate-100 p-6 flex flex-col relative overflow-y-auto">
          {previewWC ? (
            <div className="bg-white rounded-lg shadow-xl border border-slate-200 mx-auto w-full max-w-xl flex flex-col mt-4">
              <div className="border-b border-slate-100 bg-slate-50 p-4 rounded-t-lg space-y-2">
                <div className="text-[10px] uppercase font-bold text-slate-400">Email Preview</div>
                <div className="flex text-sm">
                  <span className="w-16 text-slate-400">To:</span>
                  <span className="font-mono text-slate-700">
                    {reportingEmails[previewWC.workCenter] || <span className="text-red-500 italic">Unassigned (Check Reporting Settings)</span>}
                  </span>
                </div>
                <div className="flex text-sm">
                  <span className="w-16 text-slate-400">Subject:</span>
                  <span className="font-semibold text-slate-800">Reliability Audit Report - {previewWC.description || previewWC.workCenter}</span>
                </div>
              </div>
              <div 
                className="p-6 prose prose-sm max-w-none text-slate-700"
                dangerouslySetInnerHTML={{ __html: getEmailHtml(previewWC) }}
              />
            </div>
          ) : (
            <div className="m-auto text-center text-slate-400 max-w-xs">
              <Icon name="mail" className="w-12 h-12 mx-auto text-slate-300 mb-4" />
              <p>Select "Preview" on a Work Center to view its email summary here.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
