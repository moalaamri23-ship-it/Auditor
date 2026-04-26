import React, { useRef, useState } from 'react';
import Icon from './Icon';
import { useStore, useActiveRun, useActiveProject } from '../store/useStore';
import { runPipeline } from '../analysis/AnalysisEngine';
import { failureCatalogStats, queryAIFlags } from '../services/DuckDBService';
import { RULE_CHECK_LABELS } from '../analysis/RuleChecksModule';
import type { RuleCheckId, RuleCheckResult } from '../types';

export default function PreChecksView() {
  const run = useActiveRun();
  const project = useActiveProject();
  const { setScreen, updateRun, aiConfig } = useStore();
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [aiPhase, setAIPhase] = useState(false);
  const [aiProgress, setAIProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef({ current: false });

  if (!run) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        No active audit run.
      </div>
    );
  }
  if (!run.ruleChecks) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-400">
        <Icon name="alertTriangle" className="w-12 h-12" />
        <div className="text-sm">No pre-check results yet.</div>
        <button
          onClick={() => setScreen('profiler')}
          className="bg-slate-900 text-white px-4 py-2 rounded text-sm font-bold"
        >
          Go to Data
        </button>
      </div>
    );
  }

  const runAI = async () => {
    setIsAnalysing(true);
    setAIPhase(true);
    setAIProgress({ done: 0, total: 0 });
    setError(null);
    cancelRef.current = { current: false };

    try {
      const stats = await failureCatalogStats();
      const catalogAvailable = !!stats && stats.total > 0;

      const { results } = await runPipeline({
        runId: run.id,
        project,
        columnMap: run.columnMap,
        filters: run.analysisFilters,
        aiConfig,
        catalogAvailable,
        onAIProgress: (done, total) => setAIProgress({ done, total }),
        cancelRef: cancelRef.current,
      });

      const flags = results.aiFlagSummary ? await queryAIFlags() : [];

      updateRun(run.id, {
        ruleChecks: results.ruleChecks,
        aiFlagSummary: results.aiFlagSummary ?? null,
        aiFlags: flags,
        stage: 'analysed',
        lastAnalysedAt: new Date().toISOString(),
      });
      setScreen('analysis');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsAnalysing(false);
      setAIPhase(false);
    }
  };

  const handleCancel = () => {
    if (cancelRef.current) cancelRef.current.current = true;
  };

  const aiKeyConfigured =
    !!aiConfig?.apiKey?.trim() ||
    aiConfig?.provider === 'copilot';

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Rule-Based Pre-Checks</h1>
        <p className="text-sm text-slate-500 mt-1">
          Database-tier checks that run instantly. Results below show counts before AI is invoked.
        </p>
      </div>

      <RuleCheckSummary result={run.ruleChecks} />
      <RuleCheckCards result={run.ruleChecks} />

      {error && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded animate-enter">
          <Icon name="xCircle" className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div className="text-sm text-red-700">{error}</div>
        </div>
      )}

      <div className="flex flex-wrap gap-3 pt-2">
        <button
          onClick={() => setScreen('profiler')}
          disabled={isAnalysing}
          className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded font-bold flex items-center gap-2 hover:bg-slate-50 transition text-sm disabled:opacity-40"
        >
          <Icon name="arrowLeft" className="w-4 h-4" />
          Back to Data
        </button>
        <button
          onClick={runAI}
          disabled={isAnalysing || !aiKeyConfigured}
          className="bg-gradient-to-r from-brand-600 to-indigo-600 text-white px-6 py-2 rounded font-bold flex items-center gap-2 text-sm shadow hover:shadow-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
          title={aiKeyConfigured ? '' : 'Configure an AI provider in Settings to run AI analysis.'}
        >
          {isAnalysing ? (
            <>
              <Icon name="loader" className="w-4 h-4 animate-spin" />
              AI Analysing…
            </>
          ) : (
            <>
              <Icon name="wand" className="w-4 h-4" />
              Run AI Analysis
            </>
          )}
        </button>
        {isAnalysing && (
          <button
            onClick={handleCancel}
            className="bg-white border border-slate-200 text-slate-600 px-3 py-2 rounded font-bold text-sm hover:bg-red-50 hover:border-red-200 hover:text-red-600 transition"
          >
            Cancel
          </button>
        )}
        <button
          onClick={() => setScreen('analysis')}
          disabled={isAnalysing}
          className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded font-bold flex items-center gap-2 hover:bg-slate-50 transition text-sm disabled:opacity-40"
        >
          Skip AI — View Audit
          <Icon name="chevronRight" className="w-4 h-4" />
        </button>
      </div>

      {!aiKeyConfigured && (
        <div className="text-xs text-amber-600 flex items-center gap-1.5">
          <Icon name="alertTriangle" className="w-3.5 h-3.5" />
          No AI provider configured.
          <button onClick={() => setScreen('settings')} className="font-bold underline">
            Configure in Settings →
          </button>
        </div>
      )}

      {isAnalysing && aiPhase && aiProgress.total > 0 && (
        <div className="bg-white border border-slate-200 rounded p-3 animate-enter">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
              <Icon name="wand" className="w-3.5 h-3.5 text-brand-500" />
              AI Semantic Analysis
            </div>
            <div className="text-xs font-mono text-slate-400">
              {aiProgress.done.toLocaleString()} / {aiProgress.total.toLocaleString()} WOs
            </div>
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-brand-500 to-indigo-500 rounded-full transition-all duration-300"
              style={{ width: `${Math.round((aiProgress.done / aiProgress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function RuleCheckSummary({ result }: { result: RuleCheckResult }) {
  const flaggedSet = new Set(result.flaggedWOs.map((f) => f.wo));
  const cleanCount = Math.max(0, result.totalWOs - flaggedSet.size);
  return (
    <div className="grid md:grid-cols-3 gap-4">
      <SummaryCard label="WOs in Scope" value={result.totalWOs} accent="text-slate-700" />
      <SummaryCard label="WOs Flagged" value={flaggedSet.size} accent="text-amber-600" />
      <SummaryCard label="Clean WOs" value={cleanCount} accent="text-green-600" />
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded p-4 shadow-sm animate-enter">
      <div className="text-[10px] font-bold uppercase text-slate-400">{label}</div>
      <div className={`text-3xl font-bold mt-1 font-mono ${accent}`}>{value.toLocaleString()}</div>
    </div>
  );
}

function RuleCheckCards({ result }: { result: RuleCheckResult }) {
  const ids = Object.keys(RULE_CHECK_LABELS) as RuleCheckId[];
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {ids.map((id) => {
        const meta = RULE_CHECK_LABELS[id];
        const bucket = result.perCheck[id];
        const matched = bucket?.matched ?? 0;
        const ran = !!bucket;
        const sevColor =
          meta.severity === 'HIGH'
            ? 'text-red-600 bg-red-50 border-red-200'
            : meta.severity === 'MEDIUM'
              ? 'text-amber-700 bg-amber-50 border-amber-200'
              : 'text-slate-600 bg-slate-50 border-slate-200';

        return (
          <div
            key={id}
            className={`border rounded shadow-sm p-4 animate-enter ${
              matched > 0 ? sevColor : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-bold text-slate-900 text-sm">{meta.label}</div>
                <div className="text-xs text-slate-500 mt-0.5">{meta.description}</div>
              </div>
              <span
                className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${
                  meta.severity === 'HIGH'
                    ? 'bg-red-100 text-red-700'
                    : meta.severity === 'MEDIUM'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-600'
                }`}
              >
                {meta.severity}
              </span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              {ran ? (
                <>
                  <span className="text-3xl font-bold font-mono">{matched.toLocaleString()}</span>
                  <span className="text-xs text-slate-500">WOs flagged</span>
                </>
              ) : (
                <span className="text-xs text-slate-400 italic">
                  Skipped — required column not mapped.
                </span>
              )}
            </div>
            {bucket && bucket.sampleWOs.length > 0 && (
              <div className="mt-3 text-[10px] font-mono text-slate-500 truncate">
                Sample: {bucket.sampleWOs.slice(0, 3).join(', ')}
                {bucket.matched > 3 ? ` … +${bucket.matched - 3}` : ''}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
