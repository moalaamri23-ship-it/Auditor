import React, { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ComposedChart, Line, Legend,
} from 'recharts';
import Icon from './Icon';
import { useActiveSession } from '../store/useStore';
import type { ModuleResult, Anomaly, ModuleStatus } from '../analysis/analysisTypes';

type ModuleId = 'data-integrity' | 'reliability' | 'process';

const MODULE_NAV: { id: ModuleId; label: string; icon: React.ComponentProps<typeof Icon>['name'] }[] = [
  { id: 'data-integrity', label: 'Data Integrity',      icon: 'shield'   },
  { id: 'reliability',    label: 'Reliability Analysis', icon: 'activity' },
  { id: 'process',        label: 'Process Compliance',   icon: 'clock'    },
];

export default function AnalysisView() {
  const session = useActiveSession();
  const [activeModule, setActiveModule] = useState<ModuleId>('data-integrity');

  if (!session?.analysisResults) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        No analysis results. Run analysis from the Data Profiler screen.
      </div>
    );
  }

  const results   = session.analysisResults;
  const moduleResult = results.modules.find(m => m.moduleId === activeModule);

  return (
    <div className="flex h-full">

      {/* ── Left nav ── */}
      <aside className="w-56 bg-white border-r border-slate-200 shrink-0 flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200">
          <div className="text-[10px] font-bold uppercase text-slate-400">Analysis Modules</div>
        </div>
        <nav className="flex-1 py-2">
          {MODULE_NAV.map(nav => {
            const mod = results.modules.find(m => m.moduleId === nav.id);
            const active = activeModule === nav.id;
            return (
              <button
                key={nav.id}
                onClick={() => setActiveModule(nav.id)}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition ${
                  active
                    ? 'bg-brand-50 border-r-2 border-brand-600 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Icon name={nav.icon} className="w-4 h-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-bold truncate ${active ? 'text-brand-700' : ''}`}>
                    {nav.label}
                  </div>
                  {mod && (
                    <div className={`text-[10px] font-mono ${statusColor(mod.status)}`}>
                      {mod.score}/100
                    </div>
                  )}
                </div>
                {mod && <StatusDot status={mod.status} />}
              </button>
            );
          })}
        </nav>

        {/* Summary at bottom */}
        <div className="p-4 border-t border-slate-200 bg-slate-50">
          <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">Overall</div>
          <div className="text-2xl font-bold font-mono text-slate-900">
            {results.maturityGrade}
            <span className="text-sm text-slate-400 ml-1">{results.maturityScore}/100</span>
          </div>
        </div>
      </aside>

      {/* ── Module content ── */}
      <main className="flex-1 overflow-auto scroll-thin p-6">
        {moduleResult ? (
          <ModulePanel module={moduleResult} />
        ) : (
          <div className="text-slate-400 text-sm">Module not found.</div>
        )}
      </main>
    </div>
  );
}

// ─── Module panel (adapts per module) ────────────────────────────────────────

function ModulePanel({ module: mod }: { module: ModuleResult }) {
  return (
    <div className="space-y-6 animate-enter">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">{mod.moduleName}</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Computed {new Date(mod.computedAt).toLocaleTimeString()} · {mod.anomalies.length} issue(s)
          </p>
        </div>
        <div className={`px-3 py-1.5 rounded-lg text-sm font-bold ${statusBadge(mod.status)}`}>
          {mod.status.toUpperCase()} · {mod.score}/100
        </div>
      </div>

      {/* Key metric */}
      <div className="bg-white rounded shadow border border-slate-200 p-5">
        <div className="text-[10px] font-bold uppercase text-slate-400">{mod.keyMetric.label}</div>
        <div className="text-4xl font-bold font-mono text-slate-900 mt-1">{mod.keyMetric.value}</div>
        {mod.keyMetric.unit && <span className="text-lg text-slate-400 ml-1">{mod.keyMetric.unit}</span>}
        {mod.keyMetric.note && (
          <div className="mt-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded">
            ⚠ {mod.keyMetric.note}
          </div>
        )}
      </div>

      {/* Warnings */}
      {mod.warnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-1">
          <div className="text-xs font-bold text-amber-700 flex items-center gap-1.5 mb-2">
            <Icon name="alertTriangle" className="w-4 h-4" />
            Data Readiness Notes
          </div>
          {mod.warnings.map((w, i) => (
            <div key={i} className="text-xs text-amber-700 flex gap-2">
              <span className="text-amber-400">·</span> {w}
            </div>
          ))}
        </div>
      )}

      {/* Module-specific charts */}
      {mod.moduleId === 'data-integrity' && <DataIntegrityCharts metrics={mod.metrics} />}
      {mod.moduleId === 'reliability'    && <ReliabilityCharts   metrics={mod.metrics} />}
      {mod.moduleId === 'process'        && <ProcessCharts       metrics={mod.metrics} />}

      {/* Anomalies */}
      {mod.anomalies.length > 0 && <AnomalyList anomalies={mod.anomalies} />}

      {/* Empty */}
      {mod.anomalies.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex gap-3">
          <Icon name="checkCircle" className="w-5 h-5 text-green-500 shrink-0" />
          <div className="text-sm text-green-700">No anomalies detected in this module.</div>
        </div>
      )}
    </div>
  );
}

