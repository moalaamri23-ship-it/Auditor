import React, { useState, useEffect } from 'react';
import { RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer, Tooltip } from 'recharts';
import Icon from './Icon';
import FilterPanel from './FilterPanel';
import AnalysisView from './AnalysisView';
import { useActiveSession, useStore } from '../store/useStore';
import { runAllModules } from '../analysis/AnalysisEngine';
import { getFilterOptions, queryAIFlags } from '../services/DuckDBService';
import type { ModuleResult, AnalysisResults, ModuleStatus } from '../analysis/analysisTypes';
import type { AnalysisFilters, FilterOptions, AIFlagSummary, FlagCategory } from '../types';
import { EMPTY_FILTERS } from '../types';

export default function AuditDashboard() {
  const session  = useActiveSession();
  const { setScreen, updateSession, aiConfig } = useStore();
  const [filters,       setFilters]       = useState<AnalysisFilters>(session?.analysisFilters ?? EMPTY_FILTERS);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [isRerunning,   setIsRerunning]   = useState(false);
  const [showModules,   setShowModules]   = useState(false);

  // Sync local filters when session changes
  useEffect(() => {
    if (session?.analysisFilters) setFilters(session.analysisFilters);
  }, [session?.id]);

  // Load filter options once
  useEffect(() => {
    if (!session?.hasDataInDuckDB || !session.columnMap) return;
    getFilterOptions(session.columnMap).then(setFilterOptions).catch(() => {});
  }, [session?.hasDataInDuckDB, session?.id]);

  const filtersChanged = JSON.stringify(filters) !== JSON.stringify(session?.analysisFilters ?? EMPTY_FILTERS);

  const handleRerun = async () => {
    if (!session) return;
    setIsRerunning(true);
    try {
      const hasAI = !!(aiConfig?.apiKey?.trim() || aiConfig?.provider === 'copilot');
      const results = await runAllModules({
        sessionId:  session.id,
        columnMap:  session.columnMap,
        filters,
        aiConfig:   hasAI ? aiConfig : undefined,
      });

      const sessionUpdates: Parameters<typeof updateSession>[1] = {
        analysisResults: results,
        analysisFilters: filters,
        maturityScore:   results.maturityScore,
        aiFlagSummary:   results.aiFlagSummary ?? null,
        lastAnalysedAt:  new Date().toISOString(),
      };

      if (results.aiFlagSummary) {
        const flags = await queryAIFlags();
        sessionUpdates.aiFlags = flags;
      }

      updateSession(session.id, sessionUpdates);
    } finally {
      setIsRerunning(false);
    }
  };

  if (!session?.analysisResults) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-400">
        <Icon name="barChart" className="w-12 h-12" />
        <div className="text-sm">No analysis results found.</div>
        <button
          onClick={() => setScreen('profiler')}
          className="bg-slate-900 text-white px-4 py-2 rounded text-sm font-bold"
        >
          Go to Data Profiler
        </button>
      </div>
    );
  }

  // ── Module drill-down view ────────────────────────────────────────────────
  if (showModules) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-6 py-3 bg-white border-b border-slate-200 flex items-center gap-3 shrink-0">
          <button
            onClick={() => setShowModules(false)}
            className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-slate-900 transition"
          >
            <Icon name="chevronLeft" className="w-3.5 h-3.5" />
            Back to Overview
          </button>
          <span className="text-slate-300">|</span>
          <span className="text-xs font-bold text-slate-700">Module Details</span>
        </div>
        <div className="flex-1 overflow-hidden">
          <AnalysisView />
        </div>
      </div>
    );
  }

  const results   = session.analysisResults;
  const totalWOs  = session.dataProfile?.distinctWOs ?? results.scopeWOCount;
  const flagSummary = session.aiFlagSummary ?? results.aiFlagSummary ?? null;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">

      {/* ── Page header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Audit Dashboard</h1>
          <p className="text-sm text-slate-500 mt-1">
            {session.name} · Analysed {fmtDate(results.computedAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setScreen('insights')}
            className="bg-gradient-to-r from-brand-600 to-indigo-600 text-white px-4 py-2 rounded font-bold flex items-center gap-2 text-sm shadow hover:shadow-lg transition"
          >
            <Icon name="wand" className="w-4 h-4" />
            AI Insights
          </button>
          <button
            onClick={() => setShowModules(true)}
            className="bg-slate-900 text-white px-4 py-2 rounded font-bold flex items-center gap-2 text-sm hover:bg-slate-800 transition"
          >
            <Icon name="barChart" className="w-4 h-4" />
            View Modules
          </button>
        </div>
      </div>

      {/* ── Filter panel ── */}
      {filterOptions && (
        <div className="space-y-2">
          <FilterPanel
            filters={filters}
            options={filterOptions}
            columnMap={session.columnMap}
            totalWOs={totalWOs}
            scopeWOs={results.scopeWOCount}
            onChange={setFilters}
          />
          {filtersChanged && (
            <div className="flex items-center gap-3 animate-enter">
              <span className="text-xs text-amber-600 font-bold">
                Filters changed — re-run analysis to update results.
              </span>
              <button
                onClick={handleRerun}
                disabled={isRerunning}
                className="bg-gradient-to-r from-brand-600 to-indigo-600 text-white px-4 py-1.5 rounded font-bold flex items-center gap-2 text-xs shadow hover:shadow-md transition disabled:opacity-50"
              >
                {isRerunning ? (
                  <><Icon name="loader" className="w-3.5 h-3.5 animate-spin" /> Re-running…</>
                ) : (
                  <><Icon name="bolt" className="w-3.5 h-3.5" /> Re-run Analysis</>
                )}
              </button>
            </div>
          )}
          {isRerunning && (
            <div className="flex items-center gap-2 text-xs text-slate-500 animate-enter">
              <Icon name="loader" className="w-3.5 h-3.5 animate-spin text-brand-500" />
              Running analysis on filtered scope…
            </div>
          )}
        </div>
      )}

      {/* ── Maturity score + module cards ── */}
      <div className="grid md:grid-cols-4 gap-5">
        <MaturityCard results={results} />
        {results.modules.map((mod) => (
          <ModuleSummaryCard
            key={mod.moduleId}
            module={mod}
            onClick={() => setShowModules(true)}
          />
        ))}
      </div>

      {/* ── Radar chart ── */}
      <div className="bg-white rounded shadow border border-slate-200 p-6 animate-enter">
        <div className="font-bold text-slate-700 mb-4 flex items-center gap-2">
          <Icon name="activity" className="w-4 h-4 text-slate-400" />
          Reliability Maturity Profile
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={results.modules.map(m => ({ subject: m.moduleName, score: m.score, fullMark: 100 }))}>
              <PolarGrid stroke="#e2e8f0" />
              <PolarAngleAxis dataKey="subject" tick={{ fontSize: 11, fill: '#64748b', fontWeight: 600 }} />
              <Radar
                name="Score"
                dataKey="score"
                stroke="#2563eb"
                fill="#2563eb"
                fillOpacity={0.15}
                strokeWidth={2}
              />
              <Tooltip
                formatter={(v: number) => [`${v}/100`, 'Module Score']}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── AI flag summary ── */}
      {flagSummary && <AIFlagSummaryCard summary={flagSummary} onViewAll={() => setShowModules(true)} />}
      {!flagSummary && !aiConfig?.apiKey && aiConfig?.provider !== 'copilot' && (
        <div className="flex items-center gap-3 p-4 bg-slate-50 border border-slate-200 rounded text-sm text-slate-500 animate-enter">
          <Icon name="wand" className="w-5 h-5 text-slate-300" />
          <span>
            AI text analysis was not run (no API key). Configure AI in{' '}
            <button onClick={() => setScreen('settings')} className="font-bold text-brand-600 hover:underline">
              Settings
            </button>{' '}
            then re-run analysis to get per-record flags.
          </span>
        </div>
      )}

      {/* ── Top anomalies ── */}
      <TopAnomaliesCard results={results} onViewAll={() => setScreen('explorer')} />

      {/* ── DataContext strip ── */}
      <DataContextStrip results={results} />
    </div>
  );
}

