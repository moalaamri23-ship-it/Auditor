import React, { useState, useEffect, useRef } from 'react';
import Icon from './Icon';
import FilterPanel from './FilterPanel';
import { useActiveSession, useStore } from '../store/useStore';
import { runAllModules } from '../analysis/AnalysisEngine';
import { getFilterOptions, queryAIFlags } from '../services/DuckDBService';
import type { DataProfile, ColumnProfile, GranularityLevel, ValidationReport, AnalysisFilters, FilterOptions } from '../types';
import { EMPTY_FILTERS } from '../types';

export default function DataProfiler() {
  const session = useActiveSession();
  const { setScreen, updateSession, aiConfig } = useStore();
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [filters, setFilters]         = useState<AnalysisFilters>(session?.analysisFilters ?? EMPTY_FILTERS);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [aiPhase, setAIPhase]         = useState(false);
  const [aiProgress, setAIProgress]   = useState({ done: 0, total: 0 });
  const cancelRef = useRef({ current: false });

  // Load filter options once DuckDB data is ready
  useEffect(() => {
    if (!session?.hasDataInDuckDB || !session.columnMap) return;
    getFilterOptions(session.columnMap).then(setFilterOptions).catch(() => {});
  }, [session?.hasDataInDuckDB, session?.id]);

  const handleRunAnalysis = async () => {
    if (!session) return;
    setIsAnalysing(true);
    setAIPhase(false);
    setAIProgress({ done: 0, total: 0 });
    setAnalysisError(null);
    cancelRef.current = { current: false };

    const hasAI = !!aiConfig?.apiKey?.trim();

    try {
      const results = await runAllModules({
        sessionId:  session.id,
        columnMap:  session.columnMap,
        filters,
        aiConfig:   hasAI ? aiConfig : undefined,
        onAIProgress: (done, total) => {
          setAIPhase(true);
          setAIProgress({ done, total });
        },
        cancelRef: cancelRef.current,
      });

      // Store flags in session for persistence across page refreshes
      const sessionUpdates: Parameters<typeof updateSession>[1] = {
        analysisResults: results,
        analysisFilters: filters,
        maturityScore:   results.maturityScore,
        aiFlagSummary:   results.aiFlagSummary ?? null,
        stage:           'analysed',
        lastAnalysedAt:  new Date().toISOString(),
      };

      // Fetch flags from DuckDB and persist in localStorage
      if (results.aiFlagSummary) {
        const flags = await queryAIFlags();
        sessionUpdates.aiFlags = flags;
      }

      updateSession(session.id, sessionUpdates);
      setScreen('analysis');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAnalysisError(msg);
      console.error('[Analysis] runAllModules failed:', err);
    } finally {
      setIsAnalysing(false);
      setAIPhase(false);
    }
  };

  const handleCancel = () => {
    if (cancelRef.current) cancelRef.current.current = true;
  };

  if (!session) {
    return <EmptyState message="No active session." />;
  }
  if (!session.dataProfile) {
    return (
      <EmptyState
        message="No profile data found."
        action={{ label: 'Load & Profile', onClick: () => setScreen('schema-mapper') }}
      />
    );
  }

  const profile = session.dataProfile;
  const validation = session.validationReport;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">

      {/* ── Granularity banner ── */}
      <GranularityBanner level={profile.granularityLevel} rowsPerWO={profile.rowsPerWO} />

      {/* ── Stat cards row ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard label="Total Rows"    value={profile.totalRows.toLocaleString()}         icon="table"    />
        <StatCard label="Work Orders"   value={profile.distinctWOs.toLocaleString()}        icon="layers"   />
        <StatCard label="Equipment"     value={profile.distinctEquipment.toLocaleString()}  icon="cpu"      />
        <StatCard label="Rows / WO"     value={profile.rowsPerWO.toFixed(2)}               icon="activity" mono />
        <StatCard
          label="Date Range"
          value={profile.dateRange
            ? `${fmtDate(profile.dateRange.min)} – ${fmtDate(profile.dateRange.max)}`
            : 'N/A'}
          icon="calendar"
          small
        />
        <DataQualityCard score={profile.dataQualityScore} />
      </div>

      {/* ── DataContext strip ── */}
      <DataContextStrip profile={profile} />

      {/* ── Column health table ── */}
      <div className="bg-white rounded shadow border border-slate-200 overflow-hidden animate-enter">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="font-bold text-slate-700 flex items-center gap-2">
            <Icon name="table" className="w-4 h-4 text-slate-400" />
            Column Health
          </div>
          <div className="text-xs text-slate-400">{profile.columnProfiles.length} columns</div>
        </div>
        <div className="overflow-x-auto scroll-thin">
          <ColumnHealthTable columns={profile.columnProfiles} />
        </div>
      </div>

      {/* ── Validation accordion ── */}
      {validation && <ValidationAccordion report={validation} />}

      {/* ── Analysis error ── */}
      {analysisError && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded animate-enter">
          <Icon name="xCircle" className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold text-red-700 text-sm">Analysis failed</div>
            <div className="text-xs text-red-600 mt-0.5 font-mono">{analysisError}</div>
            <div className="text-xs text-red-500 mt-1">
              If DuckDB lost its data (page was refreshed), go back to Sessions and re-upload your file.
            </div>
          </div>
        </div>
      )}

      {/* ── Analysis scope filters ── */}
      {filterOptions && (
        <FilterPanel
          filters={filters}
          options={filterOptions}
          columnMap={session.columnMap}
          totalWOs={profile.distinctWOs}
          onChange={setFilters}
        />
      )}

      {/* ── Proceed to analysis ── */}
      <div className="space-y-3 pt-2">
        <div className="flex gap-3">
          <button
            onClick={() => setScreen('schema-mapper')}
            disabled={isAnalysing}
            className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded font-bold flex items-center gap-2 hover:bg-slate-50 transition text-sm disabled:opacity-40"
          >
            <Icon name="gear" className="w-4 h-4" />
            Re-map Columns
          </button>
          <button
            onClick={handleRunAnalysis}
            disabled={isAnalysing || !session?.hasDataInDuckDB}
            className="bg-gradient-to-r from-brand-600 to-indigo-600 text-white px-6 py-2 rounded font-bold flex items-center gap-2 text-sm shadow hover:shadow-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isAnalysing && !aiPhase ? (
              <>
                <Icon name="loader" className="w-4 h-4 animate-spin" />
                Running Analysis…
              </>
            ) : isAnalysing && aiPhase ? (
              <>
                <Icon name="loader" className="w-4 h-4 animate-spin" />
                AI Analysing…
              </>
            ) : (
              <>
                <Icon name="bolt" className="w-4 h-4" />
                Run Analysis
                {aiConfig?.apiKey && <span className="text-[10px] font-mono opacity-70 ml-1">+ AI</span>}
              </>
            )}
          </button>
          {isAnalysing && aiPhase && (
            <button
              onClick={handleCancel}
              className="bg-white border border-slate-200 text-slate-600 px-3 py-2 rounded font-bold text-sm hover:bg-red-50 hover:border-red-200 hover:text-red-600 transition"
            >
              Cancel AI
            </button>
          )}
        </div>

        {/* AI progress bar */}
        {isAnalysing && aiPhase && aiProgress.total > 0 && (
          <div className="bg-white border border-slate-200 rounded p-3 animate-enter">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
                <Icon name="wand" className="w-3.5 h-3.5 text-brand-500" />
                AI Text Analysis
              </div>
              <div className="text-xs font-mono text-slate-400">
                {aiProgress.done.toLocaleString()} / {aiProgress.total.toLocaleString()} WOs
              </div>
            </div>
            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-brand-500 to-indigo-500 rounded-full transition-all duration-300"
                style={{ width: `${Math.round((aiProgress.done / aiProgress.total) * 100)}%` }}
              />
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
              Analysing alignment between descriptions, reliability codes, and confirmation texts…
            </div>
          </div>
        )}

        {!aiConfig?.apiKey && (
          <div className="text-xs text-amber-600 flex items-center gap-1.5">
            <Icon name="alertTriangle" className="w-3.5 h-3.5" />
            No AI key configured — analysis will run DuckDB modules only.
            <button onClick={() => setScreen('settings')} className="font-bold underline">Configure in Settings →</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Granularity banner ────────────────────────────────────────────────────────

function GranularityBanner({ level, rowsPerWO }: { level: GranularityLevel; rowsPerWO: number }) {
  if (level === 'WO_LEVEL') return null;

  const isHeavy = level === 'CONFIRMATION_LEVEL';

  return (
    <div className={`flex gap-3 p-4 rounded-lg border animate-enter ${
      isHeavy
        ? 'bg-red-50 border-red-200'
        : 'bg-amber-50 border-amber-200'
    }`}>
      <Icon
        name="alertTriangle"
        className={`w-5 h-5 shrink-0 mt-0.5 ${isHeavy ? 'text-red-500' : 'text-amber-500'}`}
      />
      <div>
        <div className={`font-bold text-sm ${isHeavy ? 'text-red-700' : 'text-amber-700'}`}>
          {isHeavy ? 'Heavy confirmation expansion detected' : 'Confirmation-level data detected'}
        </div>
        <div className="text-sm mt-0.5 text-slate-600">
          Average <span className="font-mono font-bold">{rowsPerWO.toFixed(2)}</span> rows per Work Order.
          {' '}This dataset is {level === 'MIXED' ? 'partially' : 'heavily'} denormalized —
          {' '}all aggregations use <span className="font-mono">v_wo_primary</span> (one row per WO) to prevent inflated metrics.
          {' '}Never count raw rows as work orders.
        </div>
      </div>
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label, value, icon, mono = false, small = false,
}: {
  label: string;
  value: string;
  icon: React.ComponentProps<typeof Icon>['name'];
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div className="bg-white rounded shadow border border-slate-200 p-4 animate-enter">
      <div className="flex items-center gap-2 mb-2">
        <Icon name={icon} className="w-4 h-4 text-slate-400" />
        <div className="text-[10px] font-bold uppercase text-slate-400">{label}</div>
      </div>
      <div className={`font-bold text-slate-900 ${mono ? 'font-mono' : ''} ${small ? 'text-sm' : 'text-xl'}`}>
        {value}
      </div>
    </div>
  );
}

// ─── Data quality score card ──────────────────────────────────────────────────

function DataQualityCard({ score }: { score: number }) {
  const color =
    score >= 75 ? { ring: 'text-green-500', bg: 'bg-green-50', text: 'text-green-700' } :
    score >= 50 ? { ring: 'text-amber-500', bg: 'bg-amber-50', text: 'text-amber-700' } :
                  { ring: 'text-red-500',   bg: 'bg-red-50',   text: 'text-red-700'   };

  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';

  return (
    <div className={`rounded shadow border border-slate-200 p-4 animate-enter ${color.bg}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon name="shield" className={`w-4 h-4 ${color.ring}`} />
        <div className="text-[10px] font-bold uppercase text-slate-400">Data Quality</div>
      </div>
      <div className="flex items-end gap-2">
        <div className={`text-3xl font-bold font-mono ${color.text}`}>{grade}</div>
        <div className={`text-sm font-bold pb-0.5 ${color.text}`}>{score}/100</div>
      </div>
    </div>
  );
}

// ─── DataContext strip ────────────────────────────────────────────────────────

function DataContextStrip({ profile }: { profile: DataProfile }) {
  return (
    <div className="bg-slate-800 text-white rounded px-4 py-2 flex flex-wrap gap-4 text-xs font-mono">
      <span>
        <span className="text-slate-400">view:</span>{' '}
        <span className="text-brand-400">v_wo_primary</span>
      </span>
      <span>
        <span className="text-slate-400">rows in scope:</span>{' '}
        <span className="text-white">{profile.distinctWOs.toLocaleString()} WOs</span>
      </span>
      <span>
        <span className="text-slate-400">granularity:</span>{' '}
        <span className={
          profile.granularityLevel === 'WO_LEVEL' ? 'text-green-400' :
          profile.granularityLevel === 'MIXED'    ? 'text-amber-400' :
                                                    'text-red-400'
        }>
          {profile.granularityLevel}
        </span>
      </span>
      <span>
        <span className="text-slate-400">sent to AI:</span>{' '}
        <span className="text-slate-300">no</span>
      </span>
    </div>
  );
}

// ─── Column health table ──────────────────────────────────────────────────────

function ColumnHealthTable({ columns }: { columns: ColumnProfile[] }) {
  return (
    <table className="w-full merged-table">
      <thead>
        <tr>
          <th className="text-left">Column Name</th>
          <th className="text-left">Mapped To</th>
          <th className="text-left">Type</th>
          <th className="text-left" style={{ width: 120 }}>Null %</th>
          <th className="text-left">Distinct</th>
          <th className="text-left">Sample Values</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((col) => (
          <ColumnRow key={col.rawName} col={col} />
        ))}
      </tbody>
    </table>
  );
}

function ColumnRow({ col }: { col: ColumnProfile }) {
  const TYPE_BADGE: Record<string, string> = {
    date:    'bg-purple-100 text-purple-700',
    id:      'bg-blue-100 text-blue-700',
    text:    'bg-teal-100 text-teal-700',
    number:  'bg-orange-100 text-orange-700',
    unknown: 'bg-slate-100 text-slate-500',
  };

  const CONF_BADGE: Record<string, string> = {
    HIGH:    'bg-green-100 text-green-700',
    MEDIUM:  'bg-amber-100 text-amber-700',
    LOW:     'bg-red-100 text-red-700',
    UNMAPPED:'bg-slate-100 text-slate-500',
  };

  const nullColor =
    col.nullPct > 50 ? 'bg-red-400' :
    col.nullPct > 20 ? 'bg-amber-400' :
    col.nullPct > 5  ? 'bg-yellow-300' :
                       'bg-green-400';

  return (
    <tr className="group hover:bg-slate-50">
      <td>
        <div className="font-mono text-xs font-bold text-slate-800">{col.rawName}</div>
      </td>
      <td>
        {col.canonicalName ? (
          <div>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${CONF_BADGE[col.mappingConfidence]}`}>
              {col.mappingConfidence}
            </span>
            <div className="font-mono text-[10px] text-slate-500 mt-0.5">{col.canonicalName}</div>
          </div>
        ) : (
          <span className="text-[10px] text-slate-400">Unmapped</span>
        )}
      </td>
      <td>
        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${TYPE_BADGE[col.detectedType]}`}>
          {col.detectedType}
        </span>
      </td>
      <td>
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${nullColor}`}
              style={{ width: `${col.nullPct}%` }}
            />
          </div>
          <span className="text-xs font-mono text-slate-600">{col.nullPct}%</span>
        </div>
      </td>
      <td>
        <span className="text-xs font-mono text-slate-600">{col.distinctCount.toLocaleString()}</span>
      </td>
      <td>
        <div className="flex flex-wrap gap-1">
          {col.sampleValues.slice(0, 3).map((v, i) => (
            <span key={i} className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-mono truncate max-w-[120px]">
              {v}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

// ─── Validation accordion ─────────────────────────────────────────────────────

function ValidationAccordion({ report }: { report: ValidationReport }) {
  const [open, setOpen] = useState(report.errors.length > 0);

  const total = report.errors.length + report.warnings.length;
  if (total === 0) return null;

  return (
    <div className="bg-white rounded shadow border border-slate-200 overflow-hidden animate-enter">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200 hover:bg-slate-100 transition"
      >
        <div className="flex items-center gap-2 font-bold text-slate-700 text-sm">
          <Icon name="alertTriangle" className="w-4 h-4 text-amber-400" />
          Validation Issues
          {report.errors.length > 0 && (
            <span className="bg-red-100 text-red-700 text-[10px] font-bold px-1.5 py-0.5 rounded">
              {report.errors.length} errors
            </span>
          )}
          {report.warnings.length > 0 && (
            <span className="bg-amber-100 text-amber-700 text-[10px] font-bold px-1.5 py-0.5 rounded">
              {report.warnings.length} warnings
            </span>
          )}
        </div>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} className="w-4 h-4 text-slate-400" />
      </button>

      {open && (
        <div className="p-4 space-y-2 animate-enter">
          {[...report.errors, ...report.warnings, ...report.infos].map((issue, i) => (
            <div key={i} className="flex gap-3 text-sm">
              <Icon
                name={
                  issue.level === 'ERROR'   ? 'xCircle' :
                  issue.level === 'WARNING' ? 'alertTriangle' :
                                              'info'
                }
                className={`w-4 h-4 shrink-0 mt-0.5 ${
                  issue.level === 'ERROR'   ? 'text-red-500' :
                  issue.level === 'WARNING' ? 'text-amber-500' :
                                              'text-blue-400'
                }`}
              />
              <span className="text-slate-700">{issue.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function EmptyState({ message, action }: { message: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-400">
      <Icon name="database" className="w-12 h-12" />
      <div className="text-sm">{message}</div>
      {action && (
        <button
          onClick={action.onClick}
          className="bg-slate-900 text-white px-4 py-2 rounded text-sm font-bold"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
