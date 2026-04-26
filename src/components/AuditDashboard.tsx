import React, { useState, useEffect, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell,
  PieChart, Pie, Legend,
} from 'recharts';
import Icon from './Icon';
import FilterPanel from './FilterPanel';
import { useActiveRun, useActiveProject, useStore, useRunsForProject } from '../store/useStore';
import { runPipeline } from '../analysis/AnalysisEngine';
import { getFilterOptions, failureCatalogStats, queryAIFlags, query } from '../services/DuckDBService';
import { RULE_CHECK_LABELS } from '../analysis/RuleChecksModule';
import { FLAG_CATEGORY_LABELS } from '../analysis/AITextModule';
import type {
  AnalysisFilters, FilterOptions, FlagCategory, RuleCheckId,
  RuleCheckResult, AIFlagSummary,
} from '../types';
import { EMPTY_FILTERS } from '../types';

const RULE_COLOR = '#f59e0b';
const AI_COLOR = '#6366f1';
const PIE_COLORS = ['#22c55e', '#f59e0b', '#ef4444', '#94a3b8'];

export default function AuditDashboard() {
  const run = useActiveRun();
  const project = useActiveProject();
  const projectRuns = useRunsForProject(project?.id ?? null);
  const { setScreen, updateRun, aiConfig } = useStore();

  const [filters, setFilters] = useState<AnalysisFilters>(run?.analysisFilters ?? EMPTY_FILTERS);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [isRerunning, setIsRerunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topEquipment, setTopEquipment] = useState<Array<{ equipment: string; count: number }>>([]);
  const [perWorkCenter, setPerWorkCenter] = useState<
    Array<{ workCenter: string; total: number; flagged: number }>
  >([]);
  const [codeQuality, setCodeQuality] = useState<{
    valid: number;
    notListed: number;
    invalidHierarchy: number;
    missing: number;
  } | null>(null);
  const cancelRef = useRef({ current: false });
  const [aiProgress, setAIProgress] = useState({ done: 0, total: 0 });

  useEffect(() => {
    if (run?.analysisFilters) setFilters(run.analysisFilters);
  }, [run?.id]);

  useEffect(() => {
    if (!run?.hasDataInDB || !run.columnMap) return;
    getFilterOptions(run.columnMap).then(setFilterOptions).catch(() => {});
  }, [run?.hasDataInDB, run?.id]);

  useEffect(() => {
    if (!run?.hasDataInDB) return;
    void (async () => {
      try {
        const rows = await query(`
          SELECT equipment, COUNT(*) AS cnt
          FROM ai_flags
          WHERE equipment IS NOT NULL AND TRIM(equipment) <> ''
          GROUP BY equipment
          ORDER BY cnt DESC
          LIMIT 10
        `);
        setTopEquipment(rows.map((r) => ({ equipment: String(r.equipment ?? ''), count: Number(r.cnt ?? 0) })));
      } catch {
        setTopEquipment([]);
      }

      try {
        if (run.columnMap.work_center) {
          const rows = await query(`
            WITH base AS (
              SELECT work_center, work_order_number FROM v_analysis_scope
              WHERE work_center IS NOT NULL AND TRIM(work_center) <> ''
            ),
            flagged_wos AS (
              SELECT DISTINCT wo_number FROM ai_flags
            )
            SELECT base.work_center AS wc,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE base.work_order_number IN (SELECT wo_number FROM flagged_wos)) AS flagged
            FROM base
            GROUP BY base.work_center
            ORDER BY total DESC
            LIMIT 10
          `);
          setPerWorkCenter(rows.map((r) => ({
            workCenter: String(r.wc ?? ''),
            total: Number(r.total ?? 0),
            flagged: Number(r.flagged ?? 0),
          })));
        } else {
          setPerWorkCenter([]);
        }
      } catch {
        setPerWorkCenter([]);
      }

      try {
        const hasParts = !!run.columnMap.object_part_code_description;
        if (!hasParts) {
          setCodeQuality(null);
          return;
        }
        const [r] = await query(`
          WITH per AS (
            SELECT
              UPPER(TRIM(COALESCE(object_part_code_description,''))) AS p,
              UPPER(TRIM(COALESCE(damage_code_description,''))) AS d,
              UPPER(TRIM(COALESCE(cause_code_description,''))) AS c
            FROM v_analysis_scope
          )
          SELECT
            COUNT(*) FILTER (WHERE p <> '' AND d <> '' AND c <> '' AND p NOT LIKE 'NOT LISTED%' AND d NOT LIKE 'NOT LISTED%' AND c NOT LIKE 'NOT LISTED%') AS valid,
            COUNT(*) FILTER (WHERE p LIKE 'NOT LISTED%' OR d LIKE 'NOT LISTED%' OR c LIKE 'NOT LISTED%') AS not_listed,
            COUNT(*) FILTER (WHERE p = '' AND d = '' AND c = '') AS missing,
            COUNT(*) AS total
          FROM per
        `);
        const valid = Number(r?.valid ?? 0);
        const notListed = Number(r?.not_listed ?? 0);
        const missing = Number(r?.missing ?? 0);
        const total = Number(r?.total ?? 0);
        const invalidHierarchy = Math.max(0, total - valid - notListed - missing);
        setCodeQuality({ valid, notListed, invalidHierarchy, missing });
      } catch {
        setCodeQuality(null);
      }
    })();
  }, [run?.id, run?.hasDataInDB, run?.lastAnalysedAt]);

  if (!run) {
    return <div className="flex items-center justify-center h-full text-slate-400 text-sm">No active run.</div>;
  }
  if (!run.ruleChecks) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-400">
        <Icon name="barChart" className="w-12 h-12" />
        <div className="text-sm">Run pre-checks first to see audit results.</div>
        <button onClick={() => setScreen('profiler')} className="bg-slate-900 text-white px-4 py-2 rounded text-sm font-bold">
          Go to Data
        </button>
      </div>
    );
  }

  const rerun = async () => {
    setIsRerunning(true);
    setError(null);
    cancelRef.current = { current: false };
    try {
      const stats = await failureCatalogStats();
      const catalogAvailable = !!stats && stats.total > 0;
      const { results } = await runPipeline({
        runId: run.id,
        project,
        columnMap: run.columnMap,
        filters,
        aiConfig,
        catalogAvailable,
        onAIProgress: (done, total) => setAIProgress({ done, total }),
        cancelRef: cancelRef.current,
      });
      const flags = results.aiFlagSummary ? await queryAIFlags() : [];
      updateRun(run.id, {
        ruleChecks: results.ruleChecks,
        aiFlagSummary: results.aiFlagSummary ?? null,
        aiFlags: flags,
        analysisFilters: filters,
        stage: 'analysed',
        lastAnalysedAt: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRerunning(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Audit Results</h1>
          <p className="text-sm text-slate-500 mt-1">
            {project?.name ?? 'Project'} · Run #{run.runIndex} · {run.periodLabel} ·{' '}
            {run.ruleChecks.totalWOs.toLocaleString()} WOs in scope
          </p>
        </div>
        <div className="flex items-center gap-2">
          {projectRuns.length > 1 && (
            <button
              onClick={() => setScreen('comparison')}
              className="px-3 py-1.5 text-xs font-bold rounded border border-slate-200 bg-white text-slate-700 hover:border-brand-400 transition flex items-center gap-1.5"
            >
              <Icon name="activity" className="w-3.5 h-3.5" />
              Comparison Mode
            </button>
          )}
          <button
            onClick={() => setScreen('explorer')}
            className="px-3 py-1.5 text-xs font-bold rounded border border-slate-200 bg-white text-slate-700 hover:border-brand-400 transition flex items-center gap-1.5"
          >
            <Icon name="search" className="w-3.5 h-3.5" />
            Open Issues
          </button>
        </div>
      </div>

      <SummaryRow ruleChecks={run.ruleChecks} aiFlagSummary={run.aiFlagSummary} />

      <div className="grid lg:grid-cols-2 gap-6">
        <ChartCard title="Error Distribution" subtitle="Counts per category — both rule-based and AI-detected">
          <ErrorDistribution ruleChecks={run.ruleChecks} ai={run.aiFlagSummary} />
        </ChartCard>
        <ChartCard title="Code Quality Breakdown" subtitle="State of the Object/Damage/Cause description fields">
          <CodeQualityDonut data={codeQuality} />
        </ChartCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <ChartCard title="Per Work Center" subtitle="Total WOs vs flagged">
          {perWorkCenter.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={perWorkCenter}>
                <XAxis dataKey="workCenter" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="total" fill="#94a3b8" name="Total" />
                <Bar dataKey="flagged" fill={AI_COLOR} name="Flagged" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
        <ChartCard title="Top Problem Equipment" subtitle="Equipment with the most AI-detected flags">
          <TopEquipmentTable rows={topEquipment} />
        </ChartCard>
      </div>

      {filterOptions && (
        <FilterPanel
          filters={filters}
          options={filterOptions}
          columnMap={run.columnMap}
          totalWOs={run.dataProfile?.distinctWOs ?? 0}
          scopeWOs={run.ruleChecks.totalWOs}
          onChange={setFilters}
        />
      )}

      <div className="flex flex-wrap gap-3 items-center">
        <button
          onClick={rerun}
          disabled={isRerunning}
          className="bg-slate-900 text-white px-5 py-2 rounded text-sm font-bold flex items-center gap-2 hover:bg-slate-800 transition disabled:opacity-50"
        >
          {isRerunning ? <Icon name="loader" className="w-4 h-4 animate-spin" /> : <Icon name="refresh" className="w-4 h-4" />}
          Re-run with filters
        </button>
        {error && <div className="text-xs text-red-600">{error}</div>}
        {isRerunning && aiProgress.total > 0 && (
          <span className="text-xs text-slate-500 font-mono">
            AI {aiProgress.done}/{aiProgress.total}
          </span>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function SummaryRow({
  ruleChecks,
  aiFlagSummary,
}: {
  ruleChecks: RuleCheckResult;
  aiFlagSummary: AIFlagSummary | null;
}) {
  const ruleFlagged = new Set(ruleChecks.flaggedWOs.map((f) => f.wo)).size;
  const aiFlagged = aiFlagSummary?.totalFlagged ?? 0;
  const totalFlags = aiFlagSummary?.totalFlags ?? 0;
  const cleanCount = Math.max(0, ruleChecks.totalWOs - Math.max(ruleFlagged, aiFlagged));
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Stat label="Rule-Flagged WOs" value={ruleFlagged} accent="text-amber-600" />
      <Stat label="AI-Flagged WOs" value={aiFlagged} accent="text-indigo-600" />
      <Stat label="Total AI Flags" value={totalFlags} accent="text-violet-600" />
      <Stat label="Clean WOs" value={cleanCount} accent="text-green-600" />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded p-4 shadow-sm animate-enter">
      <div className="text-[10px] font-bold uppercase text-slate-400">{label}</div>
      <div className={`text-3xl font-bold mt-1 font-mono ${accent}`}>{value.toLocaleString()}</div>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded shadow-sm p-4 animate-enter">
      <div className="font-bold text-slate-700 text-sm">{title}</div>
      {subtitle && <div className="text-xs text-slate-400 mt-0.5">{subtitle}</div>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

function ErrorDistribution({
  ruleChecks,
  ai,
}: {
  ruleChecks: RuleCheckResult;
  ai: AIFlagSummary | null;
}) {
  const ruleData = (Object.keys(RULE_CHECK_LABELS) as RuleCheckId[])
    .map((id) => ({
      label: RULE_CHECK_LABELS[id].label,
      value: ruleChecks.perCheck[id]?.matched ?? 0,
      type: 'Rule' as const,
    }))
    .filter((d) => d.value > 0);

  const aiData = ai
    ? (Object.keys(FLAG_CATEGORY_LABELS) as FlagCategory[])
        .map((c) => ({
          label: FLAG_CATEGORY_LABELS[c],
          value: ai.byCategory[c] ?? 0,
          type: 'AI' as const,
        }))
        .filter((d) => d.value > 0)
    : [];

  const data = [...ruleData, ...aiData];
  if (data.length === 0) return <Empty />;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
        <XAxis type="number" tick={{ fontSize: 10 }} />
        <YAxis dataKey="label" type="category" tick={{ fontSize: 10 }} width={200} />
        <Tooltip />
        <Bar dataKey="value">
          {data.map((d, i) => (
            <Cell key={i} fill={d.type === 'Rule' ? RULE_COLOR : AI_COLOR} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function CodeQualityDonut({
  data,
}: {
  data: { valid: number; notListed: number; invalidHierarchy: number; missing: number } | null;
}) {
  if (!data) return <Empty />;
  const rows = [
    { name: 'Valid', value: data.valid },
    { name: 'Not Listed', value: data.notListed },
    { name: 'Invalid Hierarchy', value: data.invalidHierarchy },
    { name: 'Missing', value: data.missing },
  ].filter((r) => r.value > 0);
  if (rows.length === 0) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie data={rows} dataKey="value" nameKey="name" innerRadius={60} outerRadius={90} paddingAngle={2}>
          {rows.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function TopEquipmentTable({ rows }: { rows: Array<{ equipment: string; count: number }> }) {
  if (rows.length === 0) return <Empty />;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3 text-xs">
          <div className="font-mono text-slate-500 w-6 text-right">{i + 1}</div>
          <div className="flex-1 min-w-0">
            <div className="font-mono truncate text-slate-700">{r.equipment}</div>
            <div className="h-1 bg-slate-100 rounded-full overflow-hidden mt-1">
              <div
                className="h-full bg-indigo-500 rounded-full"
                style={{ width: `${(r.count / max) * 100}%` }}
              />
            </div>
          </div>
          <div className="font-mono font-bold text-slate-700 w-10 text-right">{r.count}</div>
        </div>
      ))}
    </div>
  );
}

function Empty() {
  return (
    <div className="text-xs text-slate-400 italic px-2 py-12 text-center">
      No data — run pre-checks and AI analysis to populate this chart.
    </div>
  );
}
