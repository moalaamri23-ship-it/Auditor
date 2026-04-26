import React, { useState, useMemo, useEffect } from 'react';
import Icon from './Icon';
import { useActiveRun, useStore } from '../store/useStore';
import { query } from '../services/DuckDBService';
import { RULE_CHECK_LABELS } from '../analysis/RuleChecksModule';
import { FLAG_CATEGORY_LABELS } from '../analysis/AITextModule';
import type {
  AIFlag, FlagCategory, ColumnMap, RuleCheckId, RuleCheckResult,
} from '../types';

type Tab = 'data' | 'rule-flags' | 'ai-flags';

// ─── Full-table WO data (Issue 4) ───────────────────────────────────────────

interface FullTableData {
  columns: string[];
  rows: Record<string, unknown>[];
}

async function loadFullWOData(): Promise<FullTableData> {
  // Get column list from audit table schema
  const schemaRows = await query(`DESCRIBE audit`);
  const columns = schemaRows
    .map((r: any) => String(r.column_name ?? ''))
    .filter((c) => !c.startsWith('_'));

  if (columns.length === 0) return { columns: [], rows: [] };

  const colExprs = columns.map((c) => `"${c}"`).join(', ');
  const rows = await query(`SELECT ${colExprs} FROM v_wo_primary LIMIT 5000`);
  return { columns, rows };
}

// ─── Curated 6-field WO detail (Issue 5 expand panel) ──────────────────────

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
  const { setScreen } = useStore();
  const [tab, setTab] = useState<Tab>('data');
  const [tableData, setTableData] = useState<FullTableData>({ columns: [], rows: [] });
  const [loadingWO, setLoadingWO] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (tab === 'data' && run?.hasDataInDB) {
      setLoadingWO(true);
      loadFullWOData()
        .then(setTableData)
        .catch(() => setTableData({ columns: [], rows: [] }))
        .finally(() => setLoadingWO(false));
    }
  }, [tab, run?.id, run?.hasDataInDB]);

  const filteredRows = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q || tableData.rows.length === 0) return tableData.rows;
    return tableData.rows.filter((r) =>
      Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  }, [tableData.rows, search]);

  if (!run) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">No active run.</div>
    );
  }

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

        <div className="flex border-b border-slate-200 mb-4">
          <TabButton active={tab === 'data'} onClick={() => setTab('data')}>
            WO Data <span className="ml-1 text-slate-400">({filteredRows.length})</span>
          </TabButton>
          <TabButton active={tab === 'rule-flags'} onClick={() => setTab('rule-flags')}>
            Rule Flags{' '}
            <span className="ml-1 text-slate-400">
              ({run.ruleChecks ? new Set(run.ruleChecks.flaggedWOs.map((f) => f.wo)).size : 0})
            </span>
          </TabButton>
          <TabButton active={tab === 'ai-flags'} onClick={() => setTab('ai-flags')}>
            AI Flags <span className="ml-1 text-slate-400">({run.aiFlags?.length ?? 0})</span>
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
          <RuleFlagsTab result={run.ruleChecks} columnMap={run.columnMap} hasDB={!!run.hasDataInDB} />
        )}
        {tab === 'ai-flags' && <AIFlagsTab flags={run.aiFlags ?? []} />}
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

