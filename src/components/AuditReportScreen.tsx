import React, { useState, useEffect, useCallback } from 'react';
import Icon from './Icon';
import FilterPanel from './FilterPanel';
import { useActiveRun, useActiveProject, useStore } from '../store/useStore';
import { useRunAutoRestore } from '../hooks/useRunAutoRestore';
import {
  query,
  getFilterOptions,
  getLiveScopeCount,
  getCascadingFilterOptions,
  createAnalysisScopeView,
} from '../services/DuckDBService';
import { EMPTY_FILTERS } from '../types';
import type { AnalysisFilters, FilterOptions, ColumnMap, AIFlag, RuleCheckResult } from '../types';

const RULE_LABELS: Record<string, string> = {
  missing_confirmation: 'Missing Confirmation',
  not_listed_codes:     '"Not Listed" Codes',
  missing_scoping_text: 'Missing Scoping Text',
};

const AI_LABELS: Record<string, string> = {
  desc_code_conflict:              'Desc — Code Conflict',
  false_not_listed:                'False Not Listed',
  desc_confirmation_mismatch:      'Desc — Confirmation Mismatch',
  desc_code_confirmation_misalign: 'Desc — Code — Conf. Misalignment',
  generic_description:             'Generic Description',
  generic_confirmation:            'Generic Confirmation',
};

interface WorkCenterAuditData {
  workCenter: string;
  description: string;
  totalWOs: number;
  ruleFlagsCount: number;
  aiFlagsCount: number;
  ruleDistribution: Record<string, number>;
  aiDistribution: Record<string, number>;
}

