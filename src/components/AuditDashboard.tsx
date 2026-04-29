import React, { useState, useEffect, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell,
  PieChart, Pie, Legend,
} from 'recharts';
import Icon from './Icon';
import FilterPanel from './FilterPanel';
import { useActiveRun, useActiveProject, useStore, useRunsForProject } from '../store/useStore';
import { runPipeline } from '../analysis/AnalysisEngine';
import { getFilterOptions, getCascadingFilterOptions, getLiveScopeCount, createAnalysisScopeView, failureCatalogStats, queryAIFlags, query } from '../services/DuckDBService';
import { RULE_CHECK_LABELS } from '../analysis/RuleChecksModule';
import { FLAG_CATEGORY_LABELS } from '../analysis/AITextModule';
import type {
  AnalysisFilters, FilterOptions, FlagCategory, RuleCheckId,
  RuleCheckResult, AIFlagSummary, AIFlag, ChartCache, ColumnMap,
} from '../types';
import { EMPTY_FILTERS } from '../types';
import { useRunAutoRestore } from '../hooks/useRunAutoRestore';

const RULE_COLOR = '#f59e0b';
const AI_COLOR = '#6366f1';

const CQ_COLORS: Record<string, string> = {
  'Valid':             '#22c55e',
  'Not Listed':        '#f59e0b',
  'Invalid Hierarchy': '#ef4444',
  'Missing Codes':     '#94a3b8',
};
const OQ_COLORS: Record<string, string> = {
  'Clean WOs':           '#22c55e',
  'Review Quality (AI)': '#6366f1',
  'Missing Fields':      '#f59e0b',
};

// ─── Visual cross-filter types ───────────────────────────────────────────────

type VisualSelectionType = 'workCenter' | 'equipment' | 'flagCategory' | 'codeQualitySegment' | 'overallQualitySegment';
type VisualSelection = { type: VisualSelectionType; value: string } | null;

