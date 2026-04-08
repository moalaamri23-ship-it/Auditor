import React, { useState, useEffect, useRef } from 'react';
import type { TieredModels } from '../services/AIService';

interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
  liveModels: TieredModels | null;
  fallbackModels: string[];
  provider: string;
  allowCustomList?: boolean; // enables persistent user-managed model list (OpenRouter)
}

const MAX_FAVORITES = 4;

const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>
);

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  value, onChange, liveModels, fallbackModels, provider, allowCustomList = false,
}) => {
  const [isOpen,        setIsOpen]        = useState(false);
  const [search,        setSearch]        = useState('');
  const [customInput,   setCustomInput]   = useState('');
  const [showCustom,    setShowCustom]    = useState(false);

  const [favorites,   setFavorites]   = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`auditor_fav_${provider}`) || '[]'); } catch { return []; }
  });
  const [userModels,  setUserModels]  = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`auditor_user_models_${provider}`) || '[]'); } catch { return []; }
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef    = useRef<HTMLInputElement>(null);

  // Reload per-provider data when provider changes
  useEffect(() => {
    try { setFavorites(JSON.parse(localStorage.getItem(`auditor_fav_${provider}`) || '[]')); } catch { setFavorites([]); }
    try { setUserModels(JSON.parse(localStorage.getItem(`auditor_user_models_${provider}`) || '[]')); } catch { setUserModels([]); }
    setSearch('');
    setShowCustom(false);
  }, [provider]);

  // Focus search when dropdown opens
  useEffect(() => {
    if (isOpen) setTimeout(() => searchRef.current?.focus(), 50);
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
        setShowCustom(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Persist helpers ──────────────────────────────────────────────────────────
  const persistFavorites = (next: string[]) => {
    localStorage.setItem(`auditor_fav_${provider}`, JSON.stringify(next));
    setFavorites(next);
  };

  const persistUserModels = (next: string[]) => {
    localStorage.setItem(`auditor_user_models_${provider}`, JSON.stringify(next));
    setUserModels(next);
  };

  // ── Actions ──────────────────────────────────────────────────────────────────
  const selectModel = (model: string) => {
    onChange(model);
    setIsOpen(false);
    setSearch('');
    setShowCustom(false);
  };

  const toggleFavorite = (model: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (favorites.includes(model)) {
      persistFavorites(favorites.filter(m => m !== model));
    } else if (favorites.length < MAX_FAVORITES) {
      persistFavorites([...favorites, model]);
    }
  };

  const removeUserModel = (model: string, e: React.MouseEvent) => {
    e.stopPropagation();
    persistUserModels(userModels.filter(m => m !== model));
    if (favorites.includes(model)) persistFavorites(favorites.filter(m => m !== model));
  };

  const submitCustom = () => {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    if (allowCustomList) {
      if (!userModels.includes(trimmed)) persistUserModels([...userModels, trimmed]);
    }
    onChange(trimmed);
    setCustomInput('');
    setShowCustom(false);
    setIsOpen(false);
  };

  // ── Build tier list ──────────────────────────────────────────────────────────
  type Tier = { label: string; models: string[]; labelColor: string; dotColor: string; isMyModels?: boolean };
  const tiers: Tier[] = [];

  if (favorites.length > 0) {
    tiers.push({ label: 'Favorites', models: favorites, labelColor: 'text-amber-600', dotColor: 'bg-amber-400' });
  }
  if (allowCustomList && userModels.length > 0) {
    tiers.push({ label: 'My Models', models: userModels, labelColor: 'text-violet-600', dotColor: 'bg-violet-400', isMyModels: true });
  }
  if (liveModels) {
    if (liveModels.pro.length)       tiers.push({ label: 'Pro',       models: liveModels.pro,       labelColor: 'text-purple-600', dotColor: 'bg-purple-400' });
    if (liveModels.balanced.length)  tiers.push({ label: 'Balanced',  models: liveModels.balanced,  labelColor: 'text-brand-600',  dotColor: 'bg-brand-400'  });
    if (liveModels.efficient.length) tiers.push({ label: 'Efficient', models: liveModels.efficient, labelColor: 'text-green-600',  dotColor: 'bg-green-400'  });
  } else if (fallbackModels.length > 0) {
    tiers.push({ label: 'Models', models: fallbackModels, labelColor: 'text-slate-500', dotColor: 'bg-slate-400' });
  }

  const q        = search.toLowerCase();
  const filtered = tiers
    .map(t => ({ ...t, models: t.models.filter(m => !q || m.toLowerCase().includes(q)) }))
    .filter(t => t.models.length > 0);

  const allKnown    = [...favorites, ...userModels, ...(liveModels ? [...liveModels.pro, ...liveModels.balanced, ...liveModels.efficient] : fallbackModels)];
  const isCustomVal = value && !allKnown.includes(value);
  const favFull     = favorites.length >= MAX_FAVORITES;

  const showEmpty = allowCustomList && userModels.length === 0 && !liveModels && fallbackModels.length === 0 && !search;

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setIsOpen(o => !o)}
        className="w-full border border-slate-200 rounded px-3 py-2 text-sm bg-white text-left flex items-center justify-between hover:border-slate-300 transition"
      >
        <span className={value ? 'text-slate-800 font-mono text-xs' : 'text-slate-400 text-sm'}>
          {value || 'Select model…'}
        </span>
        <svg className={`w-4 h-4 text-slate-400 transition-transform shrink-0 ml-2 ${isOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-[100] w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-2xl overflow-hidden animate-enter">
          {/* Search */}
          <div className="p-2 border-b border-slate-100 bg-slate-50">
            <div className="relative">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => e.key === 'Escape' && setIsOpen(false)}
                placeholder="Search models…"
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-md outline-none focus:border-brand-500 bg-white"
              />
            </div>
          </div>

          {/* Tier sections */}
          <div className="max-h-72 overflow-y-auto scroll-thin">

            {/* Empty state for OpenRouter before any models added */}
            {showEmpty && (
              <div className="px-3 py-6 text-center text-xs text-slate-400">
                No models yet — add one below
              </div>
            )}

            {filtered.map(tier => (
              <div key={tier.label}>
                {/* Tier header */}
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border-b border-slate-100 sticky top-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tier.dotColor}`}/>
                  <span className={`text-[10px] font-bold uppercase tracking-wider ${tier.labelColor}`}>{tier.label}</span>
                  {tier.label === 'Favorites' && (
                    <span className="ml-auto text-[10px] text-slate-400">{favorites.length}/{MAX_FAVORITES}</span>
                  )}
                </div>

                {/* Model rows */}
                {tier.models.map(model => {
                  const isSelected = model === value;
                  const isFav      = favorites.includes(model);
                  const canFav     = isFav || !favFull;
                  return (
                    <div
                      key={`${tier.label}-${model}`}
                      onClick={() => selectModel(model)}
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer group transition-colors ${isSelected ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                    >
                      {/* Check */}
                      <span className="w-3.5 shrink-0">
                        {isSelected && (
                          <svg className="w-3.5 h-3.5 text-brand-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                            <path d="M20 6L9 17l-5-5"/>
                          </svg>
                        )}
                      </span>
                      {/* Model name */}
                      <span className={`flex-1 text-xs font-mono truncate ${isSelected ? 'text-brand-700 font-semibold' : 'text-slate-700'}`}>
                        {model}
                      </span>
                      {/* Remove button — My Models tier only */}
                      {tier.isMyModels && (
                        <button
                          type="button"
                          onClick={e => removeUserModel(model, e)}
                          title="Remove from my list"
                          className="shrink-0 text-red-400 opacity-0 group-hover:opacity-100 transition hover:text-red-600"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                            <path d="M18 6L6 18M6 6l12 12"/>
                          </svg>
                        </button>
                      )}
                      {/* Star */}
                      <button
                        type="button"
                        onClick={e => toggleFavorite(model, e)}
                        title={isFav ? 'Remove from favorites' : favFull ? `Favorites full (max ${MAX_FAVORITES})` : 'Add to favorites'}
                        className={`shrink-0 transition-all ${isFav ? 'text-amber-400 opacity-100' : 'text-slate-300 opacity-0 group-hover:opacity-100 hover:text-amber-400'} ${!canFav ? 'cursor-not-allowed opacity-30' : ''}`}
                      >
                        <StarIcon filled={isFav} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}

            {/* No search results */}
            {filtered.length === 0 && search && (
              <div className="px-3 py-6 text-center text-xs text-slate-400">
                No models match "<span className="font-mono">{search}</span>"
              </div>
            )}

            {/* Current custom value (not in any list) */}
            {isCustomVal && !q && (
              <div>
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border-b border-slate-100">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0"/>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Custom</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 bg-brand-50">
                  <span className="w-3.5 shrink-0">
                    <svg className="w-3.5 h-3.5 text-brand-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M20 6L9 17l-5-5"/></svg>
                  </span>
                  <span className="flex-1 text-xs font-mono text-brand-700 font-semibold truncate">{value}</span>
                </div>
              </div>
            )}
          </div>

          {/* Footer — custom model entry */}
          <div className="border-t border-slate-100 p-2 bg-slate-50">
            {!showCustom ? (
              <button
                type="button"
                onClick={() => setShowCustom(true)}
                className="w-full text-left text-xs text-slate-400 hover:text-brand-600 px-1 py-0.5 transition-colors"
              >
                {allowCustomList ? '+ Add model to my list…' : '+ Enter custom model ID…'}
              </button>
            ) : (
              <div className="space-y-1.5">
                {allowCustomList && (
                  <p className="text-[10px] text-slate-400 px-1">Model will be saved to your list and selected.</p>
                )}
                <div className="flex gap-1.5">
                  <input
                    autoFocus
                    type="text"
                    value={customInput}
                    onChange={e => setCustomInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') submitCustom();
                      if (e.key === 'Escape') { setShowCustom(false); setCustomInput(''); }
                    }}
                    placeholder={allowCustomList ? 'e.g. anthropic/claude-sonnet-4-6' : 'e.g. gemini-2.5-pro-exp-03-25'}
                    className="flex-1 border border-slate-200 rounded px-2 py-1 text-xs font-mono outline-none focus:border-brand-500 bg-white"
                  />
                  <button
                    type="button"
                    onClick={submitCustom}
                    className="px-2.5 py-1 bg-brand-600 text-white text-xs rounded font-semibold hover:bg-brand-700 transition"
                  >
                    {allowCustomList ? 'Add' : 'Use'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
