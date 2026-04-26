import React, { useEffect, useState } from 'react';
import Header from './components/Header';
import ProjectsDashboard from './components/SessionsDashboard';
import AuditInitWizard from './components/AuditInitWizard';
import UploadZone from './components/UploadZone';
import SchemaMapper from './components/SchemaMapper';
import DataProfiler from './components/DataProfiler';
import PreChecksView from './components/PreChecksView';
import AuditDashboard from './components/AuditDashboard';
import ComparisonView from './components/ComparisonView';
import IssueExplorer from './components/IssueExplorer';
import SettingsScreen from './components/SettingsScreen';
import { useStore } from './store/useStore';
import { initDB } from './services/DuckDBService';
import { ensureCatalogLoaded } from './services/FailureCatalogService';

type DBState = 'loading' | 'ready' | 'error';

export default function App() {
  const { currentScreen } = useStore();
  const [dbState, setDbState] = useState<DBState>('loading');
  const [dbError, setDbError] = useState('');

  useEffect(() => {
    initDB()
      .then(async () => {
        await ensureCatalogLoaded().catch(() => {});
        // Database is in-memory — runs lose their data on refresh
        const { runs, updateRun } = useStore.getState();
        runs.forEach((r) => {
          if (r.hasDataInDB) updateRun(r.id, { hasDataInDB: false });
        });
        setDbState('ready');
      })
      .catch((err: Error) => {
        setDbError(err.message);
        setDbState('error');
      });
  }, []);

  if (dbState === 'error') {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 font-sans">
        <div className="bg-white p-8 rounded-xl shadow-lg text-center max-w-md border border-red-200">
          <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl">⚠️</span>
          </div>
          <div className="font-bold text-red-700 text-lg mb-2">Database Failed to Load</div>
          <div className="text-sm text-slate-500 mb-4">{dbError}</div>
          <div className="text-xs text-slate-400 bg-slate-50 p-3 rounded text-left font-mono">
            This app requires WebAssembly (WASM) support. Please use a modern browser
            (Chrome 90+, Firefox 88+, Safari 15+).
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 bg-slate-900 text-white px-4 py-2 rounded text-sm font-bold"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col font-sans text-slate-700 bg-slate-50">
      <Header dbReady={dbState === 'ready'} />

      <main className="flex-1 overflow-auto scroll-thin">
        {dbState === 'loading' && (
          <div className="flex flex-col items-center justify-center h-full gap-4">
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
              <div className="font-semibold text-slate-700 text-sm">Initialising Database engine…</div>
              <div className="text-xs text-slate-400 mt-1">Loading WASM modules…</div>
            </div>
          </div>
        )}

        {dbState === 'ready' && (
          <>
            {currentScreen === 'projects' && <ProjectsDashboard />}
            {currentScreen === 'audit-init' && <AuditInitWizard />}
            {currentScreen === 'upload' && <UploadZone />}
            {currentScreen === 'schema-mapper' && <SchemaMapper />}
            {currentScreen === 'profiler' && <DataProfiler />}
            {currentScreen === 'pre-checks' && <PreChecksView />}
            {currentScreen === 'analysis' && <AuditDashboard />}
            {currentScreen === 'comparison' && <ComparisonView />}
            {currentScreen === 'explorer' && <IssueExplorer />}
            {currentScreen === 'settings' && <SettingsScreen />}
          </>
        )}
      </main>
    </div>
  );
}