// ─── Data integrity charts ────────────────────────────────────────────────────

function DataIntegrityCharts({ metrics }: { metrics: Record<string, unknown> }) {
  const nullRates = (metrics.nullRates as { col: string; label: string; pct: number }[] | undefined) ?? [];
  if (nullRates.length === 0) return null;

  return (
    <div className="bg-white rounded shadow border border-slate-200 p-5">
      <div className="font-bold text-slate-700 text-sm mb-4">Null Rate by Column</div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={nullRates} layout="vertical" margin={{ left: 120, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={120} />
            <Tooltip formatter={(v: number) => [`${v}%`, 'Null Rate']} />
            <Bar
              dataKey="pct"
              radius={[0, 4, 4, 0]}
              fill="#2563eb"
              label={{ position: 'right', fontSize: 11, formatter: (v: number) => `${v}%` }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="text-xs text-slate-400 mt-2">
        {(metrics.totalWOs as number ?? 0).toLocaleString()} work orders analysed via v_wo_primary
      </div>
    </div>
  );
}

// ─── Reliability charts ───────────────────────────────────────────────────────

function ReliabilityCharts({ metrics }: { metrics: Record<string, unknown> }) {
  const paretoData = (metrics.paretoData as { equipment: string; count: number; cumPct: number }[] | undefined) ?? [];
  const eqMetrics  = (metrics.equipmentMetrics as { equipment: string; failureCount: number; mtbfDays: number | null; mttrHours: number | null; availability: number | null }[] | undefined) ?? [];

  return (
    <div className="space-y-5">

      {/* Fleet metrics */}
      <div className="grid grid-cols-3 gap-4">
        <MetricCard
          label="Fleet MTBF"
          value={metrics.fleetMTBFDays != null ? `${metrics.fleetMTBFDays} days` : 'N/A'}
          note={metrics.fleetMTBFDays == null ? 'Insufficient date data' : undefined}
        />
        <MetricCard
          label="Fleet MTTR"
          value={metrics.fleetMTTRHours != null ? `${metrics.fleetMTTRHours} hrs` : 'N/A'}
          note={metrics.fleetMTTRHours == null ? 'Insufficient date data' : undefined}
        />
        <MetricCard
          label="Fleet Availability"
          value={metrics.fleetAvailabilityPct != null ? `${metrics.fleetAvailabilityPct}%` : 'N/A'}
          note={metrics.fleetAvailabilityPct == null ? 'Requires MTBF + MTTR' : undefined}
        />
      </div>

      {/* Pareto chart */}
      {paretoData.length > 0 && (
        <div className="bg-white rounded shadow border border-slate-200 p-5">
          <div className="font-bold text-slate-700 text-sm mb-1">Failure Pareto — Equipment</div>
          <div className="text-xs text-slate-400 mb-4">
            {metrics.vitalFewCount as number ?? 0} equipment accounts for 80% of all failures
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={paretoData.slice(0, 15)} margin={{ bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="equipment" angle={-40} textAnchor="end" tick={{ fontSize: 10 }} interval={0} />
                <YAxis yAxisId="left"  label={{ value: 'WOs', angle: -90, position: 'insideLeft', fontSize: 11 }} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number, name: string) => [name === 'cumPct' ? `${v}%` : v, name === 'cumPct' ? 'Cumulative %' : 'Failures']} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="left" dataKey="count" name="Failures" fill="#2563eb" radius={[4, 4, 0, 0]} />
                <Line yAxisId="right" dataKey="cumPct" name="Cumulative %" stroke="#f59e0b" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Per-equipment table */}
      {eqMetrics.length > 0 && (
        <div className="bg-white rounded shadow border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 text-xs font-bold uppercase text-slate-500">
            Equipment Metrics (top 20 by failure count)
          </div>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full merged-table">
              <thead>
                <tr>
                  <th className="text-left">Equipment</th>
                  <th className="text-right">Failures</th>
                  <th className="text-right">MTBF (days)</th>
                  <th className="text-right">MTTR (hrs)</th>
                  <th className="text-right">Availability</th>
                </tr>
              </thead>
              <tbody>
                {eqMetrics.slice(0, 15).map(e => (
                  <tr key={e.equipment} className="hover:bg-slate-50">
                    <td className="font-mono text-xs font-bold">{e.equipment}</td>
                    <td className="text-right font-mono text-xs">{e.failureCount}</td>
                    <td className="text-right font-mono text-xs">{e.mtbfDays ?? '—'}</td>
                    <td className="text-right font-mono text-xs">{e.mttrHours ?? '—'}</td>
                    <td className="text-right">
                      {e.availability != null ? (
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${e.availability >= 90 ? 'bg-green-100 text-green-700' : e.availability >= 75 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                          {e.availability}%
                        </span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(metrics.dataReadinessReasons as string[] | undefined ?? []).length > 0 && (
            <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 text-xs text-amber-700">
              ⚠ These metrics may be understated. See Data Readiness notes above.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Process charts ───────────────────────────────────────────────────────────

function ProcessCharts({ metrics }: { metrics: Record<string, unknown> }) {
  const eqLag = (metrics.equipmentResponseLag as { equipment: string; count: number; avgHours: number }[] | undefined) ?? [];

  return (
    <div className="space-y-5">
      {/* KPI grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="Schedule Adherence" value={metrics.scheduleAdherenceRate != null ? `${metrics.scheduleAdherenceRate}%` : 'N/A'} />
        <MetricCard label="Avg Response Lag"   value={metrics.avgResponseLagHours    != null ? `${metrics.avgResponseLagHours} hrs` : 'N/A'} />
        <MetricCard label="Confirmation Cover" value={metrics.confirmationCompleteness != null ? `${metrics.confirmationCompleteness}%` : 'N/A'} />
        <MetricCard label="Avg Delay (days)"   value={metrics.avgScheduleDelayDays != null ? `${metrics.avgScheduleDelayDays}d` : 'N/A'} />
      </div>

      {/* Missing dates row */}
      <div className="grid grid-cols-2 gap-4">
        <MissingDateCard label="WOs Missing Actual Start"  count={metrics.wosWithNoActualStart as number}  total={metrics.totalWOs as number} />
        <MissingDateCard label="WOs Missing Actual Finish" count={metrics.wosWithNoActualFinish as number} total={metrics.totalWOs as number} />
      </div>

      {/* Equipment response lag chart */}
      {eqLag.length > 0 && (
        <div className="bg-white rounded shadow border border-slate-200 p-5">
          <div className="font-bold text-slate-700 text-sm mb-4">Response Lag by Equipment (hrs, notification → actual start)</div>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={eqLag.slice(0, 12)} layout="vertical" margin={{ left: 120, right: 40 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickFormatter={v => `${v}h`} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="equipment" tick={{ fontSize: 10 }} width={120} />
                <Tooltip formatter={(v: number) => [`${v} hrs`, 'Avg Response Lag']} />
                <Bar dataKey="avgHours" fill="#f59e0b" radius={[0, 4, 4, 0]}
                  label={{ position: 'right', fontSize: 10, formatter: (v: number) => `${v}h` }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Anomaly list ─────────────────────────────────────────────────────────────

function AnomalyList({ anomalies }: { anomalies: Anomaly[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="bg-white rounded shadow border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 text-xs font-bold uppercase text-slate-500">
        Issues ({anomalies.length})
      </div>
      <div className="divide-y divide-slate-100">
        {anomalies.map(a => (
          <div key={a.id}>
            <button
              onClick={() => setExpanded(expanded === a.id ? null : a.id)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition text-left"
            >
              <SeverityBadge severity={a.severity} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-slate-800">{a.label}</div>
                <div className="text-xs text-slate-500 mt-0.5 truncate">{a.description.slice(0, 100)}</div>
              </div>
              <div className="shrink-0 text-[10px] font-mono text-slate-400">
                {a.affectedCount}/{a.totalCount}
              </div>
              <Icon name={expanded === a.id ? 'chevronUp' : 'chevronDown'} className="w-4 h-4 text-slate-400 shrink-0" />
            </button>

            {expanded === a.id && (
              <div className="px-4 pb-4 pt-1 bg-slate-50 border-t border-slate-100 animate-enter">
                <p className="text-sm text-slate-700 mb-3">{a.description}</p>

                <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">SQL Basis</div>
                <div className="font-mono text-xs text-slate-600 bg-white border border-slate-200 rounded px-3 py-2 mb-3">
                  {a.sqlBasis}
                </div>

                {a.samples.length > 0 && (
                  <>
                    <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">Samples</div>
                    <div className="space-y-1">
                      {a.samples.map((s, i) => (
                        <div key={i} className="flex gap-2 text-xs text-slate-600 bg-white border border-slate-200 rounded px-3 py-1.5">
                          {s.wo        && <span className="font-mono font-bold">{s.wo}</span>}
                          {s.equipment && <span className="text-slate-400">·</span>}
                          {s.equipment && <span>{s.equipment}</span>}
                          {s.value     && <span className="text-slate-400">·</span>}
                          {s.value     && <span className="font-mono">{s.value}</span>}
                          {s.flag      && <span className="ml-auto text-amber-600 font-bold">{s.flag}</span>}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function MetricCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-white rounded shadow border border-slate-200 p-4">
      <div className="text-[10px] font-bold uppercase text-slate-400">{label}</div>
      <div className="text-2xl font-bold font-mono text-slate-900 mt-1">{value}</div>
      {note && <div className="text-[10px] text-amber-600 mt-1">{note}</div>}
    </div>
  );
}

function MissingDateCard({ label, count, total }: { label: string; count: number | undefined; total: number | undefined }) {
  if (count == null || total == null) return null;
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="bg-white rounded shadow border border-slate-200 p-4">
      <div className="text-[10px] font-bold uppercase text-slate-400">{label}</div>
      <div className="text-2xl font-bold font-mono text-slate-900 mt-1">{count.toLocaleString()}</div>
      <div className="text-xs text-slate-400 mt-1">{pct}% of all WOs</div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-2">
        <div className={`h-full rounded-full ${pct > 30 ? 'bg-red-400' : pct > 15 ? 'bg-amber-400' : 'bg-green-400'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const cls =
    severity === 'HIGH'   ? 'bg-red-100 text-red-700' :
    severity === 'MEDIUM' ? 'bg-amber-100 text-amber-700' :
    severity === 'LOW'    ? 'bg-yellow-100 text-yellow-700' :
                            'bg-slate-100 text-slate-500';
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded shrink-0 ${cls}`}>
      {severity}
    </span>
  );
}

function StatusDot({ status }: { status: ModuleStatus }) {
  const cls =
    status === 'pass'        ? 'bg-green-400' :
    status === 'warning'     ? 'bg-amber-400' :
    status === 'critical'    ? 'bg-red-500'   :
                               'bg-slate-300';
  return <div className={`w-2 h-2 rounded-full shrink-0 ${cls}`} />;
}

function statusColor(status: ModuleStatus): string {
  return status === 'pass'     ? 'text-green-600' :
         status === 'warning'  ? 'text-amber-600' :
         status === 'critical' ? 'text-red-600'   :
                                 'text-slate-400';
}

function statusBadge(status: ModuleStatus): string {
  return status === 'pass'        ? 'bg-green-100 text-green-700' :
         status === 'warning'     ? 'bg-amber-100 text-amber-700' :
         status === 'critical'    ? 'bg-red-100 text-red-700'     :
                                    'bg-slate-100 text-slate-500';
}
