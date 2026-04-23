/**
 * Analysis Engine
 *
 * Orchestrates all analysis modules and assembles the final AnalysisResults.
 * Creates v_analysis_scope from active filters before running modules — all
 * modules query v_analysis_scope, never v_wo_primary directly.
 *
 * If aiConfig is provided (and has an apiKey), also runs AITextModule which
 * sends WO text fields in batches to the AI for per-record flagging.
 */

import { runDataIntegrityModule } from './DataIntegrityModule';
import { runReliabilityModule }   from './ReliabilityModule';
import { runProcessModule }       from './ProcessModule';
import { runAITextModule }        from './AITextModule';
import { createAnalysisScopeView } from '../services/DuckDBService';
import {
  computeMaturityScore,
  maturityGrade,
  type AnalysisResults,
} from './analysisTypes';
import type { ColumnMap, AnalysisFilters, AIConfig } from '../types';
import { EMPTY_FILTERS } from '../types';

export interface RunAllModulesOptions {
  sessionId:    string;
  columnMap:    ColumnMap;
  filters?:     AnalysisFilters;
  aiConfig?:    AIConfig;
  onAIProgress?: (processed: number, total: number) => void;
  cancelRef?:   { current: boolean };
}

export async function runAllModules(
  sessionIdOrOpts: string | RunAllModulesOptions,
  columnMapArg?:   ColumnMap,
  filtersArg?:     AnalysisFilters
): Promise<AnalysisResults> {

  // Support both calling styles:
  //   runAllModules(sessionId, columnMap, filters)          ← legacy
  //   runAllModules({ sessionId, columnMap, filters, ... }) ← new
  let sessionId: string;
  let columnMap: ColumnMap;
  let filters: AnalysisFilters;
  let aiConfig: AIConfig | undefined;
  let onAIProgress: ((p: number, t: number) => void) | undefined;
  let cancelRef: { current: boolean };

  if (typeof sessionIdOrOpts === 'string') {
    sessionId    = sessionIdOrOpts;
    columnMap    = columnMapArg!;
    filters      = filtersArg ?? EMPTY_FILTERS;
    cancelRef    = { current: false };
  } else {
    sessionId    = sessionIdOrOpts.sessionId;
    columnMap    = sessionIdOrOpts.columnMap;
    filters      = sessionIdOrOpts.filters ?? EMPTY_FILTERS;
    aiConfig     = sessionIdOrOpts.aiConfig;
    onAIProgress = sessionIdOrOpts.onAIProgress;
    cancelRef    = sessionIdOrOpts.cancelRef ?? { current: false };
  }

  // Build the scoped view — all modules query v_analysis_scope
  const scopeWOCount = await createAnalysisScopeView(filters, columnMap);

  const [dataIntegrity, reliability, process] = await Promise.all([
    runDataIntegrityModule(columnMap),
    runReliabilityModule(columnMap),
    runProcessModule(columnMap),
  ]);

  const modules = [dataIntegrity, reliability, process];

  const maturity = computeMaturityScore(modules);
  const grade    = maturityGrade(maturity);
  const totalAnomalies = modules.reduce((s, m) => s + m.anomalies.length, 0);

  const results: AnalysisResults = {
    sessionId,
    maturityScore:  maturity,
    maturityGrade:  grade,
    modules,
    totalAnomalies,
    scopeWOCount,
    filters,
    computedAt: new Date().toISOString(),
  };

  // ── AI text analysis (optional) ──────────────────────────────────────────
  if ((aiConfig?.apiKey?.trim() || aiConfig?.provider === 'copilot') && scopeWOCount > 0) {
    try {
      const summary = await runAITextModule({
        sessionId,
        columnMap,
        aiConfig,
        scopeWOCount,
        onProgress: onAIProgress ?? (() => {}),
        cancelRef,
      });
      results.aiFlagSummary = summary;
    } catch {
      // AI phase failure is non-fatal — DuckDB results are still valid
    }
  }

  return results;
}
