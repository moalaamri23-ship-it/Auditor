import React, { useState } from 'react';
import Icon from './Icon';
import { useStore, useActiveSession } from '../store/useStore';
import type { Screen } from '../types';

interface Tab {
  id: Screen;
  label: string;
  requiresSession: boolean;
}

const SESSION_TABS: Tab[] = [
  { id: 'profiler',  label: 'Profiler',    requiresSession: true },
  { id: 'analysis',  label: 'Analysis',    requiresSession: true },
  { id: 'explorer',  label: 'Issues',      requiresSession: true },
  { id: 'insights',  label: 'AI Insights', requiresSession: true },
];

const GLOBAL_TABS: Tab[] = [
  { id: 'dashboard', label: 'Sessions',  requiresSession: false },
  { id: 'settings',  label: 'Settings',  requiresSession: false },
];

export default function Header({ dbReady }: { dbReady: boolean }) {
  const { currentScreen, setScreen, setActiveSession, setLoading } = useStore();
  const session = useActiveSession();
  const [toolbarOpen, setToolbarOpen] = useState(false);

  const goToDashboard = () => {
    setActiveSession(null);
    setScreen('dashboard');
    setLoading(false);
  };

  // Determine which tabs to show
  const tabs = session && session.hasDataInDuckDB
    ? [...GLOBAL_TABS, ...SESSION_TABS]
    : GLOBAL_TABS;

  return (
    <header className="h-14 bg-slate-900 text-white flex items-center justify-between px-6 shadow-md shrink-0 z-20">

      {/* ── Left: Logo ── */}
      <div className="flex items-center gap-3 shrink-0">
        <img src="/icon-1024.png" alt="SAP Auditor" className="w-8 h-8 rounded-md" />
        <div>
          <div className="font-bold text-sm">SAP Auditor</div>
          <div className="text-[10px] uppercase text-slate-400 font-bold">Reliability Platform</div>
        </div>
      </div>

      {/* ── Right: Sliding toolbar + Nav tabs ── */}
      <div className="flex items-center gap-2">

        {/* Sliding action panel */}
        <div className="flex items-center gap-2 relative">

          {/* Buttons that slide out to the left */}
          <div
            className={`flex items-center gap-2 overflow-hidden transition-all duration-300 ease-in-out ${
              toolbarOpen ? 'max-w-xs opacity-100' : 'max-w-0 opacity-0 pointer-events-none'
            }`}
          >
            {/* DuckDB status */}
            <div className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded border bg-slate-800 border-slate-600 text-slate-300 whitespace-nowrap">
              <div className={`w-1.5 h-1.5 rounded-full ${dbReady ? 'bg-green-400' : 'bg-amber-400 animate-pulse'}`} />
              {dbReady ? 'DuckDB ready' : 'Loading…'}
            </div>

            {/* Back to sessions (if in a session) */}
            {session && (
              <button
                onClick={goToDashboard}
                className="text-xs font-bold px-3 py-1.5 rounded border flex items-center gap-1.5 whitespace-nowrap bg-slate-800 border-slate-600 text-slate-200 hover:bg-slate-700 transition"
              >
                <Icon name="arrowLeft" className="w-3.5 h-3.5" />
                Sessions
              </button>
            )}
          </div>

          {/* Chevron toggle */}
          <button
            onClick={() => setToolbarOpen(v => !v)}
            title={toolbarOpen ? 'Collapse toolbar' : 'Expand toolbar'}
            className="w-7 h-7 rounded flex items-center justify-center bg-slate-800 border border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white transition shrink-0"
          >
            <Icon
              name={toolbarOpen ? 'chevronRight' : 'chevronLeft'}
              className="w-3.5 h-3.5"
            />
          </button>
        </div>

        {/* Nav tabs */}
        <div className="flex bg-slate-800 rounded p-1 gap-0.5">
          {tabs.map((tab) => {
            const active = currentScreen === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setScreen(tab.id)}
                className={`px-3 py-1 rounded text-xs font-bold transition ${
                  active
                    ? 'bg-brand-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-700'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
}
