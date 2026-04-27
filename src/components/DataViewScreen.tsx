import React, { useState, useMemo, useEffect } from 'react';
import Icon from './Icon';
import FilterPanel from './FilterPanel';
import { useActiveRun, useActiveProject, useStore } from '../store/useStore';
import {
  query, getFilterOptions, getLiveScopeCount, getCascadingFilterOptions,
  createAnalysisScopeView,
} from '../services/DuckDBService';
import type { AnalysisFilters, FilterOptions, ColumnMap } from '../types';
import { EMPTY_FILTERS } from '../types';
import { TIMESTAMP_COLUMNS } from '../constants';
import { useRunAutoRestore } from '../hooks/useRunAutoRestore';

// ─── Date / cell formatter (mirrors IssueExplorer) ───────────────────────────

function fmtCell(col: string, value: unknown, columnMap?: ColumnMap): string {
  const raw = String(value ?? '');
  if (!raw) return '';
  const isTimestamp = (() => {
    if ((TIMESTAMP_COLUMNS as readonly string[]).includes(col)) return true;
    if (columnMap) {
      const canonical = Object.entries(columnMap).find(([, rawName]) => rawName === col)?.[0];
      if (canonical && (TIMESTAMP_COLUMNS as readonly string[]).includes(canonical)) return true;
    }
    return false;
  })();
  if (isTimestamp) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
    }
    const parts = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-."](\d{2,4})$/);
    if (parts) {
      return `${parts[1].padStart(2, '0')}/${parts[2].padStart(2, '0')}/${parts[3]}`;
    }
  }
  return raw;
}

// ─── Full-table load ──────────────────────────────────────────────────────────

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

// ─── Main component ───────────────────────────────────────────────────────────

export default function DataViewScreen() {
  const run = useActiveRun();
  const project = useActiveProject();
  const { setScreen } = useStore();
  useRunAutoRestore(run ?? null);

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

  // Load WO data once on mount
  useEffect(() => {
    if (!run?.hasDataInDB) return;
    setLoadingWO(true);
    loadFullWOData()
      .then(setTableData)
      .catch(() => setTableData({ columns: [], rows: [] }))
      .finally(() => setLoadingWO(false));
  }, [run?.id, run?.hasDataInDB]);

  // ── Filtered rows ───────────────────────────────────────────────────────────
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

  if (!run) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">No active run.</div>
    );
  }

  const totalWOs = run.dataProfile?.distinctWOs ?? 0;

  return (
    <div className="max-w-full px-6 py-6">
      <div className="max-w-7xl mx-auto">
        {/* Page header */}
        <div className="flex items-end justify-between flex-wrap gap-3 mb-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">DATA View</h1>
            <p className="text-sm text-slate-500 mt-1">
              Scoped raw work-order data table — apply filters to narrow down the records.
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

        {/* Raw data table */}
        {!run.hasDataInDB ? (
          <div className="bg-white border border-slate-200 rounded shadow-sm p-12 text-center text-slate-400 text-sm">
            Re-upload your file to view raw data — the in-memory database is cleared on page refresh.
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded shadow-sm">
            <div className="p-3 border-b border-slate-200 flex items-center gap-2">
              <Icon name="search" className="w-4 h-4 text-slate-400 shrink-0" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search any column…"
                className="flex-1 outline-none text-sm"
              />
              <span className="text-xs text-slate-400 shrink-0">{filteredRows.length} rows</span>
            </div>

            {loadingWO ? (
              <div className="p-12 text-center text-slate-400 text-sm">Loading…</div>
            ) : filteredRows.length === 0 ? (
              <div className="p-12 text-center text-slate-400 text-sm">No matching work orders.</div>
            ) : (
              <div className="overflow-auto scroll-thin" style={{ maxHeight: 'calc(100vh - 320px)' }}>
                <table className="text-xs w-max min-w-full">
                  <thead className="sticky top-0 bg-slate-50 z-10">
                    <tr>
                      {tableData.columns.map((col) => (
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
                    {filteredRows.map((row, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        {tableData.columns.map((col) => (
                          <td
                            key={col}
                            className="px-3 py-1.5 text-slate-700 border-r border-slate-100 font-mono max-w-[200px] truncate"
                            title={fmtCell(col, row[col], run.columnMap)}
                          >
                            {fmtCell(col, row[col], run.columnMap)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
