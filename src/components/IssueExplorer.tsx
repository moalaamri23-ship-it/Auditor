import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Icon from './Icon';
import { useActiveSession, useStore } from '../store/useStore';
import { query } from '../services/DuckDBService';
import type { Anomaly, AnomalySeverity } from '../analysis/analysisTypes';
import type { AIFlag, FlagCategory, ColumnMap } from '../types';

// ─── Tab type ─────────────────────────────────────────────────────────────────

type Tab = 'data' | 'issues';

// ─── WO row (loaded from DuckDB) ─────────────────────────────────────────────

interface WORow {
  woNumber:  string;
  equipment: string;
  symptom:   string;   // WO description
  codes:     string;   // formatted: "FM: X | Cause: Y"
  closure:   string;   // confirmation short text
}

async function loadWOData(columnMap: ColumnMap): Promise<WORow[]> {
  const has = (c: string) => !!columnMap[c as keyof ColumnMap];

  // Build a formatted codes expression
  const codeParts: string[] = [];
  if (has('failure_mode'))     codeParts.push(`CASE WHEN failure_mode    <> '' THEN 'FM: '    || failure_mode    ELSE '' END`);
  if (has('cause_code'))       codeParts.push(`CASE WHEN cause_code       <> '' THEN 'Cause: ' || cause_code       ELSE '' END`);
  if (has('reliability_code_1')) codeParts.push(`CASE WHEN reliability_code_1 <> '' THEN 'RC1: '  || reliability_code_1 ELSE '' END`);
  if (has('reliability_code_2')) codeParts.push(`CASE WHEN reliability_code_2 <> '' THEN 'RC2: '  || reliability_code_2 ELSE '' END`);
  if (has('reliability_code_3')) codeParts.push(`CASE WHEN reliability_code_3 <> '' THEN 'RC3: '  || reliability_code_3 ELSE '' END`);

  const codesExpr = codeParts.length > 0
    ? `TRIM(BOTH ' | ' FROM ${codeParts.map(p => `(${p})`).join(` || ' | ' || `)})`
    : `''`;

  const rows = await query(`
    SELECT
      ${has('work_order_number')      ? 'COALESCE(work_order_number, \'\')' : "''"}      AS wo_number,
      ${has('equipment')              ? 'COALESCE(equipment, \'\')'          : "''"}      AS equipment,
      ${has('work_order_description') ? 'COALESCE(work_order_description, \'\')' : has('notification_description') ? 'COALESCE(notification_description, \'\')' : "''"}  AS symptom,
      ${codesExpr}                                                                         AS codes,
      ${has('confirmation_text')      ? 'COALESCE(confirmation_text, \'\')'  : "''"}      AS closure
    FROM v_analysis_scope
    ORDER BY wo_number
  `);

  return rows.map(r => ({
    woNumber:  String(r.wo_number  ?? '').trim(),
    equipment: String(r.equipment  ?? '').trim(),
    symptom:   String(r.symptom    ?? '').trim(),
    codes:     String(r.codes      ?? '').trim(),
    closure:   String(r.closure    ?? '').trim(),
  }));
}

// ─── Flag category metadata (inline — no import needed) ──────────────────────

const CAT_META: Record<FlagCategory, { label: string; short: string; color: string }> = {
  symptom_code_conflict:     { label: 'Symptom → Code',            short: 'S→C',  color: 'bg-red-100 text-red-700'     },
  symptom_closure_conflict:  { label: 'Symptom → Closure',         short: 'S→CL', color: 'bg-orange-100 text-orange-700' },
  code_closure_conflict:     { label: 'Code → Closure',            short: 'C→CL', color: 'bg-amber-100 text-amber-700'  },
  incomplete_classification: { label: 'Incomplete Classification',  short: 'CODES',color: 'bg-blue-100 text-blue-700'   },
  poor_closure:              { label: 'Poor Closure',               short: 'CLSR', color: 'bg-purple-100 text-purple-700'},
  generic_symptom:           { label: 'Generic Symptom',            short: 'GEN',  color: 'bg-slate-100 text-slate-600' },
};

const ALL_CATEGORIES = Object.keys(CAT_META) as FlagCategory[];

// ─── Main component ───────────────────────────────────────────────────────────

