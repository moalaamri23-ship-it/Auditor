import React, { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend,
} from 'recharts';
import Icon from './Icon';
import { useStore, useActiveProject, useRunsForProject } from '../store/useStore';
import { RULE_CHECK_LABELS } from '../analysis/RuleChecksModule';
import { FLAG_CATEGORY_LABELS } from '../analysis/AITextModule';
import type { AuditRun, FlagCategory, RuleCheckId } from '../types';

const RULE_KEYS = Object.keys(RULE_CHECK_LABELS) as RuleCheckId[];
const AI_KEYS = Object.keys(FLAG_CATEGORY_LABELS) as FlagCategory[];

export default function ComparisonView() {
  const project = useActiveProject();
  const runs = useRunsForProject(project?.id ?? null);
  const { setScreen, setActiveRun } = useStore();

  const orderedRuns = useMemo(() => runs.filter((r) => r.ruleChecks).slice(), [runs]);

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        No active project.
      </div>
    );
  }
  if (orderedRuns.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-400">
        <Icon name="activity" className="w-12 h-12" />
        <div className="text-sm">
          Comparison needs at least two analysed runs in this project.
        </div>
        <button
          onClick={() => setScreen('upload')}
          className="bg-slate-900 text-white px-4 py-2 rounded text-sm font-bold"
        >
          Upload another run
        </button>
      </div>
    );
  }

  const seriesRule = RULE_KEYS.map((id) => ({
    id,
    label: RULE_CHECK_LABELS[id].label,
  }));
  const seriesAI = AI_KEYS.map((id) => ({
    id,
    label: FLAG_CATEGORY_LABELS[id],
  }));

  const dataRule = orderedRuns.map((run) => {
    const total = run.ruleChecks!.totalWOs || 1;
    const out: Record<string, number | string> = { run: `#${run.runIndex} ${run.periodLabel}` };
    for (const id of RULE_KEYS) {
      const matched = run.ruleChecks!.perCheck[id]?.matched ?? 0;
      out[id] = Math.round((matched / total) * 1000) / 10;
    }
    return out;
  });

  const dataAI = orderedRuns.map((run) => {
    const total = run.ruleChecks!.totalWOs || 1;
    const out: Record<string, number | string> = { run: `#${run.runIndex} ${run.periodLabel}` };
    for (const id of AI_KEYS) {
      const matched = run.aiFlagSummary?.byCategory[id] ?? 0;
      out[id] = Math.round((matched / total) * 1000) / 10;
    }
    return out;
  });

  const latest = orderedRuns[orderedRuns.length - 1];
  const previous = orderedRuns[orderedRuns.length - 2];

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Comparison Mode</h1>
          <p className="text-sm text-slate-500 mt-1">
            {project.name} · {orderedRuns.length} analysed runs · % of in-scope WOs flagged per category.
          </p>
        </div>
        <button
          onClick={() => setScreen('analysis')}
          className="px-3 py-1.5 text-xs font-bold rounded border border-slate-200 bg-white text-slate-700 hover:border-brand-400 transition flex items-center gap-1.5"
        >
          <Icon name="arrowLeft" className="w-3.5 h-3.5" />
          Back to Audit
        </button>
      </div>

      <RunsStrip runs={orderedRuns} onJump={(id) => { setActiveRun(id); setScreen('analysis'); }} />

      {previous && (
        <DeltaPanel previous={previous} latest={latest} />
      )}

      <ChartCard title="Rule-Based Pre-Checks (% of WOs)" colors="amber">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={dataRule}>
            <XAxis dataKey="run" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} unit="%" />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {seriesRule.map((s, i) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={s.id}
                name={s.label}
                stroke={`hsl(${(i * 40 + 30) % 360}, 70%, 50%)`}
                dot={{ r: 3 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="AI Semantic Categories (% of WOs)" colors="indigo">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={dataAI}>
            <XAxis dataKey="run" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} unit="%" />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {seriesAI.map((s, i) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={s.id}
                name={s.label}
                stroke={`hsl(${(i * 60 + 220) % 360}, 70%, 50%)`}
                dot={{ r: 3 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

function RunsStrip({
  runs,
  onJump,
}: {
  runs: AuditRun[];
  onJump: (id: string) => void;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded shadow-sm p-3 overflow-x-auto scroll-thin">
      <div className="flex gap-2 min-w-max">
        {runs.map((r) => (
          <button
            key={r.id}
            onClick={() => onJump(r.id)}
            className="text-left px-3 py-2 rounded border border-slate-200 hover:border-brand-400 transition min-w-[180px]"
          >
            <div className="font-mono text-[10px] text-slate-400">RUN #{r.runIndex}</div>
            <div className="font-bold text-sm text-slate-800">{r.periodLabel}</div>
            <div className="text-[10px] text-slate-500 mt-1">
              {r.ruleChecks?.totalWOs.toLocaleString() ?? 0} WOs ·{' '}
              {r.aiFlagSummary?.totalFlagged ?? new Set(r.ruleChecks?.flaggedWOs?.map((f) => f.wo) ?? []).size} flagged
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function DeltaPanel({ previous, latest }: { previous: AuditRun; latest: AuditRun }) {
  const totalPrev = previous.ruleChecks!.totalWOs || 1;
  const totalLatest = latest.ruleChecks!.totalWOs || 1;

  const deltas: Array<{ label: string; previousPct: number; latestPct: number }> = [];
  for (const id of RULE_KEYS) {
    const p = (previous.ruleChecks!.perCheck[id]?.matched ?? 0) / totalPrev;
    const l = (latest.ruleChecks!.perCheck[id]?.matched ?? 0) / totalLatest;
    if (p === 0 && l === 0) continue;
    deltas.push({ label: RULE_CHECK_LABELS[id].label, previousPct: p * 100, latestPct: l * 100 });
  }
  for (const id of AI_KEYS) {
    const p = (previous.aiFlagSummary?.byCategory[id] ?? 0) / totalPrev;
    const l = (latest.aiFlagSummary?.byCategory[id] ?? 0) / totalLatest;
    if (p === 0 && l === 0) continue;
    deltas.push({ label: FLAG_CATEGORY_LABELS[id], previousPct: p * 100, latestPct: l * 100 });
  }

  return (
    <div className="bg-white border border-slate-200 rounded shadow-sm p-4">
      <div className="font-bold text-slate-700 text-sm mb-3">
        Latest vs Previous —{' '}
        <span className="text-slate-400 font-normal">
          #{previous.runIndex} {previous.periodLabel} → #{latest.runIndex} {latest.periodLabel}
        </span>
      </div>
      <div className="grid md:grid-cols-2 gap-2">
        {deltas.map((d) => {
          const delta = d.latestPct - d.previousPct;
          const cls =
            delta < -0.1 ? 'text-green-600' : delta > 0.1 ? 'text-red-600' : 'text-slate-500';
          const arrow = delta < -0.1 ? '↓' : delta > 0.1 ? '↑' : '→';
          return (
            <div
              key={d.label}
              className="flex items-center justify-between gap-3 px-3 py-2 border border-slate-100 rounded text-xs"
            >
              <span className="text-slate-700">{d.label}</span>
              <span className="font-mono">
                <span className="text-slate-400">{d.previousPct.toFixed(1)}%</span>
                {' → '}
                <span className="font-bold">{d.latestPct.toFixed(1)}%</span>
                <span className={`ml-2 font-bold ${cls}`}>
                  {arrow} {Math.abs(delta).toFixed(1)} pts
                </span>
              </span>
            </div>
          );
        })}
        {deltas.length === 0 && (
          <div className="text-xs text-slate-400 italic">No category has any flags in either run.</div>
        )}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  colors: 'amber' | 'indigo';
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded shadow-sm p-4">
      <div className="font-bold text-slate-700 text-sm mb-3">{title}</div>
      {children}
    </div>
  );
}
