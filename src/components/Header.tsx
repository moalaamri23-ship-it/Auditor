import React, { useState } from 'react';
import Icon from './Icon';
import { useStore, useActiveProject, useActiveRun, useRunsForProject } from '../store/useStore';
import type { RunStage, Screen } from '../types';

interface Tab {
  id: Screen;
  label: string;
}

const PROJECT_TABS: Tab[] = [
  { id: 'profiler',   label: 'Data' },
  { id: 'pre-checks', label: 'Pre-Checks' },
  { id: 'analysis',   label: 'Audit' },
  { id: 'comparison', label: 'Comparison' },
  { id: 'explorer',   label: 'Issues' },
];

const GLOBAL_TABS: Tab[] = [
  { id: 'projects', label: 'Projects' },
];

const VISIBLE_STAGES: ReadonlySet<RunStage> = new Set<RunStage>([
  'profiled', 'pre-checked', 'analysed',
]);

export default function Header({ dbReady }: { dbReady: boolean }) {
  const { currentScreen, setScreen, setActiveProject, setActiveRun, setLoading, deleteRun } = useStore();
  const project = useActiveProject();
  const run = useActiveRun();
  const projectRuns = useRunsForProject(project?.id ?? null);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [runMenuOpen, setRunMenuOpen] = useState(false);

  const goToProjects = () => {
    setActiveProject(null);
    setActiveRun(null);
    setScreen('projects');
    setLoading(false);
  };

  const handleDeleteRun = (e: React.MouseEvent, runId: string) => {
    e.stopPropagation();
    if (!window.confirm('Delete this run and all its results?')) return;
    deleteRun(runId);
    setRunMenuOpen(false);
    if (run?.id === runId) {
      setActiveRun(null);
      setScreen('project-home');
    }
  };

  const tabs = run && VISIBLE_STAGES.has(run.stage)
    ? [...GLOBAL_TABS, ...PROJECT_TABS]
    : GLOBAL_TABS;

  return (
    <header className="h-14 bg-slate-900 text-white flex items-center justify-between px-6 shadow-md shrink-0 z-20">
      <div className="flex items-center gap-3 shrink-0">
        <img src="/icon-1024.png" alt="SAP Auditor" className="w-8 h-8 rounded-md" />
        <div>
          <div className="font-bold text-sm">SAP Auditor</div>
          <div className="text-[10px] uppercase text-slate-400 font-bold">Reliability Platform</div>
        </div>
        {project && (
          <div className="ml-4 pl-4 border-l border-slate-700 flex items-center gap-2 text-xs">
            <Icon name="layers" className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-slate-200 font-bold">{project.name}</span>
            <span className="text-slate-500 font-mono">{project.type === 'SINGLE_BANK' ? 'Bank' : 'Total'}</span>
          </div>
        )}
        {run && (
          <div className="relative">
            <button
              onClick={() => setRunMenuOpen((v) => !v)}
              className="ml-2 px-2 py-1 rounded bg-slate-800 border border-slate-700 hover:border-slate-500 text-xs flex items-center gap-1.5"
            >
              <span className="font-mono text-slate-400">#{run.runIndex}</span>
              <span className="text-slate-100">{run.periodLabel}</span>
              <Icon name="chevronDown" className="w-3 h-3 text-slate-400" />
            </button>
            {runMenuOpen && projectRuns.length > 0 && (
              <div className="absolute top-full left-0 mt-1 bg-slate-900 border border-slate-700 rounded shadow-xl min-w-[220px] z-50">
                {projectRuns.map((r) => (
                  <div
                    key={r.id}
                    className={`flex items-center group ${
                      r.id === run.id ? 'bg-brand-600/20' : 'hover:bg-slate-800'
                    }`}
                  >
                    <button
                      onClick={() => {
                        setActiveRun(r.id);
                        setRunMenuOpen(false);
                      }}
                      className="flex-1 text-left px-3 py-2 text-xs flex items-center gap-2"
                    >
                      <span className="font-mono text-slate-500 w-6">#{r.runIndex}</span>
                      <span className={`flex-1 ${r.id === run.id ? 'text-white' : 'text-slate-300'}`}>
                        {r.periodLabel}
                      </span>
                      {r.id === run.id && <Icon name="check" className="w-3 h-3 text-brand-400" />}
                    </button>
                    <button
                      onClick={(e) => handleDeleteRun(e, r.id)}
                      className="p-2 text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition shrink-0"
                      title="Delete run"
                    >
                      <Icon name="trash" className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 relative">
          <div
            className={`flex items-center gap-2 overflow-hidden transition-all duration-300 ease-in-out ${
              toolbarOpen ? 'max-w-lg opacity-100' : 'max-w-0 opacity-0 pointer-events-none'
            }`}
          >
            <div className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded border bg-slate-800 border-slate-600 text-slate-300 whitespace-nowrap">
              <div className={`w-1.5 h-1.5 rounded-full ${dbReady ? 'bg-green-400' : 'bg-amber-400 animate-pulse'}`} />
              {dbReady ? 'Database ready' : 'Loading…'}
            </div>
            <button
              onClick={() => { setScreen('settings'); setToolbarOpen(false); }}
              className="text-xs font-bold px-3 py-1.5 rounded border flex items-center gap-1.5 whitespace-nowrap bg-slate-800 border-slate-600 text-slate-200 hover:bg-slate-700 transition"
            >
              Settings
            </button>
            <button
              className="text-xs font-bold px-3 py-1.5 rounded border flex items-center gap-1.5 whitespace-nowrap bg-slate-800 border-slate-600 text-slate-400 cursor-not-allowed opacity-60"
              disabled
            >
              Reporting Settings
            </button>
            <button
              className="text-xs font-bold px-3 py-1.5 rounded border flex items-center gap-1.5 whitespace-nowrap bg-slate-800 border-slate-600 text-slate-400 cursor-not-allowed opacity-60"
              disabled
            >
              DATA View
            </button>
          </div>

          <button
            onClick={() => setToolbarOpen((v) => !v)}
            title={toolbarOpen ? 'Collapse toolbar' : 'Expand toolbar'}
            className="w-7 h-7 rounded flex items-center justify-center bg-slate-800 border border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white transition shrink-0"
          >
            <Icon name={toolbarOpen ? 'chevronRight' : 'chevronLeft'} className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex bg-slate-800 rounded p-1 gap-0.5">
          {tabs.map((tab) => {
            const active = currentScreen === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setScreen(tab.id)}
                className={`px-3 py-1 rounded text-xs font-bold transition ${
                  active ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-700'
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
