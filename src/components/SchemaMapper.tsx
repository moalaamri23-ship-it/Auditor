import React, { useState, useCallback } from 'react';
import Icon from './Icon';
import { useStore, useActiveRun, useRunsForProject } from '../store/useStore';
import { ParsedDataCache } from '../services/ParsedDataCache';
import { loadData, runProfiling, restoreAIFlagsFromRun, query } from '../services/DuckDBService';
import { ensureCatalogLoaded } from '../services/FailureCatalogService';
import { saveRunData } from '../services/IndexedDBService';
import type { AuditPeriod, CanonicalColumn, ColumnMap, DataProfile, AnalysisFilters } from '../types';
import { EMPTY_FILTERS } from '../types';
import {
  COLUMN_LABELS,
  IDENTIFIER_COLUMNS,
  TIMESTAMP_COLUMNS,
  TEXT_COLUMNS,
  CODE_DESCRIPTION_COLUMNS,
} from '../constants';

const STATUS_COLUMNS_NONE: CanonicalColumn[] = []; // no status fields in new schema
const TEXT_NON_CODE: CanonicalColumn[] = TEXT_COLUMNS.filter(
  (c) => !CODE_DESCRIPTION_COLUMNS.includes(c) && c !== 'code_group',
);

const COLUMN_GROUPS: { label: string; cols: CanonicalColumn[] }[] = [
  { label: 'Identifiers', cols: IDENTIFIER_COLUMNS },
  { label: 'Date', cols: TIMESTAMP_COLUMNS },
  { label: 'Description & Equipment', cols: ['work_order_description', 'work_center', 'equipment_description', 'functional_location_description', 'operation_description'] as CanonicalColumn[] },
  { label: 'Failure Codes (Description Form)', cols: CODE_DESCRIPTION_COLUMNS },
  { label: 'Confirmation', cols: ['confirmation_text', 'confirmation_long_text'] as CanonicalColumn[] },
  { label: 'Scoping Template', cols: ['code_group'] as CanonicalColumn[] },
];

type LoadStage = 'idle' | 'loading' | 'profiling' | 'done' | 'error';

const PERIOD_DAYS: Record<AuditPeriod, number> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
  QUARTERLY: 91,
  YEARLY: 365,
};

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function computeAutoFilters(
  profile: DataProfile,
  columnMap: ColumnMap,
  prevDateMax: string | null,
  period: AuditPeriod,
): Promise<AnalysisFilters | null> {
  if (!columnMap.notification_date) return null;

  if (prevDateMax) {
    const candidateFrom = addDays(prevDateMax, 1);
    try {
      const [row] = await query(
        `SELECT COUNT(*) AS cnt FROM audit WHERE notification_date >= '${candidateFrom}'::DATE`
      );
      if (Number(row?.cnt ?? 0) > 0) {
        return { ...EMPTY_FILTERS, dateFrom: candidateFrom, dateTo: null };
      }
    } catch { /* fall through */ }
  }

  // Fall back to last <period> of new data
  if (profile.dateRange?.max) {
    const dateFrom = addDays(profile.dateRange.max, -PERIOD_DAYS[period]);
    return { ...EMPTY_FILTERS, dateFrom, dateTo: profile.dateRange.max };
  }

  return null;
}