// ─── Maturity card ────────────────────────────────────────────────────────────

function MaturityCard({ results }: { results: AnalysisResults }) {
  const { maturityScore: score, maturityGrade: grade } = results;
  const color =
    score >= 75 ? { text: 'text-green-600', bg: 'bg-green-50', border: 'border-green-200' } :
    score >= 55 ? { text: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200' } :
                  { text: 'text-red-600',   bg: 'bg-red-50',   border: 'border-red-200'   };

  return (
    <div className={`rounded shadow border p-6 flex flex-col items-center justify-center animate-enter ${color.bg} ${color.border}`}>
      <div className="text-[10px] font-bold uppercase text-slate-400 mb-2">Maturity Score</div>
      <div className={`text-6xl font-bold font-mono ${color.text}`}>{grade}</div>
      <div className={`text-xl font-bold mt-1 ${color.text}`}>{score}/100</div>
      <div className="text-xs text-slate-500 mt-2 text-center">
        {results.totalAnomalies} issue{results.totalAnomalies !== 1 ? 's' : ''} across {results.modules.length} modules
      </div>
      <div className="text-[10px] text-slate-400 mt-1 font-mono">
        {results.scopeWOCount.toLocaleString()} WOs analysed
      </div>
    </div>
  );
}

// ─── Module summary card ──────────────────────────────────────────────────────

function ModuleSummaryCard({ module: mod, onClick }: { module: ModuleResult; onClick: () => void }) {
  const STATUS: Record<ModuleStatus, { bg: string; text: string; icon: React.ComponentProps<typeof Icon>['name'] }> = {
    pass:        { bg: 'bg-green-100', text: 'text-green-700', icon: 'checkCircle' },
    warning:     { bg: 'bg-amber-100', text: 'text-amber-700', icon: 'alertTriangle' },
    critical:    { bg: 'bg-red-100',   text: 'text-red-700',   icon: 'alertCircle'  },
    insufficient:{ bg: 'bg-slate-100', text: 'text-slate-500', icon: 'info'         },
  };

  const s = STATUS[mod.status];

  return (
    <div
      onClick={onClick}
      className="bg-white rounded shadow border border-slate-200 p-5 cursor-pointer hover:shadow-md hover:border-brand-300 transition animate-enter"
    >
      <div className="flex items-start justify-between mb-3">
        <div className={`p-1.5 rounded ${s.bg}`}>
          <Icon name={s.icon} className={`w-4 h-4 ${s.text}`} />
        </div>
        <div className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${s.bg} ${s.text}`}>
          {mod.status}
        </div>
      </div>

      <div className="font-bold text-slate-800 text-sm">{mod.moduleName}</div>

      <div className="mt-3">
        <div className="text-[10px] font-bold uppercase text-slate-400">{mod.keyMetric.label}</div>
        <div className="text-xl font-bold font-mono text-slate-900 mt-0.5">{mod.keyMetric.value}</div>
        {mod.keyMetric.note && (
          <div className="text-[10px] text-amber-600 mt-0.5">{mod.keyMetric.note}</div>
        )}
      </div>

      <div className="mt-3">
        <div className="flex justify-between text-[10px] text-slate-400 mb-1">
          <span>Module Score</span>
          <span className="font-mono font-bold">{mod.score}/100</span>
        </div>
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${mod.score >= 75 ? 'bg-green-400' : mod.score >= 50 ? 'bg-amber-400' : 'bg-red-400'}`}
            style={{ width: `${mod.score}%` }}
          />
        </div>
      </div>

      {mod.anomalies.length > 0 && (
        <div className="mt-2 text-[10px] text-slate-400">
          {mod.anomalies.length} anomal{mod.anomalies.length === 1 ? 'y' : 'ies'} detected
        </div>
      )}
    </div>
  );
}

