import React, { useState } from 'react';
import Icon from './Icon';
import { useStore } from '../store/useStore';
import type { Session } from '../types';

export default function SessionsDashboard() {
  const { sessions, setScreen, setActiveSession, deleteSession } = useStore();
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const openSession = (s: Session) => {
    setActiveSession(s.id);
    if (s.hasDataInDuckDB) {
      setScreen('profiler');
    } else if (s.stage === 'uploaded') {
      setScreen('upload'); // prompt to re-upload
    } else {
      setScreen('profiler');
    }
  };

  const handleDelete = (e: React.MouseEvent, s: Session) => {
    e.stopPropagation();
    setConfirmDelete({ id: s.id, name: s.name });
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">

      {/* ── Page header ── */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Analysis Sessions</h1>
        <p className="text-sm text-slate-500 mt-1">
          Upload SAP Records to begin. Each session stores your column mapping and profiling results.
        </p>
      </div>

      {/* ── Session grid ── */}
      <div className="grid md:grid-cols-3 gap-5">

        {/* New session card */}
        <button
          onClick={() => setScreen('upload')}
          className="bg-white p-6 rounded shadow border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-3 text-slate-400 hover:border-brand-500 hover:text-brand-500 transition cursor-pointer min-h-[160px] animate-enter"
        >
          <Icon name="upload" className="w-8 h-8" />
          <div className="font-bold text-sm">New Analysis</div>
          <div className="text-xs text-center">Upload SAP Records (Excel or CSV)</div>
        </button>

        {/* Existing sessions */}
        {sessions.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            onClick={() => openSession(s)}
            onDelete={(e) => handleDelete(e, s)}
          />
        ))}
      </div>


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
            <div className="font-bold text-slate-900 mb-1">Delete session?</div>
            <div className="text-sm text-slate-500 mb-4">
              "{confirmDelete.name}" will be removed. This cannot be undone.
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
                  deleteSession(confirmDelete.id);
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

// ─── Session card ─────────────────────────────────────────────────────────────

function SessionCard({
  session,
  onClick,
  onDelete,
}: {
  session: Session;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const score = session.dataProfile?.dataQualityScore ?? session.validationReport?.dataQualityScore ?? null;

  return (
    <div
      onClick={onClick}
      className="bg-white p-6 rounded shadow hover:shadow-lg cursor-pointer relative group animate-enter transition"
    >
      {/* Delete button (hover reveal) */}
      <button
        onClick={onDelete}
        className="absolute top-3 right-3 p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
        title="Delete session"
      >
        <Icon name="trash" className="w-4 h-4" />
      </button>

      {/* Stage badge */}
      <div className="flex items-center gap-2 mb-3">
        <StageBadge stage={session.stage} hasData={session.hasDataInDuckDB} />
      </div>

      {/* Name */}
      <h3 className="font-bold text-lg text-slate-900 pr-6 leading-tight truncate">
        {session.name}
      </h3>
      <div className="text-xs text-slate-400 font-mono mt-0.5 truncate">{session.fileName}</div>

      {/* Metrics row */}
      {session.dataProfile && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <MetaStat label="Rows" value={session.dataProfile.totalRows.toLocaleString()} />
          <MetaStat label="Work Orders" value={session.dataProfile.distinctWOs.toLocaleString()} />
          <MetaStat label="Rows / WO" value={session.dataProfile.rowsPerWO.toFixed(1)} />
          <MetaStat
            label="Granularity"
            value={
              session.dataProfile.granularityLevel === 'WO_LEVEL'
                ? 'WO-level'
                : session.dataProfile.granularityLevel === 'MIXED'
                ? 'Mixed'
                : 'Confirmation'
            }
          />
        </div>
      )}

      {/* Footer */}
      <div className="mt-4 flex justify-between items-center">
        <div className="text-xs text-slate-400">
          {formatDate(session.uploadedAt)}
        </div>
        {score !== null && (
          <QualityBadge score={score} />
        )}
      </div>
    </div>
  );
}

function StageBadge({ stage, hasData }: { stage: Session['stage']; hasData: boolean }) {
  if (!hasData && stage !== 'uploaded') {
    return (
      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-700">
        Re-upload needed
      </span>
    );
  }
  const MAP = {
    uploaded:  { label: 'Uploaded',  cls: 'bg-slate-100 text-slate-600' },
    mapped:    { label: 'Mapped',    cls: 'bg-blue-100 text-blue-700'   },
    profiled:  { label: 'Profiled',  cls: 'bg-teal-100 text-teal-700'   },
    analysed:  { label: 'Analysed',  cls: 'bg-green-100 text-green-700' },
  } as const;
  const { label, cls } = MAP[stage];
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${cls}`}>
      {label}
    </span>
  );
}

function QualityBadge({ score }: { score: number }) {
  const cls =
    score >= 75 ? 'bg-green-100 text-green-700' :
    score >= 50 ? 'bg-amber-100 text-amber-700' :
                  'bg-red-100 text-red-700';
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded ${cls}`}>
      Quality {score}/100
    </span>
  );
}

function MetaStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase text-slate-400">{label}</div>
      <div className="text-sm font-semibold text-slate-700 font-mono">{value}</div>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}
