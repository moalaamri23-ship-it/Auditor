import React, { useState } from 'react';
import Icon from './Icon';
import { useStore, useRunsForProject, hasArchivedV1Data } from '../store/useStore';
import type { AuditProject, AuditRun } from '../types';

export default function ProjectsDashboard() {
  const { projects, setScreen, setActiveProject, setActiveRun, deleteProject } = useStore();
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const openProject = (project: AuditProject) => {
    setActiveProject(project.id);
    setActiveRun(null);
    if (project.runIds.length === 0) {
      setScreen('upload');
    } else {
      setScreen('upload');
    }
  };

  const handleDelete = (e: React.MouseEvent, p: AuditProject) => {
    e.stopPropagation();
    setConfirmDelete({ id: p.id, name: p.name });
  };

  const archived = hasArchivedV1Data();

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="mb-8 flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Audit Projects</h1>
          <p className="text-sm text-slate-500 mt-1">
            Each project groups multiple audit runs across periods so you can track improvement over time.
          </p>
        </div>
        {archived && (
          <button
            onClick={() => setShowArchived(true)}
            className="text-xs font-bold text-slate-500 hover:text-brand-600 underline"
          >
            View archived sessions
          </button>
        )}
      </div>

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

      {showArchived && <ArchivedV1Modal onClose={() => setShowArchived(false)} />}
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

// ─── Archived v1 modal ───────────────────────────────────────────────────────

function ArchivedV1Modal({ onClose }: { onClose: () => void }) {
  let sessions: Array<{ name: string; fileName: string; uploadedAt: string }> = [];
  try {
    const raw = localStorage.getItem('sap-auditor-v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      sessions = (parsed?.state?.sessions ?? []).map((s: any) => ({
        name: String(s?.name ?? 'Untitled'),
        fileName: String(s?.fileName ?? ''),
        uploadedAt: String(s?.uploadedAt ?? ''),
      }));
    }
  } catch { /* ignore */ }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 grid place-items-center"
      onMouseDown={onClose}
    >
      <div
        className="bg-white rounded-xl p-6 w-[92vw] max-w-lg border shadow-xl animate-enter"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="font-bold text-slate-900 mb-2">Archived sessions (v1)</div>
        <p className="text-sm text-slate-500 mb-4">
          These sessions were created before the redesign. They are read-only — the new schema and
          project model are not backwards-compatible. To audit the same data again, create a new
          Audit Project and re-upload.
        </p>
        {sessions.length === 0 ? (
          <p className="text-sm text-slate-400">No archived sessions found.</p>
        ) : (
          <ul className="max-h-72 overflow-auto scroll-thin border border-slate-200 rounded divide-y divide-slate-100">
            {sessions.map((s, i) => (
              <li key={i} className="px-3 py-2 text-sm">
                <div className="font-semibold text-slate-700">{s.name}</div>
                <div className="text-xs text-slate-400 font-mono">{s.fileName}</div>
                <div className="text-xs text-slate-400">{formatDate(s.uploadedAt)}</div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