export default function IssueExplorer() {
  const session  = useActiveSession();
  const { setScreen } = useStore();
  const [activeTab, setActiveTab] = useState<Tab>('data');

  if (!session?.analysisResults) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        No analysis results. Run analysis from the Data Profiler screen.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Tab bar ── */}
      <div className="shrink-0 bg-white border-b border-slate-200 px-4 flex items-center gap-1 h-11">
        {([
          { id: 'data',   label: 'WO Data View', icon: 'table'      },
          { id: 'issues', label: 'DuckDB Issues', icon: 'alertTriangle' },
        ] as { id: Tab; label: string; icon: React.ComponentProps<typeof Icon>['name'] }[]).map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold transition ${
              activeTab === t.id
                ? 'bg-brand-600 text-white'
                : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            <Icon name={t.icon} className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'data'
          ? <WODataView session={session} />
          : <AnomalyListView session={session} />
        }
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// WO DATA VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function WODataView({ session }: { session: NonNullable<ReturnType<typeof useActiveSession>> }) {
  const [woRows,      setWoRows]      = useState<WORow[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [loadError,   setLoadError]   = useState<string | null>(null);
  const [search,      setSearch]      = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [catFilter,   setCatFilter]   = useState<FlagCategory | 'all'>('all');
  const [sevFilter,   setSevFilter]   = useState<'ALL' | 'HIGH' | 'MEDIUM' | 'LOW'>('ALL');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const { setScreen } = useStore();

  // ── Build flag map from persisted session flags ───────────────────────────
  const flagMap = useMemo(() => {
    const map = new Map<string, AIFlag[]>();
    for (const f of session.aiFlags ?? []) {
      const arr = map.get(f.woNumber) ?? [];
      arr.push(f);
      map.set(f.woNumber, arr);
    }
    return map;
  }, [session.aiFlags]);

  // ── Load WO rows from DuckDB ──────────────────────────────────────────────
  useEffect(() => {
    if (!session.hasDataInDuckDB || !session.columnMap) return;
    setLoading(true);
    setLoadError(null);
    loadWOData(session.columnMap)
      .then(setWoRows)
      .catch(e => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [session.hasDataInDuckDB, session.id]);

  // ── Filter ────────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return woRows.filter(r => {
      const flags = flagMap.get(r.woNumber) ?? [];
      if (flaggedOnly && flags.length === 0) return false;
      if (catFilter !== 'all' && !flags.some(f => f.category === catFilter)) return false;
      if (sevFilter !== 'ALL' && !flags.some(f => f.severity === sevFilter)) return false;
      if (q && !r.woNumber.toLowerCase().includes(q)
            && !r.equipment.toLowerCase().includes(q)
            && !r.symptom.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [woRows, flagMap, flaggedOnly, catFilter, sevFilter, search]);

  const flaggedCount = useMemo(() => woRows.filter(r => flagMap.has(r.woNumber)).length, [woRows, flagMap]);

  // ── Virtualizer ───────────────────────────────────────────────────────────
  const parentRef = useRef<HTMLDivElement>(null);

  const estimateSize = useCallback((index: number) => {
    const r = filtered[index];
    const expanded = expandedKey === r.woNumber;
    return expanded ? 240 : 52;
  }, [filtered, expandedKey]);

  const virtualizer = useVirtualizer({
    count:       filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan:    10,
  });

  // ── No DuckDB data ────────────────────────────────────────────────────────
  if (!session.hasDataInDuckDB) {
    // If we at least have persisted AI flags, show them
    const flags = session.aiFlags ?? [];
    if (flags.length > 0) {
      return (
        <div className="flex flex-col h-full">
          <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 text-xs text-amber-700 flex items-center gap-2">
            <Icon name="alertTriangle" className="w-4 h-4 shrink-0" />
            DuckDB data not loaded — showing persisted AI flags only. Re-upload to see all WO rows.
            <button onClick={() => setScreen('upload')} className="font-bold underline ml-1">Re-upload →</button>
          </div>
          <FlagsOnlyView flags={flags} />
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
        <Icon name="database" className="w-10 h-10" />
        <div className="text-sm">File not loaded — re-upload to view data rows.</div>
        <button onClick={() => setScreen('upload')}
          className="bg-slate-900 text-white px-4 py-2 rounded text-sm font-bold">Re-upload File</button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
        <div className="flex gap-2">
          {[0,1,2].map(i => <div key={i} className="w-2 h-2 bg-brand-500 rounded-full animate-bounce" style={{ animationDelay: `${i*150}ms` }} />)}
        </div>
        <div className="text-sm">Loading work orders from DuckDB…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-red-500 text-sm">
        <Icon name="alertCircle" className="w-8 h-8" />
        <div>{loadError}</div>
      </div>
    );
  }

  const hasAIFlags = (session.aiFlags?.length ?? 0) > 0;

  return (
    <div className="flex flex-col h-full">

      {/* ── Stats strip ── */}
      <div className="shrink-0 px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-6 text-xs">
        <span className="text-slate-500">
          <span className="font-bold font-mono text-slate-900">{woRows.length.toLocaleString()}</span> WOs in scope
        </span>
        {hasAIFlags && (
          <span className="text-slate-500">
            <span className="font-bold font-mono text-slate-900">{flaggedCount.toLocaleString()}</span> flagged by AI
            <span className="text-slate-400 ml-1">({Math.round(flaggedCount / woRows.length * 100)}%)</span>
          </span>
        )}
        {!hasAIFlags && (
          <span className="text-amber-600 flex items-center gap-1">
            <Icon name="alertTriangle" className="w-3.5 h-3.5" />
            No AI flags — run analysis with an AI key configured
          </span>
        )}
        <span className="ml-auto text-slate-400 font-mono">{filtered.length.toLocaleString()} shown</span>
      </div>

      {/* ── Filter bar ── */}
      <div className="shrink-0 px-4 py-2 bg-white border-b border-slate-200 flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative">
          <Icon name="search" className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1.5" />
          <input
            type="text"
            placeholder="Search WO, equipment, description…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-7 pr-3 py-1 text-xs border border-slate-200 rounded outline-none focus:border-brand-500 w-64"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1.5 text-slate-400 hover:text-slate-600">
              <Icon name="xCircle" className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="h-4 w-px bg-slate-200" />

        {/* Flagged only toggle */}
        <button
          onClick={() => setFlaggedOnly(v => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-bold transition ${
            flaggedOnly ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Icon name="wand" className="w-3 h-3" />
          Flagged only
        </button>

        {/* Category chips */}
        <button
          onClick={() => setCatFilter('all')}
          className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${catFilter === 'all' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}
        >All
        </button>
        {ALL_CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setCatFilter(catFilter === cat ? 'all' : cat)}
            className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${catFilter === cat ? `${CAT_META[cat].color} border-transparent` : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}
          >
            {CAT_META[cat].short}
          </button>
        ))}

        <div className="h-4 w-px bg-slate-200" />

        {/* Severity */}
        {(['ALL', 'HIGH', 'MEDIUM', 'LOW'] as const).map(s => (
          <button
            key={s}
            onClick={() => setSevFilter(s)}
            className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${sevFilter === s ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* ── Table header ── */}
      <div className="shrink-0 grid text-[10px] font-bold uppercase text-slate-400 bg-slate-50 border-b border-slate-200 px-4 py-2"
        style={{ gridTemplateColumns: '140px 130px 1fr 180px 200px 180px' }}>
        <div>WO Number</div>
        <div>Equipment</div>
        <div>Symptom</div>
        <div>Classification</div>
        <div>Closure</div>
        <div>AI Flags</div>
      </div>

      {/* ── Virtualised rows ── */}
      {filtered.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-slate-400 text-sm">
          No work orders match the current filters.
        </div>
      ) : (
        <div ref={parentRef} className="flex-1 overflow-y-auto scroll-thin">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(vrow => {
              const r     = filtered[vrow.index];
              const flags = flagMap.get(r.woNumber) ?? [];
              const open  = expandedKey === r.woNumber;

              return (
                <div
                  key={r.woNumber}
                  data-index={vrow.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vrow.start}px)` }}
                >
                  {/* ── Collapsed row ── */}
                  <button
                    onClick={() => setExpandedKey(open ? null : r.woNumber)}
                    className={`w-full grid items-start px-4 py-2.5 text-left border-b border-slate-100 transition hover:bg-slate-50 ${open ? 'bg-brand-50' : ''}`}
                    style={{ gridTemplateColumns: '140px 130px 1fr 180px 200px 180px' }}
                  >
                    {/* WO # */}
                    <div className="font-mono text-xs font-bold text-slate-800 truncate pr-2">{r.woNumber}</div>
                    {/* Equipment */}
                    <div className="text-xs text-slate-600 truncate pr-2">{r.equipment || <span className="text-slate-300">—</span>}</div>
                    {/* Symptom */}
                    <div className="text-xs text-slate-700 truncate pr-3">{r.symptom || <span className="text-slate-300 italic">no description</span>}</div>
                    {/* Classification */}
                    <div className="text-[10px] font-mono text-slate-500 truncate pr-2">{r.codes || <span className="text-slate-300">— no codes —</span>}</div>
                    {/* Closure */}
                    <div className="text-xs text-slate-500 italic truncate pr-2">{r.closure || <span className="text-slate-300 not-italic">—</span>}</div>
                    {/* Flags */}
                    <div className="flex flex-wrap gap-1">
                      {flags.length === 0
                        ? <span className="text-[10px] text-slate-300">—</span>
                        : flags.map((f, i) => (
                            <span key={i} className={`text-[9px] font-bold px-1 py-0.5 rounded ${CAT_META[f.category]?.color ?? 'bg-slate-100 text-slate-500'}`}>
                              {CAT_META[f.category]?.short ?? f.category}
                            </span>
                          ))
                      }
                    </div>
                  </button>

                  {/* ── Expanded detail ── */}
                  {open && (
                    <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 animate-enter">
                      {/* Artefact cards */}
                      <div className="grid grid-cols-3 gap-3 mb-3">
                        <div className="border-2 border-amber-400 bg-amber-50 rounded p-3">
                          <div className="text-[10px] font-bold uppercase text-amber-600 mb-1">Symptom</div>
                          <div className="text-xs text-slate-700 leading-relaxed">{r.symptom || <span className="italic text-slate-400">No description</span>}</div>
                        </div>
                        <div className="border-2 border-blue-400 bg-blue-50 rounded p-3">
                          <div className="text-[10px] font-bold uppercase text-blue-600 mb-1">Classification</div>
                          <div className="text-xs font-mono text-slate-700">{r.codes || <span className="italic text-slate-400 font-sans">No codes assigned</span>}</div>
                        </div>
                        <div className="border-2 border-purple-400 bg-purple-50 rounded p-3">
                          <div className="text-[10px] font-bold uppercase text-purple-600 mb-1">Closure</div>
                          <div className="text-xs text-slate-700 italic">{r.closure || <span className="text-slate-400">No confirmation</span>}</div>
                        </div>
                      </div>
                      {/* AI findings */}
                      {flags.length > 0 ? (
                        <div className="space-y-1.5">
                          {flags.map((f, i) => (
                            <div key={i} className="flex items-start gap-2 bg-white border border-slate-200 rounded px-3 py-2 text-xs">
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 ${CAT_META[f.category]?.color}`}>
                                {f.severity}
                              </span>
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${CAT_META[f.category]?.color}`}>
                                {CAT_META[f.category]?.label}
                              </span>
                              <span className="text-slate-700">{f.comment}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
                          <Icon name="checkCircle" className="w-3.5 h-3.5 shrink-0" />
                          No AI flags for this work order.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Flags-only view (when DuckDB not loaded but flags persisted) ─────────────

function FlagsOnlyView({ flags }: { flags: AIFlag[] }) {
  const [expandedWO, setExpandedWO] = useState<string | null>(null);

  // Group flags by WO
  const byWO = useMemo(() => {
    const map = new Map<string, AIFlag[]>();
    for (const f of flags) {
      const arr = map.get(f.woNumber) ?? [];
      arr.push(f);
      map.set(f.woNumber, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [flags]);

  return (
    <div className="overflow-y-auto scroll-thin flex-1 divide-y divide-slate-100">
      {byWO.map(([wo, woFlags]) => {
        const open = expandedWO === wo;
        const first = woFlags[0];
        return (
          <div key={wo}>
            <button onClick={() => setExpandedWO(open ? null : wo)}
              className="w-full flex items-start gap-3 px-4 py-3 hover:bg-slate-50 text-left">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-bold text-slate-800">{wo}</span>
                  {first.equipment && <span className="text-xs text-slate-500">{first.equipment}</span>}
                </div>
                {first.symptom && <div className="text-xs text-slate-500 mt-0.5 truncate">{first.symptom}</div>}
              </div>
              <div className="flex flex-wrap gap-1 shrink-0">
                {woFlags.map((f, i) => (
                  <span key={i} className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${CAT_META[f.category]?.color}`}>
                    {CAT_META[f.category]?.short}
                  </span>
                ))}
              </div>
              <Icon name={open ? 'chevronUp' : 'chevronDown'} className="w-4 h-4 text-slate-400 shrink-0" />
            </button>
            {open && (
              <div className="px-4 pb-3 bg-slate-50 border-t border-slate-100 animate-enter space-y-1.5">
                <div className="grid grid-cols-3 gap-3 mt-3 mb-3">
                  <div className="border-2 border-amber-300 bg-amber-50 rounded p-3">
                    <div className="text-[10px] font-bold uppercase text-amber-600 mb-1">Symptom</div>
                    <div className="text-xs text-slate-700">{first.symptom || '—'}</div>
                  </div>
                  <div className="border-2 border-blue-300 bg-blue-50 rounded p-3">
                    <div className="text-[10px] font-bold uppercase text-blue-600 mb-1">Classification</div>
                    <div className="text-xs font-mono text-slate-700">{first.codes || '— no codes —'}</div>
                  </div>
                  <div className="border-2 border-purple-300 bg-purple-50 rounded p-3">
                    <div className="text-[10px] font-bold uppercase text-purple-600 mb-1">Closure</div>
                    <div className="text-xs italic text-slate-700">{first.closure || '—'}</div>
                  </div>
                </div>
                {woFlags.map((f, i) => (
                  <div key={i} className="flex items-start gap-2 bg-white border border-slate-200 rounded px-3 py-2 text-xs">
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 ${CAT_META[f.category]?.color}`}>{f.severity}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${CAT_META[f.category]?.color}`}>{CAT_META[f.category]?.label}</span>
                    <span className="text-slate-700">{f.comment}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANOMALY LIST VIEW (existing DuckDB issues — preserved)
// ═══════════════════════════════════════════════════════════════════════════════

type SeverityFilter = 'ALL' | AnomalySeverity;
type ModuleFilter   = 'ALL' | string;

function AnomalyListView({ session }: { session: NonNullable<ReturnType<typeof useActiveSession>> }) {
  const results = session.analysisResults!;

  const [selectedId,     setSelectedId]     = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL');
  const [moduleFilter,   setModuleFilter]   = useState<ModuleFilter>('ALL');
  const [search,         setSearch]         = useState('');

  const allAnomalies = useMemo(() =>
    results.modules.flatMap(m =>
      m.anomalies.map(a => ({ ...a, moduleName: m.moduleName }))
    ).sort((a, b) => b.score - a.score),
    [results]
  );

  const filtered = useMemo(() => allAnomalies.filter(a => {
    if (severityFilter !== 'ALL' && a.severity !== severityFilter) return false;
    if (moduleFilter   !== 'ALL' && a.moduleId  !== moduleFilter)  return false;
    if (search && !a.label.toLowerCase().includes(search.toLowerCase())
               && !a.description.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [allAnomalies, severityFilter, moduleFilter, search]);

  const selected = filtered.find(a => a.id === selectedId) ?? filtered[0] ?? null;
  const modules  = results.modules.map(m => ({ id: m.moduleId, name: m.moduleName }));

  return (
    <div className="flex h-full">
      {/* Left: list */}
      <div className="w-96 border-r border-slate-200 flex flex-col shrink-0">
        <div className="p-3 border-b border-slate-200 bg-slate-50 space-y-2">
          <div className="relative">
            <Icon name="search" className="w-4 h-4 text-slate-400 absolute left-2.5 top-2" />
            <input type="text" placeholder="Search issues…" value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded outline-none focus:border-brand-500 bg-white" />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {(['ALL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as SeverityFilter[]).map(sv => (
              <button key={sv} onClick={() => setSeverityFilter(sv)}
                className={`px-2 py-0.5 rounded-full border text-[10px] font-bold transition ${severityFilter === sv ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'}`}>
                {sv}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <button onClick={() => setModuleFilter('ALL')}
              className={`px-2 py-0.5 rounded-full border text-[10px] font-bold transition ${moduleFilter === 'ALL' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200'}`}>
              All Modules
            </button>
            {modules.map(m => (
              <button key={m.id} onClick={() => setModuleFilter(m.id)}
                className={`px-2 py-0.5 rounded-full border text-[10px] font-bold transition ${moduleFilter === m.id ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200'}`}>
                {m.name.split(' ')[0]}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-slate-400">{filtered.length} of {allAnomalies.length} issues</div>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin divide-y divide-slate-100">
          {filtered.length === 0 && <div className="p-6 text-center text-slate-400 text-sm">No issues match.</div>}
          {filtered.map(a => (
            <button key={a.id} onClick={() => setSelectedId(a.id)}
              className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${selected?.id === a.id ? 'bg-brand-50 border-r-2 border-brand-600' : 'hover:bg-slate-50'}`}>
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

      {/* Right: detail */}
      <div className="flex-1 overflow-auto scroll-thin p-6">
        {selected ? <IssueDetail anomaly={selected} /> : (
          <div className="flex items-center justify-center h-full text-slate-400 text-sm">Select an issue to view details.</div>
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
      <div className="flex items-start gap-3">
        <SeverityBadge severity={a.severity} />
        <div>
          <h2 className="text-xl font-bold text-slate-900">{a.label}</h2>
          <div className="text-xs text-slate-400 mt-0.5">{(a as any).moduleName} · <span className="font-mono">{a.type}</span></div>
        </div>
      </div>
      <div className="bg-white rounded shadow border border-slate-200 p-5">
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-3">Impact</div>
        <div className="flex gap-6">
          <div><div className="text-3xl font-bold font-mono text-slate-900">{a.affectedCount.toLocaleString()}</div><div className="text-xs text-slate-400">affected WOs</div></div>
          <div><div className="text-3xl font-bold font-mono text-slate-900">{pct}%</div><div className="text-xs text-slate-400">of total ({a.totalCount.toLocaleString()})</div></div>
          <div><div className="text-3xl font-bold font-mono text-slate-900">{a.score}</div><div className="text-xs text-slate-400">score /100</div></div>
        </div>
        <div className="mt-3 h-2 bg-slate-100 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${a.severity === 'HIGH' ? 'bg-red-500' : a.severity === 'MEDIUM' ? 'bg-amber-400' : 'bg-yellow-300'}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="bg-white rounded shadow border border-slate-200 p-5">
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-2">Finding</div>
        <p className="text-sm text-slate-700 leading-relaxed">{a.description}</p>
      </div>
      <div className="bg-white rounded shadow border border-slate-200 p-5">
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-2 flex items-center gap-1.5">
          <Icon name="database" className="w-3.5 h-3.5" />SQL Logic (DuckDB — no AI)
        </div>
        <div className="font-mono text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded px-3 py-3 whitespace-pre-wrap">{a.sqlBasis}</div>
      </div>
      {a.samples.length > 0 && (
        <div className="bg-white rounded shadow border border-slate-200 p-5">
          <div className="text-[10px] font-bold uppercase text-slate-400 mb-3">Samples ({a.samples.length} of {a.affectedCount})</div>
          <div className="space-y-2">
            {a.samples.map((s, i) => (
              <div key={i} className="flex flex-wrap gap-3 text-xs bg-slate-50 border border-slate-200 rounded px-3 py-2">
                {s.wo        && <span className="font-mono font-bold text-slate-800">{s.wo}</span>}
                {s.equipment && <><span className="text-slate-300">|</span><span className="text-slate-600">{s.equipment}</span></>}
                {s.description && <><span className="text-slate-300">|</span><span className="text-slate-500 italic truncate max-w-xs">{s.description}</span></>}
                {s.value     && <><span className="text-slate-300">|</span><span className="font-mono text-slate-700">{s.value}</span></>}
                {s.flag      && <span className="ml-auto text-amber-600 font-bold">{s.flag}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

function SeverityDot({ severity }: { severity: string }) {
  const cls = severity === 'HIGH' ? 'bg-red-500' : severity === 'MEDIUM' ? 'bg-amber-400' : severity === 'LOW' ? 'bg-yellow-300' : 'bg-slate-300';
  return <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${cls}`} />;
}

function SeverityBadge({ severity }: { severity: string }) {
  const cls = severity === 'HIGH' ? 'bg-red-100 text-red-700' : severity === 'MEDIUM' ? 'bg-amber-100 text-amber-700' : severity === 'LOW' ? 'bg-yellow-100 text-yellow-700' : 'bg-slate-100 text-slate-500';
  return <span className={`text-xs font-bold px-2.5 py-1 rounded shrink-0 ${cls}`}>{severity}</span>;
}