// ── Standalone WC loader (mirrors ReportingSettingsScreen logic) ─────────────
async function loadWorkCenters(
  columnMap: ColumnMap,
  filters: AnalysisFilters,
  aiFlags: AIFlag[],
  ruleChecks: RuleCheckResult | null,
): Promise<WorkCenterAuditData[]> {
  const hasWC = !!columnMap.work_center;
  if (!hasWC) return [];

  const descCol = columnMap.work_center_description ? 'work_center_description' : null;

  const conditions: string[] = [`TRIM(CAST(work_center AS VARCHAR)) <> ''`];

  if (filters.dateFrom && columnMap.notification_date)
    conditions.push(`notification_date >= '${filters.dateFrom}'::DATE`);
  if (filters.dateTo && columnMap.notification_date)
    conditions.push(`notification_date <= '${filters.dateTo}'::DATE`);
  if (filters.workCenter.length > 0)
    conditions.push(`work_center IN (${filters.workCenter.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')})`);
  if (filters.functionalLocation.length > 0 && columnMap.functional_location)
    conditions.push(`functional_location IN (${filters.functionalLocation.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')})`);
  if (filters.equipment.length > 0) {
    const eq = columnMap.equipment_description ? 'equipment_description' : columnMap.equipment ? 'equipment' : null;
    if (eq) conditions.push(`${eq} IN (${filters.equipment.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')})`);
  }

  const where  = `WHERE ${conditions.join(' AND ')}`;
  const descExpr = descCol ? `MAX(${descCol})` : `''`;

  // STRING_AGG used instead of ARRAY_AGG for safe JS string handling across DuckDB versions
  const sql = `
    SELECT
      work_center,
      ${descExpr} AS description,
      COUNT(work_order_number) AS total_wos,
      STRING_AGG(CAST(work_order_number AS VARCHAR), '|') AS wo_list
    FROM v_wo_primary
    ${where}
    GROUP BY work_center
    ORDER BY work_center
  `;

  const rows = await query(sql);

  return rows.map(r => {
    const woSet = new Set(
      String(r.wo_list ?? '').split('|').filter(Boolean)
    );

    // Rule distribution: count flagged WOs per rule check ID
    const ruleDistribution: Record<string, number> = {};
    let ruleFlagsCount = 0;
    if (ruleChecks?.flaggedWOs) {
      for (const fw of ruleChecks.flaggedWOs) {
        if (!woSet.has(fw.wo)) continue;
        ruleFlagsCount++;
        for (const checkId of fw.checks) {
          ruleDistribution[checkId] = (ruleDistribution[checkId] ?? 0) + 1;
        }
      }
    }

    // AI distribution: unique flagged WOs per category
    const aiDistribution: Record<string, number> = {};
    const aiFlaggedWOs = new Set<string>();
    for (const flag of aiFlags) {
      if (!woSet.has(flag.woNumber)) continue;
      aiFlaggedWOs.add(flag.woNumber);
      aiDistribution[flag.category] = (aiDistribution[flag.category] ?? 0) + 1;
    }

    return {
      workCenter:       String(r.work_center ?? ''),
      description:      String(r.description ?? ''),
      totalWOs:         Number(r.total_wos ?? 0),
      ruleFlagsCount,
      aiFlagsCount:     aiFlaggedWOs.size,
      ruleDistribution,
      aiDistribution,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export default function AuditReportScreen() {
  const run = useActiveRun();
  const project = useActiveProject();
  const { reportingEmails, aiConfig, setScreen } = useStore();

  useRunAutoRestore(run);

  const [filters, setFilters] = useState<AnalysisFilters>(EMPTY_FILTERS);
  const [baseFilterOptions, setBaseFilterOptions] = useState<FilterOptions | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);

  const [wcData, setWcData] = useState<WorkCenterAuditData[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  const [selectedWCs, setSelectedWCs] = useState<Set<string>>(new Set());
  const [previewWC, setPreviewWC] = useState<WorkCenterAuditData | null>(null);
  const [sendingStatus, setSendingStatus] = useState<Record<string, 'sending' | 'success' | 'error'>>({});

  // ── Effect 1: load filter options on mount ──────────────────────────────────
  useEffect(() => {
    if (!run?.columnMap) return;
    getFilterOptions(run.columnMap).then((opts) => {
      setBaseFilterOptions(opts);
      setFilterOptions(opts);
    }).catch(console.error);
  }, [run?.id, run?.hasDataInDB, run?.columnMap]);

  // ── Effect 2: fetch WC list — no hasDataInDB guard (mirrors ReportingSettingsScreen) ──
  useEffect(() => {
    if (!run?.columnMap) return;

    const t = setTimeout(async () => {
      setLoadingData(true);
      try {
        const data = await loadWorkCenters(
          run.columnMap,
          filters,
          run.aiFlags ?? [],
          run.ruleChecks ?? null,
        );
        setWcData(data);
        setSelectedWCs(prev => {
          const next = new Set<string>();
          data.forEach(d => { if (prev.has(d.workCenter)) next.add(d.workCenter); });
          return next;
        });
      } catch (err) {
        console.error('WC load error:', err);
      } finally {
        setLoadingData(false);
      }
    }, 200);

    return () => clearTimeout(t);
  }, [filters, run?.id, run?.hasDataInDB, run?.columnMap, run?.aiFlags, run?.ruleChecks]);

  // ── Effect 3: cascade filter options when baseFilterOptions is ready ─────────
  useEffect(() => {
    if (!run?.columnMap || !baseFilterOptions) return;

    const t = setTimeout(async () => {
      try {
        const [, cascaded] = await Promise.all([
          getLiveScopeCount(filters, run.columnMap, project),
          getCascadingFilterOptions(filters, run.columnMap, project, baseFilterOptions),
        ]);
        setFilterOptions(cascaded);
        await createAnalysisScopeView(filters, run.columnMap, project);
      } catch (err) {
        console.error('Cascade error:', err);
      }
    }, 300);

    return () => clearTimeout(t);
  }, [filters, run?.id, run?.columnMap, baseFilterOptions, project]);

  const handleSelectAll = () => {
    if (selectedWCs.size === wcData.length && wcData.length > 0) {
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

  const getEmailText = (wc: WorkCenterAuditData): string => {
    const period = (filters.dateFrom || filters.dateTo)
      ? `${filters.dateFrom || 'Start'} to ${filters.dateTo || 'End'}`
      : 'All time';
    const projectName = project?.name || 'Reliability Audit';
    const periodLabel = run?.periodLabel || '';
    const now = new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
    const sep  = '='.repeat(58);
    const dash = '-'.repeat(42);
    const wcLabel = wc.description ? `${wc.workCenter} (${wc.description})` : wc.workCenter;

    // Helper: left-pad a label to a fixed width for aligned columns
    const distLine = (label: string, count: number) =>
      `    ${label.padEnd(38)}${count} WO${count !== 1 ? 's' : ''}`;

    // Build rule distribution lines (skip zero counts)
    const ruleLines = Object.entries(wc.ruleDistribution)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([key, val]) => distLine(RULE_LABELS[key] ?? key, val));

    // Build AI distribution lines (skip zero counts)
    const aiLines = Object.entries(wc.aiDistribution)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([key, val]) => distLine(AI_LABELS[key] ?? key, val));

    const hasAnyFlags = wc.ruleFlagsCount > 0 || wc.aiFlagsCount > 0;

    const errorDistSection: string[] = [
      'ERROR DISTRIBUTION',
      dash,
    ];

    if (!hasAnyFlags) {
      errorDistSection.push('  No issues detected for this work center.');
    } else {
      if (ruleLines.length > 0) {
        errorDistSection.push('  Rule-Based Issues:', ...ruleLines, '');
      }
      if (aiLines.length > 0) {
        errorDistSection.push('  AI-Detected Issues:', ...aiLines);
      }
    }

    return [
      sep,
      `  RELIABILITY AUDIT REPORT — ${projectName}`,
      `  Work Center: ${wcLabel}`,
      `  Period: ${periodLabel || period}  |  Generated: ${now}`,
      sep,
      '',
      `Audit Scope: ${period}`,
      '',
      '',
      'SUMMARY',
      dash,
      `This is an automated Reliability Audit summary for Work`,
      `Center ${wc.workCenter}. A full interactive dashboard is`,
      `attached to this email — open it in any web browser to`,
      `view charts, per-category breakdowns, and the complete`,
      `list of flagged work orders with AI comments.`,
      '',
      '',
      'FINDINGS',
      dash,
      `  ${'Total Work Orders Analyzed'.padEnd(30)}${wc.totalWOs}`,
      `  ${'Work Orders — Rule Flags'.padEnd(30)}${wc.ruleFlagsCount}`,
      `  ${'Work Orders — AI Flags'.padEnd(30)}${wc.aiFlagsCount}`,
      '',
      '',
      ...errorDistSection,
      '',
      '',
      'ACTION REQUIRED',
      dash,
      `Please review the flagged work orders for Work Center`,
      `${wc.workCenter} using the attached dashboard and apply`,
      `the necessary corrections in SAP, prioritising:`,
      '',
      `  1. HIGH-severity AI flags (misleading or conflicting data)`,
      `  2. Missing Confirmation (no closure text recorded)`,
      `  3. "Not Listed" Codes (incomplete failure coding)`,
      '',
      '',
      sep,
      `  SAP Reliability Auditor  ·  ${now}`,
      `  This message was generated automatically. Do not reply.`,
      sep,
    ].join('\n');
  };

  const sendEmail = async (wc: WorkCenterAuditData) => {
    if (!aiConfig.reportingWebhookUrl) {
      alert('Please configure Reporting Integration URL in Settings first.');
      return;
    }
    const emailTo = reportingEmails[wc.workCenter];
    if (!emailTo) return;

    setSendingStatus(prev => ({ ...prev, [wc.workCenter]: 'sending' }));
    try {
      const res = await fetch(aiConfig.reportingWebhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailTo,
          subject: `Reliability Audit Report — ${wc.description || wc.workCenter}`,
          emailBody: getEmailText(wc),
        }),
      });
      setSendingStatus(prev => ({ ...prev, [wc.workCenter]: res.ok ? 'success' : 'error' }));
    } catch {
      setSendingStatus(prev => ({ ...prev, [wc.workCenter]: 'error' }));
    }
  };

  const sendBulk = async () => {
    const toSend = wcData.filter(w => selectedWCs.has(w.workCenter) && reportingEmails[w.workCenter]);
    for (const wc of toSend) await sendEmail(wc);
  };

  if (!run) return <div className="p-10 text-slate-500">No active run.</div>;

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* ── Top bar ── */}
      <div className="bg-white border-b shrink-0 px-6 py-4 shadow-sm z-20 relative" style={{ overflow: 'visible' }}>
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
          <div className="h-[68px] flex items-center justify-center text-xs text-slate-400">Loading filters…</div>
        )}
      </div>

      {/* ── Main split ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: WC table */}
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
                disabled={selectedWCs.size === 0}
                className="px-3 py-1.5 text-xs font-bold border border-slate-300 rounded hover:bg-white transition disabled:opacity-40"
              >
                Clear
              </button>
            </div>
            <button
              onClick={sendBulk}
              disabled={selectedWCs.size === 0 || !aiConfig.reportingWebhookUrl}
              className="px-4 py-1.5 text-sm bg-brand-600 text-white rounded font-bold hover:bg-brand-700 transition disabled:opacity-50 flex items-center gap-2"
            >
              <Icon name="send" className="w-4 h-4" />
              Send Selected ({selectedWCs.size})
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingData ? (
              <div className="p-10 text-center text-slate-400 flex flex-col items-center gap-2">
                <Icon name="loader" className="w-6 h-6 animate-spin" />
                Loading work centers…
              </div>
            ) : wcData.length === 0 ? (
              <div className="p-10 text-center text-slate-400">
                {!run.columnMap?.work_center
                  ? 'Work Center column is not mapped. Please map it in the Schema Mapper.'
                  : 'No work centers match the current filters.'}
              </div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] font-bold border-b sticky top-0 z-[1]">
                  <tr>
                    <th className="px-4 py-2 w-8" />
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
                        className={`transition ${isPreviewed ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
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
                            <div
                              className={`w-2 h-2 rounded-full shrink-0 ${hasEmail ? 'bg-green-500' : 'bg-red-400'}`}
                              title={hasEmail ? reportingEmails[wc.workCenter] : 'No email assigned'}
                            />
                            <div>
                              <div className="font-mono font-medium text-slate-700">{wc.workCenter}</div>
                              {wc.description && (
                                <div className="text-xs text-slate-400 truncate max-w-[160px]">{wc.description}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-600">{wc.totalWOs}</td>
                        <td className="px-4 py-3 text-right flex items-center justify-end gap-2">
                          <button
                            onClick={() => setPreviewWC(wc)}
                            className="px-2 py-1 border border-slate-200 text-xs rounded font-bold text-slate-600 hover:bg-slate-100 transition"
                          >
                            Preview
                          </button>
                          <button
                            onClick={() => sendEmail(wc)}
                            disabled={!hasEmail || status === 'sending'}
                            className={`px-3 py-1 border text-xs rounded font-bold transition flex items-center gap-1 ${
                              status === 'sending' ? 'bg-slate-100 border-slate-200 text-slate-400' :
                              status === 'success' ? 'bg-green-500 border-green-600 text-white' :
                              status === 'error'   ? 'bg-red-500 border-red-600 text-white' :
                              hasEmail            ? 'bg-white border-brand-300 text-brand-600 hover:bg-brand-50' :
                                                    'bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed'
                            }`}
                          >
                            {status === 'sending' ? <Icon name="loader" className="w-3 h-3 animate-spin" /> :
                             status === 'success' ? <Icon name="check"  className="w-3 h-3" /> :
                             status === 'error'   ? <Icon name="alertTriangle" className="w-3 h-3" /> :
                                                    <Icon name="send"   className="w-3 h-3" />}
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

        {/* Right: Email Preview */}
        <div className="w-1/2 bg-slate-100 p-6 flex flex-col overflow-y-auto">
          {previewWC ? (
            <div className="bg-white rounded-lg shadow-xl border border-slate-200 mx-auto w-full max-w-xl mt-4">
              <div className="border-b border-slate-100 bg-slate-50 p-4 rounded-t-lg space-y-2">
                <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Email Preview</div>
                <div className="flex text-sm gap-2">
                  <span className="w-16 text-slate-400 shrink-0">To:</span>
                  <span className="font-mono text-slate-700">
                    {reportingEmails[previewWC.workCenter] || (
                      <span className="text-red-500 italic">Unassigned — configure in Reporting Settings</span>
                    )}
                  </span>
                </div>
                <div className="flex text-sm gap-2">
                  <span className="w-16 text-slate-400 shrink-0">Subject:</span>
                  <span className="font-semibold text-slate-800">
                    Reliability Audit Report — {previewWC.description || previewWC.workCenter}
                  </span>
                </div>
              </div>
              <pre className="p-6 text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed">
                {getEmailText(previewWC)}
              </pre>
            </div>
          ) : (
            <div className="m-auto text-center text-slate-400 max-w-xs">
              <Icon name="mail" className="w-12 h-12 mx-auto text-slate-300 mb-4" />
              <p>Select <strong>Preview</strong> on a Work Center to see its email summary here.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
