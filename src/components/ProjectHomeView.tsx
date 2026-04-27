import React, { useState } from 'react';
import Icon from './Icon';
import { useStore, useActiveProject, useRunsForProject } from '../store/useStore';
import type { AuditRun, RunStage } from '../types';
import { loadRunData } from '../services/IndexedDBService';

function stageScreen(stage: RunStage): import('../types').Screen {
  if (stage === 'analysed') return 'analysis';
  if (stage === 'pre-checked') return 'pre-checks';
  if (stage === 'profiled') return 'profiler';
  return 'upload';
}

function stageBadge(stage: RunStage) {
  const map: Record<RunStage, { label: string; cls: string }> = {
    init:        { label: 'Init',        cls: 'bg-slate-100 text-slate-500' },
    uploaded:    { label: 'Uploaded',    cls: 'bg-blue-100 text-blue-600' },
    mapped:      { label: 'Mapped',      cls: 'bg-sky-100 text-sky-600' },
    profiled:    { label: 'Profiled',    cls: 'bg-teal-100 text-teal-600' },
    'pre-checked': { label: 'Pre-Checked', cls: 'bg-amber-100 text-amber-700' },
    analysed:    { label: 'Analysed',    cls: 'bg-green-100 text-green-700' },
  };
  const { label, cls } = map[stage] ?? { label: stage, cls: 'bg-slate-100 text-slate-500' };
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${cls}`}>
      {label}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default function ProjectHomeView() {
  const project = useActiveProject();
  const runs = useRunsForProject(project?.id ?? null);
  const { setScreen, setActiveRun, deleteRun, updateRun } = useStore();
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; label: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!project) return;
    setExporting(true);
    try {
      const exportRuns = await Promise.all(
        runs.map(async (run) => {
          const rawData = await loadRunData(run.id).catch(() => null);
          return { ...run, rawData: rawData ? { rows: rawData.rows, columnMap: rawData.columnMap } : null };
        }),
      );
      const payload = {
        exportedAt: new Date().toISOString(),
        appVersion: 'sap-auditor-v2',
        project,
        runs: exportRuns,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `${project.name.replace(/[^a-z0-9]/gi, '_')}-export-${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        No active project.
      </div>
    );
  }

  const sortedRuns = [...runs].sort((a, b) => b.runIndex - a.runIndex);

  const openRun = (run: AuditRun) => {
    setActiveRun(run.id);
    const screen = stageScreen(run.stage);
    if (screen === 'upload') {
      // Re-upload required: mark hasDataInDB false if not already
      if (run.hasDataInDB) updateRun(run.id, { hasDataInDB: false });
    }
    setScreen(screen);
  };

  const handleDelete = (e: React.MouseEvent, run: AuditRun) => {
    e.stopPropagation();
    setConfirmDelete({ id: run.id, label: `#${run.runIndex} ${run.periodLabel}` });
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <button
            onClick={() => { setActiveRun(null); setScreen('projects'); }}
            className="text-xs font-bold text-slate-400 hover:text-brand-600 flex items-center gap-1 mb-2 transition"
          >
            <Icon name="arrowLeft" className="w-3 h-3" />
            All Projects
          </button>
          <h1 className="text-2xl font-bold text-slate-900">{project.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-blue-100 text-blue-700">
              {project.type === 'TOTAL' ? 'Total Audit' : 'Bank Audit'}
            </span>
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-slate-100 text-slate-600">
              {project.period === 'WEEKLY' ? 'Weekly' : project.period === 'BIWEEKLY' ? 'Bi-weekly' : project.period === 'QUARTERLY' ? 'Quarterly' : 'Yearly'}
            </span>
            {project.bankPattern && (
              <span className="text-xs text-slate-400 font-mono">{project.bankPattern}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            disabled={exporting || runs.length === 0}
            className="px-4 py-2 text-sm font-bold border border-slate-300 text-slate-600 rounded-lg hover:bg-slate-50 transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Icon name="download" className="w-4 h-4" />
            {exporting ? 'Exporting…' : 'Export Project'}
          </button>
          <button
            onClick={() => { setActiveRun(null); setScreen('upload'); }}
            className="px-4 py-2 text-sm font-bold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition flex items-center gap-2"
          >
            <Icon name="plus" className="w-4 h-4" />
            New Run
          </button>
        </div>
      </div>

      {/* Run list */}
      {sortedRuns.length === 0 ? (
        <div className="bg-white border-2 border-dashed border-slate-200 rounded-xl p-12 text-center">
          <div className="text-slate-400 text-sm mb-3">No runs yet for this project.</div>
          <button
            onClick={() => { setActiveRun(null); setScreen('upload'); }}
            className="px-4 py-2 text-sm font-bold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition"
          >
            Upload First Run
          </button>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left">
                <th className="px-4 py-3 text-[10px] font-bold uppercase text-slate-400 w-16">#</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase text-slate-400">Period / Label</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase text-slate-400">File</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase text-slate-400">Stage</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase text-slate-400">Date</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase text-slate-400">Flags</th>
                <th className="px-4 py-3 w-32" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedRuns.map((run) => (
                <tr
                  key={run.id}
                  className="hover:bg-slate-50 transition group"
                >
                  <td className="px-4 py-3 font-mono font-bold text-slate-500">
                    #{run.runIndex}
                  </td>
                  <td className="px-4 py-3 font-semibold text-slate-800">
                    {run.periodLabel}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs font-mono truncate max-w-[200px]">
                    {run.fileName}
                  </td>
                  <td className="px-4 py-3">
                    {stageBadge(run.stage)}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {formatDate(run.lastAnalysedAt ?? run.uploadedAt)}
                  </td>
                  <td className="px-4 py-3">
                    {run.aiFlagSummary ? (
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-700">
                        {run.aiFlagSummary.totalFlagged} flagged
                      </span>
                    ) : run.ruleChecks ? (
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-orange-100 text-orange-700">
                        {run.ruleChecks.flaggedWOs.length} rule flags
                      </span>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => openRun(run)}
                        className="px-3 py-1 text-xs font-bold rounded border border-brand-300 text-brand-600 bg-brand-50 hover:bg-brand-100 transition"
                      >
                        View
                      </button>
                      <button
                        onClick={(e) => handleDelete(e, run)}
                        className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
                        title="Delete run"
                      >
                        <Icon name="trash" className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirm modal */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 bg-black/40 grid place-items-center"
          onMouseDown={() => setConfirmDelete(null)}
        >
          <div
            className="bg-white rounded-xl p-6 w-[92vw] max-w-sm border shadow-xl animate-enter"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="font-bold text-slate-900 mb-1">Delete run?</div>
            <div className="text-sm text-slate-500 mb-4">
              Run "{confirmDelete.label}" and its results will be removed. This cannot be undone.
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  deleteRun(confirmDelete.id);
                  setConfirmDelete(null);
                }}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