export default function SchemaMapper() {
  const run = useActiveRun();
  const { updateRun, setScreen, projects } = useStore();
  const projectRuns = useRunsForProject(run?.projectId ?? null);

  const [localMap, setLocalMap] = useState<ColumnMap>(run?.columnMap ?? {});
  const [loadStage, setLoadStage] = useState<LoadStage>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  if (!run) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        No active audit run.
      </div>
    );
  }

  const cachedData = ParsedDataCache.get(run.id);
  const availableHeaders: string[] = cachedData?.headers ?? [];

  const setMapping = (canonical: CanonicalColumn, rawHeader: string) => {
    setLocalMap((prev) => ({ ...prev, [canonical]: rawHeader || undefined }));
  };

  const handleLoad = useCallback(async () => {
    if (!cachedData) {
      setErrorMsg('File data is no longer cached. Please re-upload the file.');
      setLoadStage('error');
      return;
    }

    setLoadStage('loading');
    setErrorMsg('');

    try {
      updateRun(run.id, { columnMap: localMap, stage: 'mapped' });

      await loadData(cachedData.rows, localMap);

      // Persist raw data to IndexedDB so cold reloads don't require re-upload
      saveRunData(run.id, cachedData.rows, localMap).catch(() => {});

      // Ensure catalog is loaded for catalog-aware checks downstream
      await ensureCatalogLoaded().catch(() => {});

      if (run.aiFlags?.length > 0) {
        await restoreAIFlagsFromRun(run.aiFlags).catch(() => {});
      }

      setLoadStage('profiling');
      const profile = await runProfiling(localMap);

      // Auto-compute date filters based on previous run (Issue 9)
      const project = projects.find((p) => p.id === run.projectId);
      const prevRun = projectRuns
        .filter((r) => r.id !== run.id && r.stage === 'analysed' && r.dataProfile?.dateRange)
        .sort((a, b) => b.runIndex - a.runIndex)[0] ?? null;

      let autoFilters: AnalysisFilters | null = null;
      if (project && prevRun?.dataProfile?.dateRange) {
        autoFilters = await computeAutoFilters(
          profile,
          localMap,
          prevRun.dataProfile.dateRange.max,
          project.period,
        ).catch(() => null);
      } else if (project && !prevRun && profile.dateRange?.max) {
        // First run of a periodic project — default to last period of data
        const dateFrom = addDays(profile.dateRange.max, -PERIOD_DAYS[project.period]);
        autoFilters = { ...EMPTY_FILTERS, dateFrom, dateTo: profile.dateRange.max };
      }

      updateRun(run.id, {
        dataProfile: profile,
        stage: 'profiled',
        hasDataInDB: true,
        lastAnalysedAt: new Date().toISOString(),
        ...(autoFilters ? { analysisFilters: autoFilters } : {}),
      });

      ParsedDataCache.clear();

      setLoadStage('done');
      setScreen('profiler');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load data into the Database.');
      setLoadStage('error');
    }
  }, [cachedData, localMap, run.id, run.projectId, run.aiFlags, projects, projectRuns, updateRun, setScreen]);

  const mappedCount = Object.values(localMap).filter(Boolean).length;
  const totalCols = Object.keys(COLUMN_LABELS).length;

  if (loadStage === 'loading' || loadStage === 'profiling') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-6">
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="w-2.5 h-2.5 bg-brand-500 rounded-full animate-bounce"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
        <div className="text-center">
          <div className="font-semibold text-slate-700">
            {loadStage === 'loading' && 'Loading data into the Database…'}
            {loadStage === 'profiling' && 'Running data profiling queries…'}
          </div>
          <div className="text-xs text-slate-400 mt-1">This runs entirely in your browser.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Review Column Mapping</h1>
        <p className="text-sm text-slate-500 mt-1">
          The system has detected your SAP column names. Review and adjust before loading.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <div className="text-xs font-bold text-slate-500">
            {mappedCount} / {totalCols} columns mapped
          </div>
          {availableHeaders.length === 0 && (
            <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
              File data not in cache — re-upload to enable dropdowns
            </span>
          )}
        </div>
      </div>

      <div className="space-y-6 mb-8">
        {COLUMN_GROUPS.map((group) => (
          <div key={group.label} className="bg-white rounded shadow border border-slate-200 overflow-hidden">
            <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
              <div className="text-xs font-bold uppercase text-slate-500">{group.label}</div>
            </div>
            <div className="divide-y divide-slate-100">
              {group.cols.map((canonical) => (
                <ColumnRow
                  key={canonical}
                  canonical={canonical}
                  currentValue={localMap[canonical] ?? ''}
                  headers={availableHeaders}
                  onChange={(v) => setMapping(canonical, v)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {loadStage === 'error' && errorMsg && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex gap-3">
          <Icon name="alertCircle" className="w-5 h-5 text-red-500 shrink-0" />
          <div className="text-sm text-red-700">{errorMsg}</div>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => setScreen('upload')}
          className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded font-bold flex items-center gap-2 hover:bg-slate-50 transition text-sm"
        >
          <Icon name="arrowLeft" className="w-4 h-4" />
          Back
        </button>

        <button
          onClick={handleLoad}
          disabled={(loadStage as string) === 'loading' || (loadStage as string) === 'profiling'}
          className="bg-slate-900 text-white px-6 py-2 rounded font-bold flex items-center gap-2 hover:bg-slate-800 transition text-sm disabled:opacity-50"
        >
          <Icon name="database" className="w-4 h-4" />
          Load &amp; Profile Data
        </button>
      </div>

      <p className="mt-3 text-xs text-slate-400">
        Confirming this mapping loads your data into the Database. Profiling starts immediately.
      </p>
    </div>
  );
}

function ColumnRow({
  canonical,
  currentValue,
  headers,
  onChange,
}: {
  canonical: CanonicalColumn;
  currentValue: string;
  headers: string[];
  onChange: (v: string) => void;
}) {
  const label = COLUMN_LABELS[canonical];
  const isMapped = !!currentValue;

  const category = IDENTIFIER_COLUMNS.includes(canonical)
    ? 'id'
    : TIMESTAMP_COLUMNS.includes(canonical)
      ? 'date'
      : CODE_DESCRIPTION_COLUMNS.includes(canonical)
        ? 'code'
        : canonical === 'code_group'
          ? 'scope'
          : TEXT_NON_CODE.includes(canonical)
            ? 'text'
            : 'status';

  const CATEGORY_BADGE: Record<string, string> = {
    id: 'bg-blue-100 text-blue-700',
    date: 'bg-purple-100 text-purple-700',
    text: 'bg-teal-100 text-teal-700',
    code: 'bg-amber-100 text-amber-700',
    scope: 'bg-violet-100 text-violet-700',
    status: 'bg-slate-100 text-slate-600',
  };

  const REQUIRED_COLS: CanonicalColumn[] = ['work_order_number', 'work_order_description', 'notification_date'];
  const isRequired = REQUIRED_COLS.includes(canonical);

  return (
    <div className="flex items-center px-4 py-3 gap-4">
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isMapped ? 'bg-green-400' : 'bg-slate-300'}`} />
      <div className="w-56 shrink-0">
        <div className="text-sm font-semibold text-slate-700">
          {label}
          {isRequired && <span className="text-red-500 ml-1">*</span>}
        </div>
        <div className="text-[10px] font-mono text-slate-400">{canonical}</div>
      </div>
      <div className="w-16 shrink-0">
        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${CATEGORY_BADGE[category]}`}>
          {category}
        </span>
      </div>
      <div className="flex-1">
        {headers.length > 0 ? (
          <select
            value={currentValue}
            onChange={(e) => onChange(e.target.value)}
            className="w-full border border-slate-200 rounded px-3 py-1.5 text-sm font-mono outline-none focus:border-brand-500 bg-white"
          >
            <option value="">— not mapped —</option>
            {headers.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={currentValue}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Enter column name manually…"
            className="w-full border border-slate-200 rounded px-3 py-1.5 text-sm font-mono outline-none focus:border-brand-500"
          />
        )}
      </div>
    </div>
  );
}

// `STATUS_COLUMNS_NONE` retained for future expansion / compatibility.
export { STATUS_COLUMNS_NONE };