// ─── DataTab — full raw table (Issue 4) ─────────────────────────────────────

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
                  {columns.map((col) => (
                    <td
                      key={col}
                      className="px-3 py-1.5 text-slate-700 border-r border-slate-100 font-mono max-w-[200px] truncate"
                      title={String(row[col] ?? '')}
                    >
                      {String(row[col] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── RuleFlagsTab — expandable rows (Issue 5) ────────────────────────────────

function RuleFlagsTab({
  result,
  columnMap,
  hasDB,
}: {
  result: RuleCheckResult;
  columnMap: ColumnMap;
  hasDB: boolean;
}) {
  const [filter, setFilter] = useState<RuleCheckId | 'ALL'>('ALL');
  const [expandedWO, setExpandedWO] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Map<string, WODetail | null>>(new Map());
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const ids = Object.keys(RULE_CHECK_LABELS) as RuleCheckId[];
  const filteredFlags = useMemo(() => {
    if (filter === 'ALL') return result.flaggedWOs;
    return result.flaggedWOs.filter((f) => f.checks.includes(filter));
  }, [result.flaggedWOs, filter]);

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
          count={result.flaggedWOs.length}
          onClick={() => setFilter('ALL')}
        />
        {ids.map((id) => {
          const c = result.perCheck[id]?.matched ?? 0;
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
        {filteredFlags.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">No work orders match this filter.</div>
        ) : (
          <ul className="divide-y divide-slate-100 max-h-[600px] overflow-auto scroll-thin">
            {filteredFlags.slice(0, 500).map((f) => {
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
            {filteredFlags.length > 500 && (
              <li className="px-4 py-3 text-xs text-slate-400 italic">
                … and {filteredFlags.length - 500} more.
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

// ─── AIFlagsTab ──────────────────────────────────────────────────────────────

function AIFlagsTab({ flags }: { flags: AIFlag[] }) {
  const [filter, setFilter] = useState<FlagCategory | 'ALL'>('ALL');

  const categories = Object.keys(FLAG_CATEGORY_LABELS) as FlagCategory[];
  const filtered = useMemo(() => {
    if (filter === 'ALL') return flags;
    return flags.filter((f) => f.category === filter);
  }, [flags, filter]);

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        <FilterChip active={filter === 'ALL'} label="All" count={flags.length} onClick={() => setFilter('ALL')} />
        {categories.map((c) => {
          const count = flags.filter((f) => f.category === c).length;
          if (count === 0) return null;
          return (
            <FilterChip
              key={c}
              active={filter === c}
              label={FLAG_CATEGORY_LABELS[c]}
              count={count}
              onClick={() => setFilter(c)}
            />
          );
        })}
      </div>

      <div className="space-y-3">
        {filtered.length === 0 && (
          <div className="bg-white border border-slate-200 rounded shadow-sm p-12 text-center text-slate-400 text-sm">
            No AI flags match this filter.
          </div>
        )}
        {filtered.slice(0, 200).map((f, i) => (
          <FlagCard key={`${f.woNumber}-${i}`} flag={f} />
        ))}
        {filtered.length > 200 && (
          <div className="text-xs text-slate-400 italic px-2">
            Showing first 200 of {filtered.length} flags.
          </div>
        )}
      </div>
    </div>
  );
}

function FlagCard({ flag }: { flag: AIFlag }) {
  const sevColor =
    flag.severity === 'HIGH'
      ? 'bg-red-100 text-red-700'
      : flag.severity === 'MEDIUM'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-yellow-100 text-yellow-700';
  return (
    <div className="bg-white border border-slate-200 rounded shadow-sm p-4 animate-enter">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold text-slate-800">{flag.woNumber}</span>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${sevColor}`}>
              {flag.severity}
            </span>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
              {FLAG_CATEGORY_LABELS[flag.category]}
            </span>
          </div>
          {flag.equipment && (
            <div className="text-xs text-slate-500 font-mono mt-0.5 truncate">{flag.equipment}</div>
          )}
        </div>
      </div>
      <p className="text-sm text-slate-700 mt-2">{flag.comment}</p>
      <div className="mt-3 grid sm:grid-cols-3 gap-3 text-xs">
        <Snapshot title="Description" body={flag.description} />
        <Snapshot title="Codes" body={flag.codes} mono />
        <Snapshot title="Confirmation" body={flag.closure} />
      </div>
      {flag.suggested && (
        <div className="mt-3 px-3 py-2 bg-violet-50 border border-violet-200 rounded text-xs">
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

function Snapshot({ title, body, mono }: { title: string; body?: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase text-slate-400">{title}</div>
      <div className={`text-slate-700 mt-0.5 line-clamp-3 ${mono ? 'font-mono' : ''}`}>
        {body && body.trim() ? body : <span className="italic text-slate-400">—</span>}
      </div>
    </div>
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
