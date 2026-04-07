import React, { useState, useMemo } from 'react';
import Icon from './Icon';
import { useActiveSession } from '../store/useStore';
import type { Anomaly, AnomalySeverity } from '../analysis/analysisTypes';

type SeverityFilter = 'ALL' | AnomalySeverity;
type ModuleFilter   = 'ALL' | string;

export default function IssueExplorer() {
  const session = useActiveSession();

  const [selectedId,      setSelectedId]      = useState<string | null>(null);
  const [severityFilter,  setSeverityFilter]  = useState<SeverityFilter>('ALL');
  const [moduleFilter,    setModuleFilter]    = useState<ModuleFilter>('ALL');
  const [search,          setSearch]          = useState('');

  if (!session?.analysisResults) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        No analysis results. Run analysis from the Data Profiler screen.
      </div>
    );
  }

  const results = session.analysisResults;

  // Collect all anomalies from all modules
  const allAnomalies = useMemo(() =>
    results.modules.flatMap(m =>
      m.anomalies.map(a => ({ ...a, moduleName: m.moduleName }))
    ).sort((a, b) => b.score - a.score),
    [results]
  );

  // Apply filters
  const filtered = useMemo(() => allAnomalies.filter(a => {
    if (severityFilter !== 'ALL' && a.severity !== severityFilter) return false;
    if (moduleFilter   !== 'ALL' && a.moduleId  !== moduleFilter)  return false;
    if (search && !a.label.toLowerCase().includes(search.toLowerCase())
               && !a.description.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [allAnomalies, severityFilter, moduleFilter, search]);

  const selected = filtered.find(a => a.id === selectedId) ?? filtered[0] ?? null;

  const modules = results.modules.map(m => ({ id: m.moduleId, name: m.moduleName }));

  return (
    <div className="flex h-full">

      {/* ── Left panel: issue list ── */}
      <div className="w-96 border-r border-slate-200 flex flex-col shrink-0">

        {/* Filters */}
        <div className="p-3 border-b border-slate-200 bg-slate-50 space-y-2">
          <div className="relative">
            <Icon name="search" className="w-4 h-4 text-slate-400 absolute left-2.5 top-2" />
            <input
              type="text"
              placeholder="Search issues…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded outline-none focus:border-brand-500 bg-white"
            />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {(['ALL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as SeverityFilter[]).map(sv => (
              <button
                key={sv}
                onClick={() => setSeverityFilter(sv)}
                className={`px-2 py-0.5 rounded-full border text-[10px] font-bold transition ${
                  severityFilter === sv
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                }`}
              >
                {sv}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <button
              onClick={() => setModuleFilter('ALL')}
              className={`px-2 py-0.5 rounded-full border text-[10px] font-bold transition ${moduleFilter === 'ALL' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200'}`}
            >
              All Modules
            </button>
            {modules.map(m => (
              <button
                key={m.id}
                onClick={() => setModuleFilter(m.id)}
                className={`px-2 py-0.5 rounded-full border text-[10px] font-bold transition ${moduleFilter === m.id ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200'}`}
              >
                {m.name.split(' ')[0]}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-slate-400">
            {filtered.length} of {allAnomalies.length} issues
          </div>
        </div>

        {/* Issue list */}
        <div className="flex-1 overflow-y-auto scroll-thin divide-y divide-slate-100">
          {filtered.length === 0 && (
            <div className="p-6 text-center text-slate-400 text-sm">No issues match the current filters.</div>
          )}
          {filtered.map(a => (
            <button
              key={a.id}
              onClick={() => setSelectedId(a.id)}
              className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${
                selected?.id === a.id
                  ? 'bg-brand-50 border-r-2 border-brand-600'
                  : 'hover:bg-slate-50'
              }`}
            >
              <SeverityDot severity={a.severity} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-slate-800 truncate">{a.label}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">{(a as any).moduleName}</div>
              </div>
              <div className="shrink-0 font-mono text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                {a.affectedCount.toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Right panel: issue detail ── */}
      <div className="flex-1 overflow-auto scroll-thin p-6">
        {selected ? (
          <IssueDetail anomaly={selected} />
        ) : (
          <div className="flex items-center justify-center h-full text-slate-400 text-sm">
            Select an issue to view details.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Issue detail ─────────────────────────────────────────────────────────────

function IssueDetail({ anomaly: a }: { anomaly: Anomaly & { moduleName?: string } }) {
  const pct = a.totalCount > 0 ? Math.round((a.affectedCount / a.totalCount) * 100) : 0;

  return (
    <div className="max-w-2xl space-y-5 animate-enter">

      {/* Header */}
      <div className="flex items-start gap-3">
        <SeverityBadge severity={a.severity} />
        <div>
          <h2 className="text-xl font-bold text-slate-900">{a.label}</h2>
          <div className="text-xs text-slate-400 mt-0.5">
            {(a as any).moduleName} · Type: <span className="font-mono">{a.type}</span>
          </div>
        </div>
      </div>

      {/* Impact */}
      <div className="bg-white rounded shadow border border-slate-200 p-5">
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-3">Impact</div>
        <div className="flex gap-6">
          <div>
            <div className="text-3xl font-bold font-mono text-slate-900">{a.affectedCount.toLocaleString()}</div>
            <div className="text-xs text-slate-400">affected work orders</div>
          </div>
          <div>
            <div className="text-3xl font-bold font-mono text-slate-900">{pct}%</div>
            <div className="text-xs text-slate-400">of total ({a.totalCount.toLocaleString()})</div>
          </div>
          <div>
            <div className="text-3xl font-bold font-mono text-slate-900">{a.score}</div>
            <div className="text-xs text-slate-400">anomaly score /100</div>
          </div>
        </div>
        <div className="mt-3 h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${a.severity === 'HIGH' ? 'bg-red-500' : a.severity === 'MEDIUM' ? 'bg-amber-400' : 'bg-yellow-300'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Description */}
      <div className="bg-white rounded shadow border border-slate-200 p-5">
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-2">Finding</div>
        <p className="text-sm text-slate-700 leading-relaxed">{a.description}</p>
      </div>

      {/* SQL basis */}
      <div className="bg-white rounded shadow border border-slate-200 p-5">
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-2 flex items-center gap-1.5">
          <Icon name="database" className="w-3.5 h-3.5" />
          SQL Logic (DuckDB — no AI involved)
        </div>
        <div className="font-mono text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded px-3 py-3 whitespace-pre-wrap">
          {a.sqlBasis}
        </div>
      </div>

      {/* Samples */}
      {a.samples.length > 0 && (
        <div className="bg-white rounded shadow border border-slate-200 p-5">
          <div className="text-[10px] font-bold uppercase text-slate-400 mb-3">
            Sample Work Orders ({a.samples.length} of {a.affectedCount})
          </div>
          <div className="space-y-2">
            {a.samples.map((s, i) => (
              <div key={i} className="flex flex-wrap gap-3 text-xs bg-slate-50 border border-slate-200 rounded px-3 py-2">
                {s.wo && (
                  <span className="font-mono font-bold text-slate-800">{s.wo}</span>
                )}
                {s.equipment && (
                  <>
                    <span className="text-slate-300">|</span>
                    <span className="text-slate-600">{s.equipment}</span>
                  </>
                )}
                {s.description && (
                  <>
                    <span className="text-slate-300">|</span>
                    <span className="text-slate-500 italic truncate max-w-xs">{s.description}</span>
                  </>
                )}
                {s.value && (
                  <>
                    <span className="text-slate-300">|</span>
                    <span className="font-mono text-slate-700">{s.value}</span>
                  </>
                )}
                {s.flag && (
                  <span className="ml-auto text-amber-600 font-bold">{s.flag}</span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-slate-400">
            Samples are raw data — not processed by AI.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

function SeverityDot({ severity }: { severity: string }) {
  const cls =
    severity === 'HIGH'   ? 'bg-red-500' :
    severity === 'MEDIUM' ? 'bg-amber-400' :
    severity === 'LOW'    ? 'bg-yellow-300' : 'bg-slate-300';
  return <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${cls}`} />;
}

function SeverityBadge({ severity }: { severity: string }) {
  const cls =
    severity === 'HIGH'   ? 'bg-red-100 text-red-700' :
    severity === 'MEDIUM' ? 'bg-amber-100 text-amber-700' :
    severity === 'LOW'    ? 'bg-yellow-100 text-yellow-700' : 'bg-slate-100 text-slate-500';
  return <span className={`text-xs font-bold px-2.5 py-1 rounded shrink-0 ${cls}`}>{severity}</span>;
}
