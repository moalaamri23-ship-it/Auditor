import React, { useState, useMemo, useEffect } from 'react';
import Icon from './Icon';
import FilterPanel from './FilterPanel';
import { TIMESTAMP_COLUMNS } from '../constants';
import { useActiveRun, useActiveProject, useStore } from '../store/useStore';
import {
  query, getFilterOptions, getLiveScopeCount, getCascadingFilterOptions,
  createAnalysisScopeView,
} from '../services/DuckDBService';
import { RULE_CHECK_LABELS } from '../analysis/RuleChecksModule';
import { FLAG_CATEGORY_LABELS } from '../analysis/AITextModule';
import type {
  AIFlag, FlagCategory, ColumnMap, RuleCheckId, RuleCheckResult,
  AnalysisFilters, FilterOptions,
} from '../types';
import { EMPTY_FILTERS } from '../types';

type Tab = 'data' | 'rule-flags' | 'ai-flags';

// ─── Full-table WO data ──────────────────────────────────────────────────────

interface FullTableData {
  columns: string[];
  rows: Record<string, unknown>[];
}

async function loadFullWOData(): Promise<FullTableData> {
  const schemaRows = await query(`DESCRIBE audit`);
  const columns = schemaRows
    .map((r: any) => String(r.column_name ?? ''))
    .filter((c) => !c.startsWith('_'));

  if (columns.length === 0) return { columns: [], rows: [] };

  const colExprs = columns.map((c) => `"${c}"`).join(', ');
  const rows = await query(`SELECT ${colExprs} FROM v_wo_primary LIMIT 5000`);
  return { columns, rows };
}

// ─── Curated WO detail for Rule Flags expand panel ──────────────────────────

interface WODetail {
  woNumber: string;
  equipment: string;
  workCenter: string;
  description: string;
  codes: string;
  closure: string;
}