function buildVisualScopeWhere(
  sel: VisualSelection,
  ruleChecks: RuleCheckResult | null,
): string | null {
  if (!sel) return null;
  const esc = (s: string) => s.replace(/'/g, "''");
  switch (sel.type) {
    case 'workCenter':
      return `work_center = '${esc(sel.value)}'`;
    case 'equipment':
      return `(equipment_description = '${esc(sel.value)}' OR equipment = '${esc(sel.value)}')`;
    case 'flagCategory': {
      const isAI = Object.keys(FLAG_CATEGORY_LABELS).includes(sel.value);
      if (isAI) {
        return `work_order_number IN (SELECT wo_number FROM ai_flags WHERE category = '${esc(sel.value)}')`;
      }
      if (!ruleChecks) return 'FALSE';
      const wos = ruleChecks.flaggedWOs
        .filter((f) => f.checks.includes(sel.value as RuleCheckId))
        .map((f) => `'${esc(f.wo)}'`);
      if (wos.length === 0) return 'FALSE';
      return `work_order_number IN (${wos.join(',')})`;
    }
    case 'codeQualitySegment': {
      const p = `UPPER(TRIM(COALESCE(object_part_code_description,'')))`;
      const d = `UPPER(TRIM(COALESCE(damage_code_description,'')))`;
      const c = `UPPER(TRIM(COALESCE(cause_code_description,'')))`;
      switch (sel.value) {
        case 'Valid':
          return `${p}<>'' AND ${d}<>'' AND ${c}<>'' AND ${p} NOT LIKE 'NOT LISTED%' AND ${d} NOT LIKE 'NOT LISTED%' AND ${c} NOT LIKE 'NOT LISTED%'`;
        case 'Not Listed':
          return `(${p} LIKE 'NOT LISTED%' OR ${d} LIKE 'NOT LISTED%' OR ${c} LIKE 'NOT LISTED%')`;
        case 'Missing Codes':
          return `${p}='' AND ${d}='' AND ${c}=''`;
        case 'Invalid Hierarchy':
          return `work_order_number IN (SELECT wo_number FROM ai_flags WHERE category = 'desc_code_conflict')`;
        default:
          return null;
      }
    }
    case 'overallQualitySegment':
      // WHERE clause is computed inline from in-memory flag lists; not via this helper
      return null;
  }
}

// Opacity for a chart item — full if it's the selected item or no selection, dimmed otherwise
function itemOpacity(sel: VisualSelection, type: VisualSelectionType, value: string): number {
  if (!sel || sel.type !== type) return 1;
  return sel.value === value ? 1 : 0.25;
}

// ─── Chart cache computation (run after analysis while DB is still populated) ─

async function _computeChartCache(
  columnMap: ColumnMap,
  ruleChecks: RuleCheckResult,
  aiFlags: AIFlag[],
): Promise<ChartCache> {
  const esc = (s: string) => s.replace(/'/g, "''");
  const ruleFlaggedWOs = ruleChecks.flaggedWOs.map((f) => f.wo);
  const ruleWOsSQL = ruleFlaggedWOs.length > 0
    ? ruleFlaggedWOs.map((w) => `'${esc(w)}'`).join(',')
    : null;

  const equipmentSQL = ruleWOsSQL
    ? `SELECT equipment, COUNT(DISTINCT wo_number) AS cnt
       FROM (
         SELECT wo_number, equipment FROM ai_flags
         WHERE equipment IS NOT NULL AND TRIM(equipment) <> ''
         UNION
         SELECT s.work_order_number AS wo_number, s.equipment_description AS equipment
         FROM v_analysis_scope s
         WHERE s.work_order_number IN (${ruleWOsSQL})
           AND s.equipment_description IS NOT NULL AND TRIM(s.equipment_description) <> ''
       ) combined
       GROUP BY equipment ORDER BY cnt DESC LIMIT 10`
    : `SELECT equipment, COUNT(DISTINCT wo_number) AS cnt
       FROM ai_flags
       WHERE equipment IS NOT NULL AND TRIM(equipment) <> ''
       GROUP BY equipment ORDER BY cnt DESC LIMIT 10`;

  const cacheFlaggedWosCTE = ruleWOsSQL
    ? `flagged_wos AS (
        SELECT wo_number FROM ai_flags
        UNION
        SELECT work_order_number AS wo_number FROM v_analysis_scope WHERE work_order_number IN (${ruleWOsSQL})
      )`
    : `flagged_wos AS (SELECT DISTINCT wo_number FROM ai_flags)`;

  let perWorkCenter: ChartCache['perWorkCenter'] = [];
  if (columnMap?.work_center) {
    try {
      const rows = await query(`
        WITH base AS (
          SELECT work_center, work_order_number FROM v_analysis_scope
          WHERE work_center IS NOT NULL AND TRIM(work_center) <> ''
        ),
        ${cacheFlaggedWosCTE}
        SELECT base.work_center AS wc,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE base.work_order_number IN (SELECT wo_number FROM flagged_wos)) AS flagged
        FROM base
        GROUP BY base.work_center
        ORDER BY total DESC
        LIMIT 10
      `);
      perWorkCenter = rows.map((r) => ({
        workCenter: String(r.wc ?? ''),
        total: Number(r.total ?? 0),
        flagged: Number(r.flagged ?? 0),
      }));
    } catch { perWorkCenter = []; }
  }

  let topEquipment: ChartCache['topEquipment'] = [];
  try {
    const rows = await query(equipmentSQL);
    topEquipment = rows.map((r) => ({ equipment: String(r.equipment ?? ''), count: Number(r.cnt ?? 0) }));
  } catch { topEquipment = []; }

  let codeQuality: ChartCache['codeQuality'] = null;
  let missingCodeWOs: string[] = [];
  if (columnMap?.object_part_code_description) {
    try {
      // Per-row CTE returns each WO with the two boolean classifications, so we
      // can extract both the aggregate counts AND the explicit WO list for
      // missing-codes — used by buildDashboardPayload to keep dashboard.html in
      // agreement with the live donut even if the rule check ever underreports.
      const rows = await query(`
        WITH per AS (
          SELECT
            CAST(work_order_number AS VARCHAR) AS wo,
            UPPER(TRIM(COALESCE(object_part_code_description,''))) AS p,
            UPPER(TRIM(COALESCE(damage_code_description,''))) AS d,
            UPPER(TRIM(COALESCE(cause_code_description,''))) AS c
          FROM v_analysis_scope
        )
        SELECT
          wo,
          (p LIKE 'NOT LISTED%' OR d LIKE 'NOT LISTED%' OR c LIKE 'NOT LISTED%') AS is_not_listed,
          (p = '' AND d = '' AND c = '') AS is_missing
        FROM per
      `);
      let notListed = 0;
      let missing = 0;
      const total = rows.length;
      for (const r of rows) {
        if (r.is_not_listed) notListed++;
        if (r.is_missing) {
          missing++;
          const wo = String(r.wo ?? '');
          if (wo) missingCodeWOs.push(wo);
        }
      }
      const invalidHierarchy = new Set(aiFlags.filter(f => f.category === 'desc_code_conflict').map(f => f.woNumber)).size;
      const valid = Math.max(0, total - notListed - missing - invalidHierarchy);
      codeQuality = { valid, notListed, missing, invalidHierarchy };
    } catch { codeQuality = null; missingCodeWOs = []; }
  }

  const aiWoSet = new Set(aiFlags.map((f) => f.woNumber));
  const ruleWoSet = new Set(ruleChecks.flaggedWOs.map((f) => f.wo));
  const totalWOs = ruleChecks.totalWOs;
  const entryQuality = aiWoSet.size;
  const missingFields = [...ruleWoSet].filter((wo) => !aiWoSet.has(wo)).length;
  const overallQuality: ChartCache['overallQuality'] = {
    valid: Math.max(0, totalWOs - entryQuality - missingFields),
    entryQuality,
    missingFields,
    total: totalWOs,
  };

  return { perWorkCenter, topEquipment, codeQuality, overallQuality, missingCodeWOs, computedAt: new Date().toISOString() };
}

// ─── Overall Quality ring chart ──────────────────────────────────────────────

function OverallQualityRing({
  data,
  visualSelection,
  onSelect,
}: {
  data: { valid: number; entryQuality: number; missingFields: number; total: number } | null;
  visualSelection: VisualSelection;
  onSelect: (name: string) => void;
}) {
  if (!data || data.total === 0) return <Empty />;
  const rows = [
    { name: 'Clean WOs',           value: data.valid },
    { name: 'Review Quality (AI)', value: data.entryQuality },
    { name: 'Missing Fields',      value: data.missingFields },
  ].filter((r) => r.value > 0);
  if (rows.length === 0) return <Empty />;
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart style={{ cursor: 'pointer' }}>
        <Pie
          data={rows}
          dataKey="value"
          nameKey="name"
          innerRadius={60}
          outerRadius={90}
          paddingAngle={2}
          onClick={(entry) => onSelect(entry.name)}
        >
          {rows.map((r) => (
            <Cell
              key={r.name}
              fill={OQ_COLORS[r.name] ?? '#94a3b8'}
              fillOpacity={itemOpacity(visualSelection, 'overallQualitySegment', r.name)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </Pie>
        <Legend
          content={({ payload }) => (
            <div className="flex flex-col gap-1 mt-2">
              {(payload ?? []).map((p: any) => {
                const pct = total > 0 ? ((p.payload.value / total) * 100).toFixed(1) : '0.0';
                return (
                  <div key={p.value} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: p.color }} />
                      <span className="text-slate-600">{p.value}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400 text-[10px]">{pct}%</span>
                      <span className="font-bold text-slate-700 font-mono w-8 text-right">{p.payload.value.toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function AuditDashboard() {
  const run = useActiveRun();
  const project = useActiveProject();
  const projectRuns = useRunsForProject(project?.id ?? null);
  const { setScreen, updateRun, aiConfig } = useStore();
  useRunAutoRestore(run ?? null);

  const [filters, setFilters] = useState<AnalysisFilters>(run?.analysisFilters ?? EMPTY_FILTERS);
  const [baseFilterOptions, setBaseFilterOptions] = useState<FilterOptions | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [liveScopeCount, setLiveScopeCount] = useState<number | null>(null);
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
  const [overallQuality, setOverallQuality] = useState<{
    valid: number; entryQuality: number; missingFields: number; total: number;
  } | null>(null);
  const [filteredErrorDist, setFilteredErrorDist] = useState<{
    perCheck: Partial<Record<RuleCheckId, number>>;
    byCategory: Partial<Record<FlagCategory, number>>;
  } | null>(null);

  // Live scope stats — computed from filtered in-memory flags when filters change without re-run
  const [liveStats, setLiveStats] = useState<{
    totalWOs: number;
    ruleFlagged: number;
    aiFlagged: number;
    totalAIFlags: number;
    cleanWOs: number;
    filteredAIFlags: AIFlag[];
    filteredRuleWOs: Array<{ wo: string; checks: RuleCheckId[] }>;
    filteredPerCheck: Partial<Record<RuleCheckId, number>>;
    filteredByCategory: Partial<Record<FlagCategory, number>>;
  } | null>(null);
  // Visual-selection-filtered stats for stat cards (set when a work center bar is clicked)
  const [visualStats, setVisualStats] = useState<{
    totalWOs: number;
    aiFlagged: number;
    totalAIFlags: number;
    cleanWOs: number;
    filteredAIFlags: AIFlag[];
    filteredRuleWOs: Array<{ wo: string; checks: RuleCheckId[] }>;
    filteredByCategory: Partial<Record<FlagCategory, number>>;
  } | null>(null);
  // Incrementing this triggers chart re-queries after the scope view is rebuilt
  const [scopeVersion, setScopeVersion] = useState(0);

  // Visual cross-filter state
  const [visualSelection, setVisualSelection] = useState<VisualSelection>(null);

  const cancelRef = useRef({ current: false });
  const [aiProgress, setAIProgress] = useState({ done: 0, total: 0 });

  useEffect(() => {
    if (run?.analysisFilters) setFilters(run.analysisFilters);
  }, [run?.id]);

  // Reset live stats, scope version, and visual selection when run changes or analysis reruns
  useEffect(() => {
    setLiveStats(null);
    setVisualStats(null);
    setScopeVersion(0);
    setVisualSelection(null);
  }, [run?.id, run?.lastAnalysedAt]);

  // Load base (unfiltered) options once when data is in DB
  useEffect(() => {
    if (!run?.hasDataInDB || !run.columnMap) return;
    getFilterOptions(run.columnMap).then((opts) => {
      setBaseFilterOptions(opts);
      setFilterOptions(opts);
    }).catch(() => {});
  }, [run?.hasDataInDB, run?.id]);

  // Debounced: rebuild scope view, update live stats + cascading options whenever filters change
  useEffect(() => {
    if (!run?.hasDataInDB || !run.columnMap || !baseFilterOptions) return;
    const t = setTimeout(async () => {
      try {
        const [count, cascaded] = await Promise.all([
          createAnalysisScopeView(filters, run.columnMap!, project),
          getCascadingFilterOptions(filters, run.columnMap!, project, baseFilterOptions),
        ]);
        setLiveScopeCount(count);
        setFilterOptions(cascaded);

        // Query scope WO set to filter in-memory flags
        const woRows = await query('SELECT work_order_number FROM v_analysis_scope');
        const scopeWoSet = new Set(woRows.map((r) => String(r.work_order_number ?? '')));

        const filteredAIFlags = (run.aiFlags ?? []).filter((f) => scopeWoSet.has(f.woNumber));
        const filteredRuleWOs = (run.ruleChecks?.flaggedWOs ?? []).filter((fw) => scopeWoSet.has(fw.wo));

        const aiSet = new Set(filteredAIFlags.map((f) => f.woNumber));
        const ruleSet = new Set(filteredRuleWOs.map((f) => f.wo));
        const allFlagged = new Set([...aiSet, ...ruleSet]);

        const filteredPerCheck: Partial<Record<RuleCheckId, number>> = {};
        for (const fw of filteredRuleWOs) {
          for (const checkId of fw.checks) {
            filteredPerCheck[checkId] = (filteredPerCheck[checkId] ?? 0) + 1;
          }
        }
        const filteredByCategory: Partial<Record<FlagCategory, number>> = {};
        for (const f of filteredAIFlags) {
          filteredByCategory[f.category] = (filteredByCategory[f.category] ?? 0) + 1;
        }

        setLiveStats({
          totalWOs: count,
          ruleFlagged: ruleSet.size,
          aiFlagged: aiSet.size,
          totalAIFlags: filteredAIFlags.length,
          cleanWOs: Math.max(0, count - allFlagged.size),
          filteredAIFlags,
          filteredRuleWOs,
          filteredPerCheck,
          filteredByCategory,
        });
        // Clear visual selection since the scope changed
        setVisualSelection(null);
        // Trigger chart re-queries (charts read from v_analysis_scope which is now rebuilt)
        setScopeVersion((v) => v + 1);
      } catch {
        // On error fall back to live count only
        const count = await getLiveScopeCount(filters, run.columnMap!, project).catch(() => null);
        if (count !== null) setLiveScopeCount(count);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [filters, run?.hasDataInDB, run?.id, baseFilterOptions, project]);

  // ── Chart data loading (re-runs on visual selection change) ─────────────────
  useEffect(() => {
    if (!run?.hasDataInDB) {
      // Cold load — restore from persisted cache
      const cache = run?.chartCache;
      if (cache) {
        setPerWorkCenter(cache.perWorkCenter);
        setTopEquipment(cache.topEquipment);
        setCodeQuality(cache.codeQuality);
        setOverallQuality(cache.overallQuality);
      }
      return;
    }
    void (async () => {
      const ruleChecks = run.ruleChecks ?? null;
      const esc = (s: string) => s.replace(/'/g, "''");
      const isEqSource = visualSelection?.type === 'equipment';
      const isWCSource = visualSelection?.type === 'workCenter';
      const isCQSource = visualSelection?.type === 'codeQualitySegment';
      const isOQSource = visualSelection?.type === 'overallQualitySegment';

      // Compute visualWhere — handle overallQualitySegment inline (not via buildVisualScopeWhere)
      let visualWhere: string | null = null;
      if (visualSelection?.type === 'overallQualitySegment') {
        const aiWOs = (run.aiFlags ?? []).map((f) => f.woNumber);
        const ruleChecksLocal = run.ruleChecks;
        const ruleWOs = ruleChecksLocal?.flaggedWOs.map((f) => f.wo) ?? [];
        if (visualSelection.value === 'Review Quality (AI)') {
          const list = aiWOs.map((w) => `'${esc(w)}'`).join(',');
          visualWhere = list ? `work_order_number IN (${list})` : 'FALSE';
        } else if (visualSelection.value === 'Missing Fields') {
          const aiSet = new Set(aiWOs);
          const ruleOnly = ruleWOs.filter((w) => !aiSet.has(w));
          const list = ruleOnly.map((w) => `'${esc(w)}'`).join(',');
          visualWhere = list ? `work_order_number IN (${list})` : 'FALSE';
        } else if (visualSelection.value === 'Clean WOs') {
          const allFlagged = [...new Set([...aiWOs, ...ruleWOs])];
          const list = allFlagged.map((w) => `'${esc(w)}'`).join(',');
          visualWhere = list ? `work_order_number NOT IN (${list})` : null;
        }
      } else {
        visualWhere = buildVisualScopeWhere(visualSelection, ruleChecks);
      }

      // Precompute rule-flagged WO list for combined equipment SQL — use live-filtered list when available
      const ruleFlaggedWOs = (liveStats?.filteredRuleWOs ?? ruleChecks?.flaggedWOs ?? []).map((f) => f.wo);
      const ruleWOsSQL = ruleFlaggedWOs.length > 0
        ? ruleFlaggedWOs.map((w) => `'${esc(w)}'`).join(',')
        : null;

      const buildEquipmentSQL = (extraWhere: string | null) => {
        const aiWhere = extraWhere
          ? `wo_number IN (SELECT work_order_number FROM v_analysis_scope WHERE ${extraWhere})`
          : null;
        const ruleWhere = extraWhere
          ? `s.work_order_number IN (SELECT work_order_number FROM v_analysis_scope WHERE ${extraWhere})`
          : null;
        const aiFilter = aiWhere ? `AND ${aiWhere}` : '';
        const ruleBase = ruleWOsSQL
          ? `UNION
             SELECT s.work_order_number AS wo_number, s.equipment_description AS equipment
             FROM v_analysis_scope s
             WHERE s.work_order_number IN (${ruleWOsSQL})
               AND s.equipment_description IS NOT NULL AND TRIM(s.equipment_description) <> ''
               ${ruleWhere ? `AND ${ruleWhere}` : ''}`
          : '';
        return `
          SELECT equipment, COUNT(DISTINCT wo_number) AS cnt
          FROM (
            SELECT wo_number, equipment FROM ai_flags
            WHERE equipment IS NOT NULL AND TRIM(equipment) <> ''
            ${aiFilter}
            ${ruleBase}
          ) combined
          GROUP BY equipment ORDER BY cnt DESC LIMIT 10
        `;
      };

      // Top Equipment — re-query unless equipment is the source
      try {
        const sql = isEqSource ? buildEquipmentSQL(null) : buildEquipmentSQL(visualWhere);
        const rows = await query(sql);
        setTopEquipment(rows.map((r) => ({ equipment: String(r.equipment ?? ''), count: Number(r.cnt ?? 0) })));
      } catch {
        setTopEquipment([]);
      }

      const liveEffectFlaggedWosCTE = ruleWOsSQL
        ? `flagged_wos AS (
            SELECT wo_number FROM ai_flags
            UNION
            SELECT work_order_number AS wo_number FROM v_analysis_scope WHERE work_order_number IN (${ruleWOsSQL})
          )`
        : `flagged_wos AS (SELECT DISTINCT wo_number FROM ai_flags)`;

      // Per Work Center — re-query unless work center is the source
      try {
        if (!run.columnMap?.work_center) {
          setPerWorkCenter([]);
        } else if (isWCSource) {
          // Source: keep all work center bars, highlighting handled in UI
          const rows = await query(`
            WITH base AS (
              SELECT work_center, work_order_number FROM v_analysis_scope
              WHERE work_center IS NOT NULL AND TRIM(work_center) <> ''
            ),
            ${liveEffectFlaggedWosCTE}
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

          // Fix 8: compute WC-filtered stats for stat cards
          try {
            const wcWORows = await query(
              `SELECT DISTINCT work_order_number AS wo FROM v_analysis_scope WHERE work_center = '${esc(visualSelection!.value)}'`
            );
            const wcWoSet = new Set(wcWORows.map((r) => String(r.wo ?? '')));
            const wcAIFlags = (run.aiFlags ?? []).filter((f) => wcWoSet.has(f.woNumber));
            const wcRuleWOs = (liveStats?.filteredRuleWOs ?? ruleChecks?.flaggedWOs ?? []).filter((fw) => wcWoSet.has(fw.wo));
            const wcAISet = new Set(wcAIFlags.map((f) => f.woNumber));
            const wcRuleSet = new Set(wcRuleWOs.map((fw) => fw.wo));
            const wcAllFlagged = new Set([...wcAISet, ...wcRuleSet]);
            const wcByCategory: Partial<Record<FlagCategory, number>> = {};
            for (const f of wcAIFlags) wcByCategory[f.category] = (wcByCategory[f.category] ?? 0) + 1;
            setVisualStats({
              totalWOs: wcWoSet.size,
              filteredAIFlags: wcAIFlags,
              filteredRuleWOs: wcRuleWOs,
              aiFlagged: wcAISet.size,
              totalAIFlags: wcAIFlags.length,
              cleanWOs: Math.max(0, wcWoSet.size - wcAllFlagged.size),
              filteredByCategory: wcByCategory,
            });
          } catch { setVisualStats(null); }
        } else {
          setVisualStats(null);
          const whereClause = visualWhere ? `AND ${visualWhere}` : '';
          const rows = await query(`
            WITH base AS (
              SELECT work_center, work_order_number FROM v_analysis_scope
              WHERE work_center IS NOT NULL AND TRIM(work_center) <> ''
              ${whereClause}
            ),
            ${liveEffectFlaggedWosCTE}
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
        }
      } catch {
        setPerWorkCenter([]);
      }

      // Code Quality — re-query unless code quality is the source
      // invalidHierarchy = desc_code_conflict AI flags (filtered to the current visual WO set)
      try {
        const hasParts = !!run.columnMap?.object_part_code_description;
        if (!hasParts) {
          setCodeQuality(null);
        } else if (isCQSource) {
          // Source: keep all segments (unfiltered)
          const [r] = await query(`
            WITH per AS (
              SELECT
                UPPER(TRIM(COALESCE(object_part_code_description,''))) AS p,
                UPPER(TRIM(COALESCE(damage_code_description,''))) AS d,
                UPPER(TRIM(COALESCE(cause_code_description,''))) AS c
              FROM v_analysis_scope
            )
            SELECT
              COUNT(*) FILTER (WHERE p LIKE 'NOT LISTED%' OR d LIKE 'NOT LISTED%' OR c LIKE 'NOT LISTED%') AS not_listed,
              COUNT(*) FILTER (WHERE p = '' AND d = '' AND c = '') AS missing,
              COUNT(*) AS total
            FROM per
          `);
          const notListed = Number(r?.not_listed ?? 0);
          const missing = Number(r?.missing ?? 0);
          const total = Number(r?.total ?? 0);
          const sourceAIFlags = liveStats?.filteredAIFlags ?? run.aiFlags ?? [];
          const invalidHierarchy = new Set(sourceAIFlags.filter(f => f.category === 'desc_code_conflict').map(f => f.woNumber)).size;
          setCodeQuality({ notListed, missing, invalidHierarchy, valid: Math.max(0, total - notListed - missing - invalidHierarchy) });
        } else {
          const scopeFilter = visualWhere ? `WHERE ${visualWhere}` : '';
          const [r] = await query(`
            WITH per AS (
              SELECT
                UPPER(TRIM(COALESCE(object_part_code_description,''))) AS p,
                UPPER(TRIM(COALESCE(damage_code_description,''))) AS d,
                UPPER(TRIM(COALESCE(cause_code_description,''))) AS c
              FROM v_analysis_scope
              ${scopeFilter}
            )
            SELECT
              COUNT(*) FILTER (WHERE p LIKE 'NOT LISTED%' OR d LIKE 'NOT LISTED%' OR c LIKE 'NOT LISTED%') AS not_listed,
              COUNT(*) FILTER (WHERE p = '' AND d = '' AND c = '') AS missing,
              COUNT(*) AS total
            FROM per
          `);
          const notListed = Number(r?.not_listed ?? 0);
          const missing = Number(r?.missing ?? 0);
          const total = Number(r?.total ?? 0);
          // For the visual WO set, count desc_code_conflict flags within that scope
          let cqAIFlags = liveStats?.filteredAIFlags ?? run.aiFlags ?? [];
          if (visualWhere) {
            try {
              const woRows = await query(`SELECT DISTINCT work_order_number AS wo FROM v_analysis_scope ${scopeFilter}`);
              const woSet = new Set(woRows.map((w) => String(w.wo ?? '')));
              cqAIFlags = cqAIFlags.filter((f) => woSet.has(f.woNumber));
            } catch { /* fallback to unfiltered */ }
          }
          const invalidHierarchy = new Set(cqAIFlags.filter(f => f.category === 'desc_code_conflict').map(f => f.woNumber)).size;
          setCodeQuality({ notListed, missing, invalidHierarchy, valid: Math.max(0, total - notListed - missing - invalidHierarchy) });
        }
      } catch {
        setCodeQuality(null);
      }

      // Overall Quality — pure in-memory (no DB), but respect visual filter when active
      // When overallQualitySegment is the source, keep unfiltered counts for highlighting
      if (!isOQSource && visualWhere && run.aiFlags && run.ruleChecks) {
        // When a visual filter is active, overall quality will be re-derived in the
        // filteredErrorDist effect which already resolves the WO set from DB.
        // Here we just let it stay as-is (updated by that effect).
      } else {
        // No filter or OQ is the source: show unfiltered counts
        const aiSet = new Set((run.aiFlags ?? []).map((f) => f.woNumber));
        const ruleSet = new Set(run.ruleChecks?.flaggedWOs.map((f) => f.wo) ?? []);
        const total = run.ruleChecks?.totalWOs ?? 0;
        const eq = aiSet.size;
        const mf = [...ruleSet].filter((w) => !aiSet.has(w)).length;
        setOverallQuality({ valid: Math.max(0, total - eq - mf), entryQuality: eq, missingFields: mf, total });
      }
    })();
  }, [run?.id, run?.hasDataInDB, run?.lastAnalysedAt, visualSelection, scopeVersion]);

  // ── Error Distribution cross-filter + Overall Quality filtered update ────────
  useEffect(() => {
    const ruleChecks = run?.ruleChecks ?? null;

    // When no filter or flagCategory is source (ED is the source), reset to unfiltered
    if (!visualSelection || visualSelection.type === 'flagCategory' || !run?.hasDataInDB) {
      setFilteredErrorDist(null);
      // Recompute unfiltered overall quality from in-memory data
      if (ruleChecks) {
        const aiSet = new Set((run?.aiFlags ?? []).map((f) => f.woNumber));
        const ruleSet = new Set(ruleChecks.flaggedWOs.map((f) => f.wo));
        const total = ruleChecks.totalWOs;
        const eq = aiSet.size;
        const mf = [...ruleSet].filter((w) => !aiSet.has(w)).length;
        setOverallQuality({ valid: Math.max(0, total - eq - mf), entryQuality: eq, missingFields: mf, total });
      }
      return;
    }

    // overallQualitySegment is the source — ED filters to that WO set but OQ stays unfiltered
    const isOQSource = visualSelection.type === 'overallQualitySegment';

    void (async () => {
      if (!ruleChecks) return;
      const esc = (s: string) => s.replace(/'/g, "''");

      let visualWhere: string | null = null;
      if (isOQSource) {
        const aiWOs = (run.aiFlags ?? []).map((f) => f.woNumber);
        const ruleWOs = ruleChecks.flaggedWOs.map((f) => f.wo);
        if (visualSelection.value === 'Review Quality (AI)') {
          const list = aiWOs.map((w) => `'${esc(w)}'`).join(',');
          visualWhere = list ? `work_order_number IN (${list})` : 'FALSE';
        } else if (visualSelection.value === 'Missing Fields') {
          const aiSet = new Set(aiWOs);
          const ruleOnly = ruleWOs.filter((w) => !aiSet.has(w));
          const list = ruleOnly.map((w) => `'${esc(w)}'`).join(',');
          visualWhere = list ? `work_order_number IN (${list})` : 'FALSE';
        } else if (visualSelection.value === 'Clean WOs') {
          const allFlagged = [...new Set([...aiWOs, ...ruleWOs])];
          const list = allFlagged.map((w) => `'${esc(w)}'`).join(',');
          visualWhere = list ? `work_order_number NOT IN (${list})` : null;
        }
      } else {
        visualWhere = buildVisualScopeWhere(visualSelection, ruleChecks);
      }

      if (!visualWhere) { setFilteredErrorDist(null); return; }

      try {
        const woRows = await query(
          `SELECT DISTINCT work_order_number AS wo FROM v_analysis_scope WHERE ${visualWhere}`
        );
        const woSet = new Set(woRows.map((r) => String(r.wo ?? '')));

        const byCategory: Partial<Record<FlagCategory, number>> = {};
        for (const f of (run.aiFlags ?? [])) {
          if (woSet.has(f.woNumber)) {
            byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
          }
        }

        const perCheck: Partial<Record<RuleCheckId, number>> = {};
        for (const fw of ruleChecks.flaggedWOs) {
          if (woSet.has(fw.wo)) {
            for (const checkId of fw.checks) {
              perCheck[checkId] = (perCheck[checkId] ?? 0) + 1;
            }
          }
        }

        setFilteredErrorDist({ perCheck, byCategory });

        // Also update overall quality for the filtered WO set (unless OQ is the source)
        if (!isOQSource) {
          const filteredAiSet = new Set((run.aiFlags ?? []).filter((f) => woSet.has(f.woNumber)).map((f) => f.woNumber));
          const filteredRuleSet = new Set(ruleChecks.flaggedWOs.filter((f) => woSet.has(f.wo)).map((f) => f.wo));
          const total = woSet.size;
          const eq = filteredAiSet.size;
          const mf = [...filteredRuleSet].filter((w) => !filteredAiSet.has(w)).length;
          setOverallQuality({ valid: Math.max(0, total - eq - mf), entryQuality: eq, missingFields: mf, total });
        }
      } catch {
        setFilteredErrorDist(null);
      }
    })();
  }, [visualSelection, run?.hasDataInDB, run?.id, run?.lastAnalysedAt]);

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

  const handleVisualClick = (type: VisualSelectionType, value: string) => {
    setVisualSelection((prev) =>
      prev?.type === type && prev?.value === value ? null : { type, value }
    );
  };

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
      const chartCache = await _computeChartCache(run.columnMap, results.ruleChecks, flags);

      // Guarantee patch: reconcile ruleChecks with the authoritative missingCodeWOs list
      // from chartCache (computed via the same CTE that drives the Code Quality donut).
      // This ensures Error Distribution, IssueExplorer Rule Flags, and dashboard.html all
      // show Missing Codes consistently even if runRuleChecks() underreported due to a
      // scope view timing issue.
      const patchedRuleChecks = (() => {
        const missingWOs = chartCache.missingCodeWOs ?? [];
        if (missingWOs.length === 0) return results.ruleChecks;
        const rc = results.ruleChecks;
        // Patch perCheck count upward if cache has more
        const currentCount = rc.perCheck['missing_codes']?.matched ?? 0;
        const newPerCheck = currentCount >= missingWOs.length ? rc.perCheck : {
          ...rc.perCheck,
          missing_codes: { matched: missingWOs.length, sampleWOs: missingWOs.slice(0, 5) },
        };
        // Patch flaggedWOs — add/augment entries for any WO in missingWOs not already flagged
        const flaggedMap = new Map(rc.flaggedWOs.map(fw => [fw.wo, [...fw.checks] as typeof fw.checks]));
        let patched = false;
        for (const wo of missingWOs) {
          const existing = flaggedMap.get(wo);
          if (existing) {
            if (!existing.includes('missing_codes')) {
              existing.push('missing_codes');
              patched = true;
            }
          } else {
            flaggedMap.set(wo, ['missing_codes']);
            patched = true;
          }
        }
        if (!patched && currentCount >= missingWOs.length) return rc;
        const newFlaggedWOs = Array.from(flaggedMap.entries()).map(([wo, checks]) => ({ wo, checks }));
        return { ...rc, perCheck: newPerCheck, flaggedWOs: newFlaggedWOs };
      })();

      updateRun(run.id, {
        ruleChecks: patchedRuleChecks,
        aiFlagSummary: results.aiFlagSummary ?? null,
        aiFlags: flags,
        analysisFilters: filters,
        stage: 'analysed',
        lastAnalysedAt: new Date().toISOString(),
        chartCache,
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
            {(() => {
              const fmtD = (s: string | null) => {
                if (!s) return '';
                const [y, m, d] = s.split('-');
                return `${parseInt(m)}/${parseInt(d)}/${y}`;
              };
              const df = run.analysisFilters?.dateFrom || run.dataProfile?.dateRange?.min || null;
              const dt = run.analysisFilters?.dateTo   || run.dataProfile?.dateRange?.max || null;
              const dateRange = df && dt ? `${fmtD(df)} – ${fmtD(dt)}` : run.periodLabel;
              return `${project?.name ?? 'Project'} · Run #${run.runIndex} · ${dateRange} · ${(liveStats?.totalWOs ?? liveScopeCount ?? run.ruleChecks.totalWOs).toLocaleString()} WOs in scope`;
            })()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {visualSelection && (
            <button
              onClick={() => setVisualSelection(null)}
              className="px-3 py-1.5 text-xs font-bold rounded border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition flex items-center gap-1.5"
            >
              <Icon name="x" className="w-3.5 h-3.5" />
              Clear visual filter
            </button>
          )}
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

      {visualSelection && (
        <div className="text-xs text-indigo-600 bg-indigo-50 border border-indigo-200 rounded px-3 py-2">
          Filtered by <strong>{
            visualSelection.type === 'workCenter' ? 'Work Center' :
            visualSelection.type === 'equipment' ? 'Equipment' :
            visualSelection.type === 'codeQualitySegment' ? 'Code Quality' :
            visualSelection.type === 'overallQualitySegment' ? 'Overall Quality' :
            'Flag Category'
          }</strong>: {visualSelection.value} — charts are showing data within this selection.
        </div>
      )}

      {/* When liveStats is available (scope filtered without re-run), derive display values from it */}
      {(() => {
        // Charts (Error Distribution etc.) still use liveStats for scope-filtered counts
        const displayRuleChecks = liveStats
          ? { ...run.ruleChecks, totalWOs: liveStats.totalWOs, flaggedWOs: liveStats.filteredRuleWOs }
          : run.ruleChecks;
        const displayAISummary: AIFlagSummary | null = liveStats
          ? {
              totalFlagged: liveStats.aiFlagged,
              totalFlags: liveStats.totalAIFlags,
              byCategory: liveStats.filteredByCategory,
              generatedAt: run.aiFlagSummary?.generatedAt ?? '',
              scopeWOCount: liveStats.totalWOs,
            }
          : run.aiFlagSummary;
        const displayAIFlags = liveStats ? liveStats.filteredAIFlags : (run.aiFlags ?? []);
        // Error dist: visual selection takes priority, otherwise show scope-filtered counts
        const displayFilteredErrorDist = (!visualSelection && liveStats)
          ? { perCheck: liveStats.filteredPerCheck, byCategory: liveStats.filteredByCategory }
          : filteredErrorDist;
        // Overall quality: scope-filtered when liveStats available and no visual selection
        const displayOverallQuality = (liveStats && !visualSelection)
          ? (() => {
              const aiSet = new Set(liveStats.filteredAIFlags.map((f) => f.woNumber));
              const ruleSet = new Set(liveStats.filteredRuleWOs.map((f) => f.wo));
              return {
                valid: liveStats.cleanWOs,
                entryQuality: aiSet.size,
                missingFields: [...ruleSet].filter((w) => !aiSet.has(w)).length,
                total: liveStats.totalWOs,
              };
            })()
          : overallQuality;

        // Stat cards: react to WC visual filter only — not to live scope filter changes
        const cardRuleChecks = visualStats
          ? { ...run.ruleChecks, totalWOs: visualStats.totalWOs, flaggedWOs: visualStats.filteredRuleWOs }
          : run.ruleChecks;
        const cardAISummary: AIFlagSummary | null = visualStats
          ? {
              totalFlagged: visualStats.aiFlagged,
              totalFlags: visualStats.totalAIFlags,
              byCategory: visualStats.filteredByCategory,
              generatedAt: run.aiFlagSummary?.generatedAt ?? '',
              scopeWOCount: visualStats.totalWOs,
            }
          : run.aiFlagSummary;
        const cardAIFlags = visualStats ? visualStats.filteredAIFlags : (run.aiFlags ?? []);

        return (
          <>
            <SummaryRow ruleChecks={cardRuleChecks} aiFlagSummary={cardAISummary} aiFlags={cardAIFlags} />

            <ChartCard
              title="Error Distribution"
              subtitle="Counts per category — both rule-based and AI-detected"
              hint={visualSelection?.type === 'flagCategory' ? `Filtered: ${visualSelection.value}` : undefined}
            >
              <ErrorDistribution
                ruleChecks={displayRuleChecks}
                ai={displayAISummary}
                filteredErrorDist={displayFilteredErrorDist}
                visualSelection={visualSelection}
                onSelect={(key) => handleVisualClick('flagCategory', key)}
              />
            </ChartCard>

            <div className="grid lg:grid-cols-2 gap-6">
              <ChartCard
                title="Code Quality Breakdown"
                subtitle="State of the Object/Damage/Cause description fields"
                hint={visualSelection?.type === 'codeQualitySegment' ? `Filtered: ${visualSelection.value}` : undefined}
              >
                <CodeQualityDonut
                  data={codeQuality}
                  visualSelection={visualSelection}
                  onSelect={(name) => handleVisualClick('codeQualitySegment', name)}
                />
              </ChartCard>
              <ChartCard
                title="Overall Quality"
                subtitle="WOs by flag status — Valid, text quality, or missing fields"
                hint={visualSelection?.type === 'overallQualitySegment' ? `Filtered: ${visualSelection.value}` : undefined}
              >
                <OverallQualityRing
                  data={displayOverallQuality}
                  visualSelection={visualSelection}
                  onSelect={(name) => handleVisualClick('overallQualitySegment', name)}
                />
              </ChartCard>
            </div>
          </>
        );
      })()}

      <div className="grid lg:grid-cols-2 gap-6">
        <ChartCard
          title="Per Work Center"
          subtitle="Total WOs vs flagged"
          hint={visualSelection?.type === 'workCenter' ? `Filtered: ${visualSelection.value}` : undefined}
        >
          {perWorkCenter.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={perWorkCenter}
                margin={{ bottom: 68 }}
                style={{ cursor: 'pointer' }}
                onClick={(data) => {
                  const wc = data?.activePayload?.[0]?.payload?.workCenter;
                  if (wc) handleVisualClick('workCenter', wc);
                }}
              >
                <XAxis
                  dataKey="workCenter"
                  tick={{ fontSize: 10 }}
                  angle={-45}
                  textAnchor="end"
                  interval={0}
                  dy={14}
                  dx={-4}
                />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="total" name="Total" fill="#94a3b8">
                  {perWorkCenter.map((d, i) => (
                    <Cell
                      key={i}
                      fill="#94a3b8"
                      fillOpacity={itemOpacity(visualSelection, 'workCenter', d.workCenter)}
                    />
                  ))}
                </Bar>
                <Bar dataKey="flagged" name="Flagged" fill={AI_COLOR}>
                  {perWorkCenter.map((d, i) => (
                    <Cell
                      key={i}
                      fill={AI_COLOR}
                      fillOpacity={itemOpacity(visualSelection, 'workCenter', d.workCenter)}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
        <ChartCard
          title="Top Problem Equipment"
          subtitle="Equipment with the most flags — AI and rule-based combined"
          hint={visualSelection?.type === 'equipment' ? `Filtered: ${visualSelection.value}` : undefined}
        >
          <TopEquipmentTable
            rows={topEquipment}
            visualSelection={visualSelection}
            onSelect={(eq) => handleVisualClick('equipment', eq)}
          />
        </ChartCard>
      </div>

      {filterOptions && (
        <FilterPanel
          filters={filters}
          options={filterOptions}
          columnMap={run.columnMap}
          totalWOs={run.dataProfile?.distinctWOs ?? 0}
          scopeWOs={liveScopeCount ?? run.ruleChecks.totalWOs}
          onChange={setFilters}
        />
      )}

      <div className="flex flex-wrap gap-3 items-center">
        <button
          onClick={rerun}
          disabled={isRerunning || !run.hasDataInDB}
          title={!run.hasDataInDB ? 'Re-upload the file to re-run analysis' : undefined}
          className="bg-slate-900 text-white px-5 py-2 rounded text-sm font-bold flex items-center gap-2 hover:bg-slate-800 transition disabled:opacity-50"
        >
          {isRerunning ? <Icon name="loader" className="w-4 h-4 animate-spin" /> : <Icon name="refresh" className="w-4 h-4" />}
          {run.hasDataInDB ? 'Re-run with filters' : 'Re-upload to re-run'}
        </button>
        {error && <div className="text-xs text-red-600">{error}</div>}
        {isRerunning && aiProgress.total > 0 && (
          <span className="text-xs text-slate-500 font-mono">
            AI {aiProgress.done}/{aiProgress.total} WOs
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
  aiFlags,
}: {
  ruleChecks: RuleCheckResult;
  aiFlagSummary: AIFlagSummary | null;
  aiFlags: AIFlag[];
}) {
  const ruleFlagged = new Set(ruleChecks.flaggedWOs.map((f) => f.wo)).size;
  const aiFlagged = aiFlagSummary?.totalFlagged ?? 0;
  const ruleHits = ruleChecks.flaggedWOs.reduce((s, fw) => s + fw.checks.length, 0);
  const totalFlags = (aiFlagSummary?.totalFlags ?? 0) + ruleHits;
  const aiWoSet = new Set(aiFlags.map((f) => f.woNumber));
  const ruleWoSet = new Set(ruleChecks.flaggedWOs.map((f) => f.wo));
  const allFlagged = new Set([...aiWoSet, ...ruleWoSet]);
  const cleanCount = Math.max(0, ruleChecks.totalWOs - allFlagged.size);
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Stat label="Rule-Flagged WOs" value={ruleFlagged} accent="text-amber-600" />
      <Stat label="AI-Flagged WOs" value={aiFlagged} accent="text-indigo-600" />
      <Stat label="Total Flags" value={totalFlags} accent="text-violet-600" />
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
  hint,
  children,
}: {
  title: string;
  subtitle?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded shadow-sm p-4 animate-enter">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-bold text-slate-700 text-sm">{title}</div>
          {subtitle && <div className="text-xs text-slate-400 mt-0.5">{subtitle}</div>}
        </div>
        {hint && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-600 shrink-0">
            {hint}
          </span>
        )}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function ErrorDistribution({
  ruleChecks,
  ai,
  filteredErrorDist,
  visualSelection,
  onSelect,
}: {
  ruleChecks: RuleCheckResult;
  ai: AIFlagSummary | null;
  filteredErrorDist: { perCheck: Partial<Record<RuleCheckId, number>>; byCategory: Partial<Record<FlagCategory, number>> } | null;
  visualSelection: VisualSelection;
  onSelect: (key: string) => void;
}) {
  const ruleData = (Object.keys(RULE_CHECK_LABELS) as RuleCheckId[])
    .map((id) => ({
      key: id,
      label: RULE_CHECK_LABELS[id].label,
      value: filteredErrorDist ? (filteredErrorDist.perCheck[id] ?? 0) : (ruleChecks.perCheck[id]?.matched ?? 0),
      type: 'Rule' as const,
    }))
    .filter((d) => d.value > 0);

  const aiData = ai
    ? (Object.keys(FLAG_CATEGORY_LABELS) as FlagCategory[])
        .map((c) => ({
          key: c,
          label: FLAG_CATEGORY_LABELS[c],
          value: filteredErrorDist ? (filteredErrorDist.byCategory[c] ?? 0) : (ai.byCategory[c] ?? 0),
          type: 'AI' as const,
        }))
        .filter((d) => d.value > 0)
    : [];

  const allData = [...ruleData, ...aiData];
  if (allData.length === 0) return <Empty />;
  const maxVal = Math.max(...allData.map((d) => d.value), 1);

  type BarItem = { key: string; label: string; value: number; type: 'Rule' | 'AI' };
  const renderSection = (items: BarItem[], title: string, color: string) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-3">
        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 mt-1">{title}</div>
        {items.map((d) => {
          const isSelected = visualSelection?.type === 'flagCategory' && visualSelection.value === d.key;
          const dimmed = visualSelection?.type === 'flagCategory' && visualSelection.value !== d.key;
          const pct = (d.value / maxVal) * 100;
          return (
            <div
              key={d.key}
              onClick={() => onSelect(d.key)}
              style={{ opacity: dimmed ? 0.25 : 1 }}
              className={`flex items-center gap-2 mb-1.5 cursor-pointer rounded px-1 py-0.5 transition hover:bg-slate-50 ${isSelected ? 'bg-indigo-50 ring-1 ring-indigo-200' : ''}`}
            >
              <div className="text-[10px] text-slate-600 text-right shrink-0" style={{ width: 172 }}>{d.label}</div>
              <div className="flex-1 h-4 bg-slate-100 rounded overflow-hidden">
                <div
                  className="h-full rounded"
                  style={{ width: `${pct.toFixed(1)}%`, background: color, minWidth: d.value > 0 ? 2 : 0 }}
                />
              </div>
              <div className="text-[11px] font-bold text-slate-600 w-8 text-right shrink-0 font-mono">{d.value}</div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="py-1">
      {renderSection(ruleData, 'Rule-Based Issues', RULE_COLOR)}
      {renderSection(aiData, 'AI-Detected Issues', AI_COLOR)}
    </div>
  );
}

function CodeQualityDonut({
  data,
  visualSelection,
  onSelect,
}: {
  data: { valid: number; notListed: number; invalidHierarchy: number; missing: number } | null;
  visualSelection: VisualSelection;
  onSelect: (name: string) => void;
}) {
  if (!data) return <Empty />;
  const rows = [
    { name: 'Valid',             value: data.valid },
    { name: 'Not Listed',        value: data.notListed },
    { name: 'Invalid Hierarchy', value: data.invalidHierarchy },
    { name: 'Missing Codes',     value: data.missing },
  ].filter((r) => r.value > 0);
  if (rows.length === 0) return <Empty />;
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart style={{ cursor: 'pointer' }}>
        <Pie
          data={rows}
          dataKey="value"
          nameKey="name"
          innerRadius={60}
          outerRadius={90}
          paddingAngle={2}
          onClick={(entry) => onSelect(entry.name)}
        >
          {rows.map((r) => (
            <Cell
              key={r.name}
              fill={CQ_COLORS[r.name] ?? '#94a3b8'}
              fillOpacity={itemOpacity(visualSelection, 'codeQualitySegment', r.name)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </Pie>
        <Legend
          content={({ payload }) => (
            <div className="flex flex-col gap-1 mt-2">
              {(payload ?? []).map((p: any) => {
                const pct = total > 0 ? ((p.payload.value / total) * 100).toFixed(1) : '0.0';
                return (
                  <div key={p.value} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: p.color }} />
                      <span className="text-slate-600">{p.value}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400 text-[10px]">{pct}%</span>
                      <span className="font-bold text-slate-700 font-mono w-8 text-right">{p.payload.value.toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

function TopEquipmentTable({
  rows,
  visualSelection,
  onSelect,
}: {
  rows: Array<{ equipment: string; count: number }>;
  visualSelection: VisualSelection;
  onSelect: (equipment: string) => void;
}) {
  if (rows.length === 0) return <Empty />;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => {
        const opacity = itemOpacity(visualSelection, 'equipment', r.equipment);
        const isSelected = visualSelection?.type === 'equipment' && visualSelection.value === r.equipment;
        return (
          <div
            key={i}
            onClick={() => onSelect(r.equipment)}
            style={{ opacity }}
            className={`flex items-center gap-3 text-xs cursor-pointer rounded px-1 py-0.5 transition hover:bg-slate-50 ${
              isSelected ? 'bg-indigo-50 ring-1 ring-indigo-200' : ''
            }`}
          >
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
        );
      })}
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
