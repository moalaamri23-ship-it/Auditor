import React, { useRef, useState } from 'react';
import Icon from './Icon';
import { useStore, useRunsForProject } from '../store/useStore';
import type { AuditProject, AuditRun } from '../types';
import { EMPTY_FILTERS } from '../types';
import { saveRunData } from '../services/IndexedDBService';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

export default function ProjectsDashboard() {
  const { projects, setScreen, setActiveProject, setActiveRun, deleteProject, importProject, updateRun, setLoading } = useStore();
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImport = async (file: File) => {
    setImportError(null);
    setLoading(true, 'Importing project…');
    try {
      const text = await file.text();
      const payload = JSON.parse(text);

      if (payload.appVersion !== 'sap-auditor-v2') {
        throw new Error('Unsupported file format. Only sap-auditor-v2 exports are supported.');
      }
      if (!payload.project?.id || !payload.project?.name || !Array.isArray(payload.project?.runIds)) {
        throw new Error('Invalid export file: missing project data.');
      }
      if (!Array.isArray(payload.runs)) {
        throw new Error('Invalid export file: missing runs array.');
      }

      // Determine if IDs conflict with existing data
      const existingProjectIds = new Set(projects.map((p) => p.id));
      const needsNewIds = existingProjectIds.has(payload.project.id);

      const newProjectId = needsNewIds ? generateId() : payload.project.id;
      const idMap: Record<string, string> = {};
      if (needsNewIds) {
        for (const run of payload.runs) idMap[run.id] = generateId();
      } else {
        for (const run of payload.runs) idMap[run.id] = run.id;
      }

      const newRuns: AuditRun[] = payload.runs.map((run: AuditRun & { rawData?: { rows: Record<string, string>[]; columnMap: Record<string, string> } | null }) => ({
        ...run,
        id: idMap[run.id],
        projectId: newProjectId,
        aiFlags: run.aiFlags ?? [],
        aiFlagSummary: run.aiFlagSummary ?? null,
        chartCache: run.chartCache ?? null,
        analysisFilters: run.analysisFilters ?? EMPTY_FILTERS,
        hasDataInDB: false,
        rawData: undefined,
      }));

      const newProject: AuditProject = {
        ...payload.project,
        id: newProjectId,
        runIds: (payload.project.runIds as string[]).map((rid) => idMap[rid] ?? rid),
      };

      importProject(newProject, newRuns);

      // Restore raw data into IndexedDB for runs that have it
      for (const run of payload.runs as Array<AuditRun & { rawData?: { rows: Record<string, string>[]; columnMap: Record<string, string> } | null }>) {
        if (run.rawData?.rows && run.rawData?.columnMap) {
          const newRunId = idMap[run.id];
          await saveRunData(newRunId, run.rawData.rows, run.rawData.columnMap);
          updateRun(newRunId, { hasDataInDB: true });
        }
      }

      setActiveProject(newProjectId);
      setActiveRun(null);
      setScreen('project-home');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import project.');
    } finally {
      setLoading(false);
    }
  };

  const openProject = (project: AuditProject) => {
    setActiveProject(project.id);
    setActiveRun(null);
    if (project.runIds.length === 0) {
      setScreen('upload');
    } else {
      setScreen('project-home');
    }
  };

  const handleDelete = (e: React.MouseEvent, p: AuditProject) => {
    e.stopPropagation();
    setConfirmDelete({ id: p.id, name: p.name });
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImport(f);
          e.target.value = '';
        }}
      />
      <div className="mb-8 flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Audit Projects</h1>
          <p className="text-sm text-slate-500 mt-1">
            Each project groups multiple audit runs across periods so you can track improvement over time.
          </p>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-4 py-2 text-sm font-bold border border-slate-300 text-slate-600 rounded-lg hover:bg-slate-50 transition flex items-center gap-2"
        >
          <Icon name="upload" className="w-4 h-4" />
          Import Project
        </button>
      </div>

      {importError && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-start gap-2">
          <Icon name="alertTriangle" className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{importError}</span>
          <button onClick={() => setImportError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <Icon name="x" className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-5">
        <button
          onClick={() => {
            setActiveProject(null);
            setActiveRun(null);
            setScreen('audit-init');
          }}
          className="bg-white p-6 rounded shadow border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-3 text-slate-400 hover:border-brand-500 hover:text-brand-500 transition cursor-pointer min-h-[200px] animate-enter"
        >
          <Icon name="plus" className="w-8 h-8" />
          <div className="font-bold text-sm">New Audit Project</div>
          <div className="text-xs text-center">Set audit name, type, period and bank scope</div>
        </button>

        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onClick={() => openProject(p)}
            onDelete={(e) => handleDelete(e, p)}
          />
        ))}
      </div>

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 bg-black/40 grid place-items-center"
          onMouseDown={() => setConfirmDelete(null)}
        >
          <div
            className="bg-white rounded-xl p-6 w-[92vw] max-w-sm border shadow-xl animate-enter"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="font-bold text-slate-900 mb-1">Delete project?</div>
            <div className="text-sm text-slate-500 mb-4">
              "{confirmDelete.name}" and all of its runs will be removed. This cannot be undone.
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
                  deleteProject(confirmDelete.id);
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