async function loadWODetail(woNumber: string, columnMap: ColumnMap): Promise<WODetail | null> {
  const has = (c: string) => !!columnMap[c as keyof ColumnMap];

  const codeParts: string[] = [];
  if (has('object_part_code_description'))
    codeParts.push(`CASE WHEN object_part_code_description <> '' THEN 'Part: ' || object_part_code_description ELSE '' END`);
  if (has('damage_code_description'))
    codeParts.push(`CASE WHEN damage_code_description <> '' THEN 'Damage: ' || damage_code_description ELSE '' END`);
  if (has('cause_code_description'))
    codeParts.push(`CASE WHEN cause_code_description <> '' THEN 'Cause: ' || cause_code_description ELSE '' END`);

  const codesExpr =
    codeParts.length > 0
      ? `array_to_string(list_filter([${codeParts.join(', ')}], x -> x <> ''), ' | ')`
      : `''`;

  const cols = [
    has('work_order_number') ? 'work_order_number AS wo' : `'' AS wo`,
    has('equipment_description')
      ? 'equipment_description AS eq'
      : has('equipment')
        ? 'equipment AS eq'
        : `'' AS eq`,
    has('work_center') ? 'work_center AS wc' : `'' AS wc`,
    has('work_order_description') ? 'work_order_description AS descn' : `'' AS descn`,
    `${codesExpr} AS codes`,
    has('confirmation_text')
      ? 'confirmation_text AS closure'
      : has('confirmation_long_text')
        ? 'confirmation_long_text AS closure'
        : `'' AS closure`,
  ].join(', ');

  const woEsc = woNumber.replace(/'/g, "''");
  const rows = await query(
    `SELECT ${cols} FROM audit WHERE work_order_number = '${woEsc}' LIMIT 1`
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    woNumber: String(r.wo ?? ''),
    equipment: String(r.eq ?? ''),
    workCenter: String(r.wc ?? ''),
    description: String(r.descn ?? ''),
    codes: String(r.codes ?? ''),
    closure: String(r.closure ?? ''),
  };
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function IssueExplorer() {
  const run = useActiveRun();
  const project = useActiveProject();
  const { setScreen } = useStore();

  const [tab, setTab] = useState<Tab>('data');
  const [tableData, setTableData] = useState<FullTableData>({ columns: [], rows: [] });
  const [loadingWO, setLoadingWO] = useState(false);
  const [search, setSearch] = useState('');

  // ── Filter state ────────────────────────────────────────────────────────────
  const [filters, setFilters] = useState<AnalysisFilters>(run?.analysisFilters ?? EMPTY_FILTERS);
  const [baseFilterOptions, setBaseFilterOptions] = useState<FilterOptions | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [liveScopeCount, setLiveScopeCount] = useState<number | null>(null);
  const [scopeWoSet, setScopeWoSet] = useState<Set<string> | null>(null);

  // Load filter options once when data is in DB
  useEffect(() => {
    if (!run?.hasDataInDB || !run.columnMap) return;
    getFilterOptions(run.columnMap).then((opts) => {
      setBaseFilterOptions(opts);
      setFilterOptions(opts);
    }).catch(() => {});
  }, [run?.hasDataInDB, run?.id]);

  // Debounced: update scope WO set + cascading options on filter change
  useEffect(() => {
    if (!run?.hasDataInDB || !run.columnMap || !baseFilterOptions) return;
    const hasActive =
      !!filters.dateFrom || !!filters.dateTo ||
      filters.workCenter.length > 0 || filters.functionalLocation.length > 0 ||
      filters.failureCatalog.length > 0 || filters.equipment.length > 0;

    const t = setTimeout(async () => {
      const [count, cascaded] = await Promise.all([
        getLiveScopeCount(filters, run.columnMap, project),
        getCascadingFilterOptions(filters, run.columnMap, project, baseFilterOptions),
      ]);
      setLiveScopeCount(count);
      setFilterOptions(cascaded);

      if (hasActive) {
        try {
          await createAnalysisScopeView(filters, run.columnMap, project);
          const rows = await query('SELECT work_order_number FROM v_analysis_scope');
          setScopeWoSet(new Set(rows.map((r) => String(r.work_order_number ?? ''))));
        } catch {
          setScopeWoSet(null);
        }
      } else {
        setScopeWoSet(null);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [filters, run?.hasDataInDB, run?.id, baseFilterOptions, project]);

  // Load WO data when tab opens
  useEffect(() => {
    if (tab === 'data' && run?.hasDataInDB) {
      setLoadingWO(true);
      loadFullWOData()
        .then(setTableData)
        .catch(() => setTableData({ columns: [], rows: [] }))
        .finally(() => setLoadingWO(false));
    }
  }, [tab, run?.id, run?.hasDataInDB]);

  // ── Filtered slices ─────────────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    let rows = tableData.rows;
    if (scopeWoSet !== null) {
      rows = rows.filter((r) => scopeWoSet.has(String(r.work_order_number ?? '')));
    }
    const q = search.toLowerCase().trim();
    if (q) {
      rows = rows.filter((r) =>
        Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q))
      );
    }
    return rows;
  }, [tableData.rows, search, scopeWoSet]);

  const filteredRuleFlags = useMemo(() => {
    if (!run?.ruleChecks) return [];
    if (scopeWoSet === null) return run.ruleChecks.flaggedWOs;
    return run.ruleChecks.flaggedWOs.filter((f) => scopeWoSet.has(f.wo));
  }, [run?.ruleChecks, scopeWoSet]);

  const filteredAIFlags = useMemo(() => {
    if (!run?.aiFlags) return [];
    if (scopeWoSet === null) return run.aiFlags;
    return run.aiFlags.filter((f) => scopeWoSet.has(f.woNumber));
  }, [run?.aiFlags, scopeWoSet]);

  if (!run) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">No active run.</div>
    );
  }

  const totalWOs = run.dataProfile?.distinctWOs ?? 0;

  return (
    <div className="max-w-full px-6 py-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-end justify-between flex-wrap gap-3 mb-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Issues</h1>
            <p className="text-sm text-slate-500 mt-1">
              Explore work orders, rule-flagged WOs, and AI semantic findings.
            </p>
          </div>
          <button
            onClick={() => setScreen('analysis')}
            className="px-3 py-1.5 text-xs font-bold rounded border border-slate-200 bg-white text-slate-700 hover:border-brand-400 transition flex items-center gap-1.5"
          >
            <Icon name="arrowLeft" className="w-3.5 h-3.5" />
            Back to Audit
          </button>
        </div>

        {/* Audit scope filter panel */}
        {filterOptions && (
          <div className="mb-4">
            <FilterPanel
              filters={filters}
              options={filterOptions}
              columnMap={run.columnMap}
              totalWOs={totalWOs}
              scopeWOs={liveScopeCount ?? totalWOs}
              onChange={setFilters}
            />
          </div>
        )}

        <div className="flex border-b border-slate-200 mb-4">
          <TabButton active={tab === 'data'} onClick={() => setTab('data')}>
            WO Data <span className="ml-1 text-slate-400">({filteredRows.length})</span>
          </TabButton>
          <TabButton active={tab === 'rule-flags'} onClick={() => setTab('rule-flags')}>
            Rule Flags{' '}
            <span className="ml-1 text-slate-400">
              ({new Set(filteredRuleFlags.map((f) => f.wo)).size})
            </span>
          </TabButton>
          <TabButton active={tab === 'ai-flags'} onClick={() => setTab('ai-flags')}>
            AI Flags <span className="ml-1 text-slate-400">({filteredAIFlags.length})</span>
          </TabButton>
        </div>

        {tab === 'data' && (
          <DataTab
            columns={tableData.columns}
            rows={filteredRows}
            loading={loadingWO}
            hasDB={!!run.hasDataInDB}
            search={search}
            onSearch={setSearch}
          />
        )}
        {tab === 'rule-flags' && run.ruleChecks && (
          <RuleFlagsTab
            result={run.ruleChecks}
            filteredFlaggedWOs={filteredRuleFlags}
            columnMap={run.columnMap}
            hasDB={!!run.hasDataInDB}
          />
        )}
        {tab === 'ai-flags' && (
          <AIFlagsTab flags={filteredAIFlags} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-bold border-b-2 transition ${
        active ? 'border-brand-500 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  );
}

// ─── DataTab ─────────────────────────────────────────────────────────────────

function DataTab({
  columns,
  rows,
  loading,
  hasDB,
  search,
  onSearch,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  loading: boolean;
  hasDB: boolean;
  search: string;
  onSearch: (s: string) => void;
}) {
  if (!hasDB) {
    return (
      <div className="bg-white border border-slate-200 rounded shadow-sm p-12 text-center text-slate-400 text-sm">
        Data not loaded — re-upload the file to view the WO table.
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded shadow-sm">
      <div className="p-3 border-b border-slate-200 flex items-center gap-2">
        <Icon name="search" className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search any column…"
          className="flex-1 outline-none text-sm"
        />
        <span className="text-xs text-slate-400 shrink-0">{rows.length} rows</span>
      </div>
      {loading ? (
        <div className="p-12 text-center text-slate-400 text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-12 text-center text-slate-400 text-sm">No matching work orders.</div>
      ) : (
        <div className="overflow-auto scroll-thin" style={{ maxHeight: 600 }}>
          <table className="text-xs w-max min-w-full">
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-3 py-2 text-left text-[10px] font-bold uppercase text-slate-500 border-b border-r border-slate-200 whitespace-nowrap"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  {columns.map((col) => {
                    const raw = row[col];
                    const isDate = (TIMESTAMP_COLUMNS as string[]).includes(col);
                    let display = String(raw ?? '');
                    if (isDate && display) {
                      const d = new Date(display);
                      if (!isNaN(d.getTime())) {
                        display = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
                      }
                    }
                    return (
                      <td
                        key={col}
                        className="px-3 py-1.5 text-slate-700 border-r border-slate-100 font-mono max-w-[200px] truncate"
                        title={display}
                      >
                        {display}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── RuleFlagsTab ─────────────────────────────────────────────────────────────

function RuleFlagsTab({
  result,
  filteredFlaggedWOs,
  columnMap,
  hasDB,
}: {
  result: RuleCheckResult;
  filteredFlaggedWOs: RuleCheckResult['flaggedWOs'];
  columnMap: ColumnMap;
  hasDB: boolean;
}) {
  const [filter, setFilter] = useState<RuleCheckId | 'ALL'>('ALL');
  const [expandedWO, setExpandedWO] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Map<string, WODetail | null>>(new Map());
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const ids = Object.keys(RULE_CHECK_LABELS) as RuleCheckId[];

  const displayFlags = useMemo(() => {
    if (filter === 'ALL') return filteredFlaggedWOs;
    return filteredFlaggedWOs.filter((f) => f.checks.includes(filter));
  }, [filteredFlaggedWOs, filter]);

  // Per-check counts from the filtered set
  const filteredPerCheck = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const id of ids) counts[id] = 0;
    for (const f of filteredFlaggedWOs) {
      for (const c of f.checks) counts[c] = (counts[c] ?? 0) + 1;
    }
    return counts;
  }, [filteredFlaggedWOs, ids]);

  const toggleWO = async (wo: string) => {
    if (expandedWO === wo) {
      setExpandedWO(null);
      return;
    }
    setExpandedWO(wo);
    if (!hasDB || detailCache.has(wo)) return;
    setLoadingDetail(wo);
    try {
      const detail = await loadWODetail(wo, columnMap);
      setDetailCache((prev) => new Map(prev).set(wo, detail));
    } catch {
      setDetailCache((prev) => new Map(prev).set(wo, null));
    } finally {
      setLoadingDetail(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        <FilterChip
          active={filter === 'ALL'}
          label="All"
          count={filteredFlaggedWOs.length}
          onClick={() => setFilter('ALL')}
        />
        {ids.map((id) => {
          const c = filteredPerCheck[id] ?? 0;
          if (c === 0) return null;
          return (
            <FilterChip
              key={id}
              active={filter === id}
              label={RULE_CHECK_LABELS[id].label}
              count={c}
              onClick={() => setFilter(id)}
            />
          );
        })}
      </div>
      <div className="bg-white border border-slate-200 rounded shadow-sm">
        {displayFlags.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">No work orders match this filter.</div>
        ) : (
          <ul className="divide-y divide-slate-100 max-h-[600px] overflow-auto scroll-thin">
            {displayFlags.slice(0, 500).map((f) => {
              const isExpanded = expandedWO === f.wo;
              const detail = detailCache.get(f.wo);
              const isLoading = loadingDetail === f.wo;

              return (
                <li key={f.wo}>
                  <button
                    onClick={() => toggleWO(f.wo)}
                    className="w-full text-left px-4 py-2 text-sm flex items-center gap-3 hover:bg-slate-50 transition"
                  >
                    <Icon
                      name={isExpanded ? 'chevronDown' : 'chevronRight'}
                      className="w-3.5 h-3.5 text-slate-400 shrink-0"
                    />
                    <span className="font-mono font-bold text-slate-800 w-32 shrink-0">{f.wo}</span>
                    <CopyButton text={f.wo} />
                    <div className="flex flex-wrap gap-1 flex-1">
                      {f.checks.map((c) => (
                        <span
                          key={c}
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700"
                        >
                          {RULE_CHECK_LABELS[c].label}
                        </span>
                      ))}
                    </div>
                    <Icon
                      name={isExpanded ? 'chevronUp' : 'chevronDown'}
                      className="w-3.5 h-3.5 text-slate-300 shrink-0"
                    />
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-3 pt-1 bg-slate-50 border-t border-slate-100 animate-enter">
                      {!hasDB ? (
                        <div className="text-xs text-slate-400 italic py-2">
                          Re-upload file to see WO details.
                        </div>
                      ) : isLoading ? (
                        <div className="text-xs text-slate-400 italic py-2">Loading…</div>
                      ) : detail ? (
                        <WODetailPanel detail={detail} />
                      ) : (
                        <div className="text-xs text-slate-400 italic py-2">Detail not available.</div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {displayFlags.length > 500 && (
              <li className="px-4 py-3 text-xs text-slate-400 italic">
                … and {displayFlags.length - 500} more.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function WODetailPanel({ detail }: { detail: WODetail }) {
  return (
    <div className="grid sm:grid-cols-3 gap-3 text-xs py-1">
      <div>
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-0.5">Equipment</div>
        <div className="font-mono text-slate-700">{detail.equipment || '—'}</div>
      </div>
      <div>
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-0.5">Work Center</div>
        <div className="font-mono text-slate-700">{detail.workCenter || '—'}</div>
      </div>
      <div>
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-0.5">Codes</div>
        <div className="font-mono text-amber-700">{detail.codes || '—'}</div>
      </div>
      <div className="sm:col-span-2">
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-0.5">Description</div>
        <div className="text-slate-700">{detail.description || '—'}</div>
      </div>
      <div>
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-0.5">Confirmation</div>
        <div className="text-slate-500">{detail.closure || '—'}</div>
      </div>
    </div>
  );
}

// ─── AIFlagsTab — expandable rows ────────────────────────────────────────────

function AIFlagsTab({ flags }: { flags: AIFlag[] }) {
  const [filter, setFilter] = useState<FlagCategory | 'ALL'>('ALL');
  const [expandedWOs, setExpandedWOs] = useState<Set<string>>(new Set());

  const categories = Object.keys(FLAG_CATEGORY_LABELS) as FlagCategory[];

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of flags) counts[f.category] = (counts[f.category] ?? 0) + 1;
    return counts;
  }, [flags]);

  // Filter by category then group by WO number
  const woGroups = useMemo(() => {
    const filtered = filter === 'ALL' ? flags : flags.filter((f) => f.category === filter);
    const map = new Map<string, AIFlag[]>();
    for (const f of filtered) {
      const arr = map.get(f.woNumber) ?? [];
      arr.push(f);
      map.set(f.woNumber, arr);
    }
    return Array.from(map.entries()).map(([wo, fs]) => ({
      wo,
      flags: fs,
      topSeverity: (fs.some((f) => f.severity === 'HIGH') ? 'HIGH'
        : fs.some((f) => f.severity === 'MEDIUM') ? 'MEDIUM' : 'LOW') as AIFlag['severity'],
      equipment: fs[0]?.equipment ?? '',
    }));
  }, [flags, filter]);

  const toggleWO = (wo: string) => {
    setExpandedWOs((prev) => {
      const next = new Set(prev);
      if (next.has(wo)) next.delete(wo);
      else next.add(wo);
      return next;
    });
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        <FilterChip active={filter === 'ALL'} label="All" count={flags.length} onClick={() => setFilter('ALL')} />
        {categories.map((c) => {
          const count = categoryCounts[c] ?? 0;
          if (count === 0) return null;
          return (
            <FilterChip key={c} active={filter === c} label={FLAG_CATEGORY_LABELS[c]} count={count} onClick={() => setFilter(c)} />
          );
        })}
      </div>

      <div className="bg-white border border-slate-200 rounded shadow-sm">
        {woGroups.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">No AI flags match this filter.</div>
        ) : (
          <ul className="divide-y divide-slate-100 max-h-[600px] overflow-auto scroll-thin">
            {woGroups.slice(0, 300).map(({ wo, flags: wFlags, topSeverity, equipment }) => {
              const isExpanded = expandedWOs.has(wo);
              const sevColor =
                topSeverity === 'HIGH'
                  ? 'bg-red-100 text-red-700'
                  : topSeverity === 'MEDIUM'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-yellow-100 text-yellow-700';

              return (
                <li key={wo}>
                  <button
                    onClick={() => toggleWO(wo)}
                    className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 hover:bg-slate-50 transition"
                  >
                    <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="font-mono font-bold text-slate-800 w-32 shrink-0">{wo}</span>
                    <CopyButton text={wo} />
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${sevColor}`}>{topSeverity}</span>
                    <span className="text-xs text-slate-500">{wFlags.length} flag{wFlags.length !== 1 ? 's' : ''}</span>
                    {equipment && (
                      <span className="text-[10px] text-slate-400 font-mono truncate max-w-[200px] ml-auto">{equipment}</span>
                    )}
                    <Icon name={isExpanded ? 'chevronUp' : 'chevronDown'} className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                  </button>

                  {isExpanded && (
                    <div className="border-t border-slate-100 divide-y divide-slate-100 bg-slate-50 animate-enter">
                      {wFlags.map((f, i) => {
                        const fSevColor =
                          f.severity === 'HIGH'
                            ? 'bg-red-100 text-red-700'
                            : f.severity === 'MEDIUM'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-yellow-100 text-yellow-700';
                        return (
                          <div key={i} className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2 mb-2">
                              {f.rowSeq != null && (
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                                  Row {f.rowSeq}
                                </span>
                              )}
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${fSevColor}`}>{f.severity}</span>
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                                {FLAG_CATEGORY_LABELS[f.category]}
                              </span>
                            </div>
                            <AIFlagDetailPanel flag={f} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
            {woGroups.length > 300 && (
              <li className="px-4 py-3 text-xs text-slate-400 italic">
                … and {woGroups.length - 300} more WOs.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function AIFlagDetailPanel({ flag }: { flag: AIFlag }) {
  return (
    <div className="space-y-2 py-1">
      <div className="bg-indigo-50 border border-indigo-100 rounded px-3 py-2 text-xs text-indigo-800">
        {flag.comment}
      </div>
      <div className="grid sm:grid-cols-3 gap-3 text-xs">
        {flag.equipment && (
          <div>
            <div className="text-[10px] font-bold uppercase text-slate-400 mb-0.5">Equipment</div>
            <div className="font-mono text-slate-700">{flag.equipment}</div>
          </div>
        )}
        <div className={flag.equipment ? 'sm:col-span-2' : 'sm:col-span-3'}>
          <div className="text-[10px] font-bold uppercase text-slate-400 mb-0.5">Description</div>
          <div className="text-slate-700">{flag.description || '—'}</div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase text-slate-400 mb-0.5">Codes</div>
          <div className="font-mono text-amber-700">{flag.codes || '—'}</div>
        </div>
        <div className="sm:col-span-2">
          <div className="text-[10px] font-bold uppercase text-slate-400 mb-0.5">Confirmation</div>
          <div className="text-slate-500">{flag.closure || '—'}</div>
        </div>
      </div>
      {flag.suggested && (
        <div className="px-3 py-2 bg-violet-50 border border-violet-200 rounded text-xs">
          <div className="font-bold text-violet-700 mb-1">Suggested catalog match</div>
          <div className="font-mono text-slate-700">
            {flag.suggested.object_part || '—'} → {flag.suggested.damage || '—'} →{' '}
            {flag.suggested.cause || '—'}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <button
      onClick={copy}
      title="Copy WO number"
      className="p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition shrink-0"
    >
      {copied
        ? <Icon name="check" className="w-3 h-3 text-green-500" />
        : <Icon name="copy" className="w-3 h-3" />}
    </button>
  );
}

function FilterChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-bold border transition ${
        active ? 'bg-brand-500 border-brand-500 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-brand-300'
      }`}
    >
      {label}
      <span className={`ml-1.5 ${active ? 'text-white/80' : 'text-slate-400'}`}>{count}</span>
    </button>
  );
}
