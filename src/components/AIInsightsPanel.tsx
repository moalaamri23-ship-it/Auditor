import React, { useState } from 'react';
import Icon from './Icon';
import { useActiveSession, useStore } from '../store/useStore';
import { generateInsights } from '../services/AIController';
import type { AIInsights, AIModuleInsight } from '../types';

export default function AIInsightsPanel() {
  const session   = useActiveSession();
  const { aiConfig, updateSession } = useStore();
  const [isLoading, setIsLoading] = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  if (!session?.analysisResults) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-400">
        <Icon name="wand" className="w-12 h-12" />
        <div className="text-sm">Run analysis first to enable AI Insights.</div>
      </div>
    );
  }

  const results  = session.analysisResults;
  const insights = session.aiInsights;

  const handleGenerate = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const ai = await generateInsights(results, aiConfig);
      updateSession(session.id, { aiInsights: ai });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">AI Insights</h1>
          <p className="text-sm text-slate-500 mt-1">
            {session.name} · {results.scopeWOCount.toLocaleString()} WOs · Grade {results.maturityGrade}
          </p>
        </div>
        <button
          onClick={handleGenerate}
          disabled={isLoading}
          className="bg-gradient-to-r from-brand-600 to-indigo-600 text-white px-5 py-2 rounded font-bold flex items-center gap-2 text-sm shadow hover:shadow-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <><Icon name="loader" className="w-4 h-4 animate-spin" /> Generating…</>
          ) : insights ? (
            <><Icon name="refresh" className="w-4 h-4" /> Re-generate</>
          ) : (
            <><Icon name="wand" className="w-4 h-4" /> Generate Insights</>
          )}
        </button>
      </div>

      {/* ── No API key warning ── */}
      {!aiConfig.apiKey && (
        <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded animate-enter">
          <Icon name="alertTriangle" className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold text-amber-700 text-sm">No AI provider configured</div>
            <div className="text-xs text-amber-600 mt-0.5">
              Go to <strong>Settings</strong> and add your API key to enable AI interpretation.
              All DuckDB analysis above works without AI.
            </div>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded animate-enter">
          <Icon name="xCircle" className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold text-red-700 text-sm">AI request failed</div>
            <div className="text-xs text-red-600 mt-0.5">{error}</div>
          </div>
        </div>
      )}

      {/* ── Loading state ── */}
      {isLoading && (
        <div className="bg-white border border-slate-200 rounded shadow p-8 flex flex-col items-center gap-4 animate-enter">
          <div className="flex gap-2">
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className="w-2.5 h-2.5 bg-brand-500 rounded-full animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </div>
          <div className="text-center">
            <div className="font-semibold text-slate-700 text-sm">Analysing {results.scopeWOCount.toLocaleString()} work orders…</div>
            <div className="text-xs text-slate-400 mt-1">AI is interpreting the DuckDB results — no raw data is sent</div>
          </div>
        </div>
      )}

      {/* ── Insights ── */}
      {insights && !isLoading && (
        <>
          {/* Insufficient data gate */}
          {insights.insufficientData ? (
            <div className="flex items-start gap-3 p-4 bg-slate-50 border border-slate-200 rounded animate-enter">
              <Icon name="info" className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
              <p className="text-sm text-slate-600">{insights.overallSummary}</p>
            </div>
          ) : (
            <>
              {/* Overall summary */}
              <div className="bg-white border border-slate-200 rounded shadow p-5 animate-enter">
                <div className="flex items-center gap-2 mb-3">
                  <Icon name="wand" className="w-4 h-4 text-brand-500" />
                  <span className="text-[10px] font-bold uppercase text-slate-400">AI Overall Assessment</span>
                  <span className="text-[10px] text-slate-300 ml-auto font-mono">
                    {new Date(insights.generatedAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm text-slate-700 leading-relaxed">{insights.overallSummary}</p>
              </div>

              {/* Per-module insights */}
              <div className="space-y-4">
                {insights.moduleInsights.map(m => (
                  <ModuleInsightCard key={m.moduleId} insight={m} />
                ))}
              </div>

              {/* Recommendations */}
              {insights.topRecommendations.length > 0 && (
                <div className="bg-white border border-slate-200 rounded shadow p-5 animate-enter">
                  <div className="flex items-center gap-2 mb-4">
                    <Icon name="bolt" className="w-4 h-4 text-brand-500" />
                    <span className="text-[10px] font-bold uppercase text-slate-400">Top Recommendations</span>
                  </div>
                  <ol className="space-y-3">
                    {insights.topRecommendations.map((rec, i) => (
                      <li key={i} className="flex gap-3 text-sm">
                        <span className="shrink-0 w-5 h-5 rounded-full bg-brand-600 text-white text-[10px] font-bold flex items-center justify-center mt-0.5">
                          {i + 1}
                        </span>
                        <span className="text-slate-700 leading-relaxed">{rec}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Privacy footer */}
              <div className="text-xs text-slate-400 bg-slate-50 border border-slate-200 rounded p-3 font-mono">
                AI received: {results.scopeWOCount.toLocaleString()} WO aggregates, module scores, anomaly descriptions.
                No raw rows, no equipment names, no individual work order data was sent.
              </div>
            </>
          )}
        </>
      )}

      {/* ── Empty state (no insights yet) ── */}
      {!insights && !isLoading && !error && aiConfig.apiKey && (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-slate-400 animate-enter">
          <Icon name="wand" className="w-10 h-10" />
          <div className="text-sm text-center">
            Click <strong className="text-slate-600">Generate Insights</strong> to get AI interpretation
            <br />of the {results.totalAnomalies} findings across {results.modules.length} modules.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Module insight card ──────────────────────────────────────────────────────

function ModuleInsightCard({ insight: m }: { insight: AIModuleInsight }) {
  const PRIORITY = {
    HIGH:   { bg: 'bg-red-50',   border: 'border-red-200',   badge: 'bg-red-100 text-red-700'   },
    MEDIUM: { bg: 'bg-amber-50', border: 'border-amber-200', badge: 'bg-amber-100 text-amber-700'},
    LOW:    { bg: 'bg-slate-50', border: 'border-slate-200', badge: 'bg-slate-100 text-slate-600'},
  };
  const p = PRIORITY[m.priority];

  return (
    <div className={`rounded shadow border p-5 animate-enter ${p.bg} ${p.border}`}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${p.badge}`}>
          {m.priority}
        </span>
        <span className="text-sm font-bold text-slate-800">{m.moduleName}</span>
      </div>
      {m.insight ? (
        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{m.insight}</p>
      ) : (
        <p className="text-xs text-slate-400 italic">No insight generated for this module.</p>
      )}
    </div>
  );
}