// ─── Project card ────────────────────────────────────────────────────────────

function ProjectCard({
  project,
  onClick,
  onDelete,
}: {
  project: AuditProject;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const runs = useRunsForProject(project.id);
  const lastRun = runs[runs.length - 1] ?? null;
  const lastDate = lastRun?.lastAnalysedAt ?? lastRun?.uploadedAt ?? project.createdAt;

  return (
    <div
      onClick={onClick}
      className="bg-white p-6 rounded shadow hover:shadow-lg cursor-pointer relative group animate-enter transition"
    >
      <button
        onClick={onDelete}
        className="absolute top-3 right-3 p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
        title="Delete project"
      >
        <Icon name="trash" className="w-4 h-4" />
      </button>

      <div className="flex items-center gap-2 mb-3">
        <TypeBadge type={project.type} />
        <PeriodBadge period={project.period} />
      </div>

      <h3 className="font-bold text-lg text-slate-900 pr-6 leading-tight">
        {project.name}
      </h3>

      {project.bankPattern && (
        <div className="text-xs text-slate-400 font-mono mt-1 truncate">
          {project.bankPattern}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <MetaStat label="Runs" value={runs.length.toString()} />
        <MetaStat label="Latest" value={lastRun ? `#${lastRun.runIndex} ${lastRun.periodLabel}` : '—'} />
      </div>

      <div className="mt-4 flex justify-between items-center">
        <div className="text-xs text-slate-400">
          {formatDate(lastDate)}
        </div>
        {lastRun?.aiFlagSummary && (
          <span className="text-xs font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-700">
            {lastRun.aiFlagSummary.totalFlagged} flagged
          </span>
        )}
      </div>
    </div>
  );
}

function TypeBadge({ type }: { type: AuditProject['type'] }) {
  const map = {
    TOTAL: { label: 'Total Audit', cls: 'bg-blue-100 text-blue-700' },
    SINGLE_BANK: { label: 'Bank Audit', cls: 'bg-violet-100 text-violet-700' },
  } as const;
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${map[type].cls}`}>
      {map[type].label}
    </span>
  );
}

function PeriodBadge({ period }: { period: AuditProject['period'] }) {
  const map = {
    WEEKLY: 'Weekly',
    BIWEEKLY: 'Bi-weekly',
    QUARTERLY: 'Quarterly',
    YEARLY: 'Yearly',
  } as const;
  return (
    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-slate-100 text-slate-600">
      {map[period]}
    </span>
  );
}

function MetaStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase text-slate-400">{label}</div>
      <div className="text-sm font-semibold text-slate-700 font-mono truncate">{value}</div>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