// ─── Top anomalies ────────────────────────────────────────────────────────────

function TopAnomaliesCard({ results, onViewAll }: { results: AnalysisResults; onViewAll: () => void }) {
  const allAnomalies = results.modules.flatMap(m => m.anomalies);
  const top = [...allAnomalies].sort((a, b) => b.score - a.score).slice(0, 6);

  if (top.length === 0) return null;

  return (
    <div className="bg-white rounded shadow border border-slate-200 overflow-hidden animate-enter">
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div className="font-bold text-slate-700 flex items-center gap-2 text-sm">
          <Icon name="alertTriangle" className="w-4 h-4 text-amber-400" />
          Top Issues
        </div>
        <button
          onClick={onViewAll}
          className="text-xs font-bold text-brand-600 hover:text-brand-700"
        >
          View all in Issue Explorer →
        </button>
      </div>
      <div className="divide-y divide-slate-100">
        {top.map(a => (
          <div key={a.id} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50">
            <SeverityDot severity={a.severity} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-800 truncate">{a.label}</div>
              <div className="text-xs text-slate-500 mt-0.5 line-clamp-1">{a.description.slice(0, 120)}…</div>
            </div>
            <div className="shrink-0 text-[10px] font-mono text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
              {a.affectedCount.toLocaleString()} WOs
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── DataContext strip ────────────────────────────────────────────────────────

function DataContextStrip({ results }: { results: AnalysisResults }) {
  const activeFilters = [
    results.filters.dateFrom || results.filters.dateTo ? 'date' : null,
    results.filters.equipment.length        > 0 ? `${results.filters.equipment.length} equipment` : null,
    results.filters.functionalLocation.length > 0 ? `${results.filters.functionalLocation.length} FL` : null,
    results.filters.orderType.length        > 0 ? `${results.filters.orderType.length} order types` : null,
    results.filters.systemStatus.length     > 0 ? `${results.filters.systemStatus.length} statuses` : null,
  ].filter(Boolean);

  return (
    <div className="bg-slate-800 text-white rounded px-4 py-2 flex flex-wrap gap-4 text-xs font-mono">
      <span><span className="text-slate-400">scope:</span> <span className="text-brand-400">v_analysis_scope</span></span>
      <span><span className="text-slate-400">WOs analysed:</span> <span className="text-white">{results.scopeWOCount.toLocaleString()}</span></span>
      <span><span className="text-slate-400">filters:</span> <span className={activeFilters.length > 0 ? 'text-amber-400' : 'text-slate-300'}>{activeFilters.length > 0 ? activeFilters.join(', ') : 'none'}</span></span>
      <span><span className="text-slate-400">sent to AI:</span> <span className="text-slate-300">no</span></span>
    </div>
  );
}

// ─── AI Flag Summary Card ─────────────────────────────────────────────────────

const FLAG_CATEGORY_META: Record<FlagCategory, { label: string; description: string; color: string; group: string }> = {
  symptom_code_conflict:     { label: 'Symptom → Code',              description: 'Symptom vs assigned codes',         color: 'text-red-600 bg-red-50 border-red-200',         group: 'CLASH'   },
  symptom_closure_conflict:  { label: 'Symptom → Closure',           description: 'Symptom vs confirmation text',       color: 'text-orange-600 bg-orange-50 border-orange-200', group: 'CLASH'   },
  code_closure_conflict:     { label: 'Code → Closure',              description: 'Codes vs confirmation narrative',    color: 'text-amber-600 bg-amber-50 border-amber-200',   group: 'CLASH'   },
  incomplete_classification: { label: 'Incomplete Classification',   description: 'Missing codes despite clear symptom', color: 'text-blue-600 bg-blue-50 border-blue-200',      group: 'QUALITY' },
  poor_closure:              { label: 'Poor Closure',                description: 'Vague / generic confirmation',       color: 'text-purple-600 bg-purple-50 border-purple-200', group: 'QUALITY' },
  generic_symptom:           { label: 'Generic Symptom',             description: 'WO description too vague to audit', color: 'text-slate-600 bg-slate-50 border-slate-200',   group: 'QUALITY' },
};

function AIFlagSummaryCard({ summary, onViewAll }: { summary: AIFlagSummary; onViewAll: () => void }) {
  const categories = Object.entries(summary.byCategory) as [FlagCategory, number][];
  const pct = summary.scopeWOCount > 0
    ? Math.round((summary.totalFlagged / summary.scopeWOCount) * 100)
    : 0;

  return (
    <div className="bg-white rounded shadow border border-slate-200 overflow-hidden animate-enter">
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div className="font-bold text-slate-700 flex items-center gap-2 text-sm">
          <Icon name="wand" className="w-4 h-4 text-brand-500" />
          AI Text Analysis Flags
        </div>
        <button
          onClick={onViewAll}
          className="text-xs font-bold text-brand-600 hover:text-brand-700"
        >
          View per-WO detail →
        </button>
      </div>

      {/* Summary strip */}
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-6 text-sm">
        <div>
          <span className="text-2xl font-bold font-mono text-slate-900">{summary.totalFlagged.toLocaleString()}</span>
          <span className="text-xs text-slate-500 ml-1.5">WOs flagged</span>
          <span className="text-xs text-slate-400 ml-1">({pct}% of scope)</span>
        </div>
        <div className="text-xs text-slate-400">
          {summary.totalFlags.toLocaleString()} total flags · analysed {summary.scopeWOCount.toLocaleString()} WOs
        </div>
      </div>

      {/* Clash checks row */}
      <div className="px-4 pt-3 pb-1">
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-2">Clash Checks</div>
        <div className="grid grid-cols-3 gap-3">
          {(['symptom_code_conflict', 'symptom_closure_conflict', 'code_closure_conflict'] as FlagCategory[]).map(cat => {
            const meta  = FLAG_CATEGORY_META[cat];
            const count = summary.byCategory[cat] ?? 0;
            return (
              <div key={cat} className="border border-slate-100 rounded p-3">
                <div className={`inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded border mb-1.5 ${meta.color}`}>
                  {meta.label}
                </div>
                <div className="text-2xl font-bold font-mono text-slate-900">{count.toLocaleString()}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">{meta.description}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quality checks row */}
      <div className="px-4 pt-2 pb-3">
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-2">Quality Checks</div>
        <div className="grid grid-cols-3 gap-3">
          {(['incomplete_classification', 'poor_closure', 'generic_symptom'] as FlagCategory[]).map(cat => {
            const meta  = FLAG_CATEGORY_META[cat];
            const count = summary.byCategory[cat] ?? 0;
            return (
              <div key={cat} className="border border-slate-100 rounded p-3">
                <div className={`inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded border mb-1.5 ${meta.color}`}>
                  {meta.label}
                </div>
                <div className="text-2xl font-bold font-mono text-slate-900">{count.toLocaleString()}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">{meta.description}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function SeverityDot({ severity }: { severity: string }) {
  const cls =
    severity === 'HIGH'   ? 'bg-red-500' :
    severity === 'MEDIUM' ? 'bg-amber-400' :
    severity === 'LOW'    ? 'bg-yellow-300' :
                            'bg-slate-300';
  return <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${cls}`} />;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
