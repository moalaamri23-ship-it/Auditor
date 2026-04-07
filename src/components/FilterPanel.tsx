import React, { useState, useRef, useEffect, useMemo } from 'react';
import Icon from './Icon';
import type { AnalysisFilters, FilterOptions, ColumnMap } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// FilterPanel
// ─────────────────────────────────────────────────────────────────────────────

interface FilterPanelProps {
  filters: AnalysisFilters;
  options: FilterOptions;
  columnMap: ColumnMap;
  totalWOs: number;           // full dataset count (from profiler)
  scopeWOs?: number | null;   // scoped count after applying filters
  onChange: (filters: AnalysisFilters) => void;
}

export default function FilterPanel({
  filters,
  options,
  columnMap,
  totalWOs,
  scopeWOs,
  onChange,
}: FilterPanelProps) {
  const has = (col: string) => !!columnMap[col as keyof ColumnMap];

  const activeCount =
    (filters.dateFrom || filters.dateTo ? 1 : 0) +
    (filters.equipment.length > 0 ? 1 : 0) +
    (filters.functionalLocation.length > 0 ? 1 : 0) +
    (filters.orderType.length > 0 ? 1 : 0) +
    (filters.systemStatus.length > 0 ? 1 : 0);

  const set = (patch: Partial<AnalysisFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="bg-white border border-slate-200 rounded shadow-sm p-4 space-y-3 animate-enter">

      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="filter" className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-bold text-slate-700">Analysis Scope</span>
          {activeCount > 0 && (
            <span className="text-[10px] font-bold bg-brand-600 text-white px-1.5 py-0.5 rounded-full">
              {activeCount} active
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {scopeWOs != null && (
            <span className="text-xs text-slate-500 font-mono">
              <span className={`font-bold ${scopeWOs < totalWOs ? 'text-amber-600' : 'text-green-600'}`}>
                {scopeWOs.toLocaleString()}
              </span>
              {' '}/ {totalWOs.toLocaleString()} WOs in scope
            </span>
          )}
          {activeCount > 0 && (
            <button
              onClick={() => onChange({
                dateFrom: null, dateTo: null,
                equipment: [], functionalLocation: [], orderType: [], systemStatus: [],
              })}
              className="text-xs text-slate-400 hover:text-red-500 transition font-bold"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap gap-2">

        {/* Date range */}
        <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded px-2 py-1">
          <span className="text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">Date</span>
          <input
            type="date"
            value={filters.dateFrom ?? ''}
            min={options.dateMin ?? undefined}
            max={options.dateMax ?? undefined}
            onChange={e => set({ dateFrom: e.target.value || null })}
            className="text-xs border-0 bg-transparent outline-none text-slate-700 w-32"
          />
          <span className="text-slate-300 text-xs">→</span>
          <input
            type="date"
            value={filters.dateTo ?? ''}
            min={options.dateMin ?? undefined}
            max={options.dateMax ?? undefined}
            onChange={e => set({ dateTo: e.target.value || null })}
            className="text-xs border-0 bg-transparent outline-none text-slate-700 w-32"
          />
        </div>

        {/* Equipment */}
        {has('equipment') && options.equipment.length > 0 && (
          <MultiSelect
            label="Equipment"
            options={options.equipment}
            selected={filters.equipment}
            onChange={v => set({ equipment: v })}
          />
        )}

        {/* Functional Location */}
        {has('functional_location') && options.functionalLocation.length > 0 && (
          <MultiSelect
            label="Func. Location"
            options={options.functionalLocation}
            selected={filters.functionalLocation}
            onChange={v => set({ functionalLocation: v })}
          />
        )}

        {/* Order Type */}
        {has('order_type') && options.orderType.length > 0 && (
          <MultiSelect
            label="Order Type"
            options={options.orderType}
            selected={filters.orderType}
            onChange={v => set({ orderType: v })}
          />
        )}

        {/* System Status */}
        {has('system_status') && options.systemStatus.length > 0 && (
          <MultiSelect
            label="Status"
            options={options.systemStatus}
            selected={filters.systemStatus}
            onChange={v => set({ systemStatus: v })}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MultiSelect — Excel-style dropdown with search + checkboxes
// ─────────────────────────────────────────────────────────────────────────────

interface MultiSelectProps {
  label:    string;
  options:  string[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

function MultiSelect({ label, options, selected, onChange }: MultiSelectProps) {
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = useMemo(() =>
    search.trim()
      ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
      : options,
    [options, search]
  );

  const allFilteredSelected = filtered.length > 0 && filtered.every(o => selected.includes(o));

  const toggle = (val: string) => {
    onChange(selected.includes(val)
      ? selected.filter(s => s !== val)
      : [...selected, val]);
  };

  const toggleAll = () => {
    if (allFilteredSelected) {
      onChange(selected.filter(s => !filtered.includes(s)));
    } else {
      const next = [...selected];
      for (const o of filtered) if (!next.includes(o)) next.push(o);
      onChange(next);
    }
  };

  const count = selected.length;

  return (
    <div className="relative" ref={ref}>
      {/* Trigger */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs font-bold transition ${
          count > 0
            ? 'bg-brand-50 border-brand-300 text-brand-700'
            : 'bg-slate-50 border-slate-200 text-slate-600 hover:border-slate-400'
        }`}
      >
        <span>{label}</span>
        {count > 0 ? (
          <span className="bg-brand-600 text-white text-[10px] px-1.5 py-0.5 rounded-full leading-none">
            {count}
          </span>
        ) : (
          <Icon name="chevronDown" className="w-3 h-3 text-slate-400" />
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 bg-white border border-slate-200 rounded shadow-xl animate-enter">

          {/* Search */}
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Icon name="search" className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1.5" />
              <input
                autoFocus
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                className="w-full pl-7 pr-2 py-1 text-xs border border-slate-200 rounded outline-none focus:border-brand-400"
              />
            </div>
          </div>

          {/* Select All / Clear */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 bg-slate-50">
            <button
              onClick={toggleAll}
              className="text-[10px] font-bold text-brand-600 hover:text-brand-800 transition"
            >
              {allFilteredSelected ? 'Deselect all' : 'Select all'}
            </button>
            {count > 0 && (
              <button
                onClick={() => onChange([])}
                className="text-[10px] font-bold text-slate-400 hover:text-red-500 transition"
              >
                Clear
              </button>
            )}
          </div>

          {/* Options list */}
          <div className="max-h-52 overflow-y-auto scroll-thin">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-400 text-center">No matches</div>
            ) : (
              filtered.map(opt => (
                <label
                  key={opt}
                  className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-slate-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(opt)}
                    onChange={() => toggle(opt)}
                    className="accent-brand-600 w-3.5 h-3.5 shrink-0"
                  />
                  <span className="text-xs text-slate-700 truncate font-mono">{opt}</span>
                </label>
              ))
            )}
          </div>

          {/* Footer count */}
          <div className="px-3 py-1.5 border-t border-slate-100 text-[10px] text-slate-400">
            {filtered.length} of {options.length} shown
            {count > 0 && <span className="ml-2 font-bold text-brand-600">{count} selected</span>}
          </div>
        </div>
      )}
    </div>
  );
}
