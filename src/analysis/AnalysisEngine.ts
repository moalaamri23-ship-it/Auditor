// Audit pipeline orchestrator.
//
//   1. createAnalysisScopeView() — applies project bank pattern + run filters
//      and produces v_analysis_scope (the WO-level subset every check operates on).
//   2. runRuleChecks()           — pure DB SQL pre-checks.
//   3. runAITextModule()         — catalog-aware semantic checks, scoped to
//                                  the rule-flagged subset (or all WOs if
//                                  no rule flags exist and AI is enabled).
//
// The function is interruptible via cancelRef for the AI phase.

import { runRuleChecks } from './RuleChecksModule';
import { runAITextModule } from './AITextModule';
import { createAnalysisScopeView } from '../services/DuckDBService';
import type {
  ColumnMap, AnalysisFilters, AIConfig, AuditProject,
  RuleCheckResult, AIFlagSummary,
} from '../types';
import { EMPTY_FILTERS } from '../types';
import type { AnalysisResults } from './analysisTypes';

export interface RunPipelineOptions {
  runId: string;
  project: AuditProject | null;
  columnMap: ColumnMap;
  filters?: AnalysisFilters;
  aiConfig?: AIConfig;
  catalogAvailable: boolean;
  /** Skip the AI phase (pre-checks-only, for the dedicated PreChecks screen). */
  ruleChecksOnly?: boolean;
  onAIProgress?: (processed: number, total: number) => void;
  cancelRef?: { current: boolean };
}

export interface PipelineOutput {
  results: AnalysisResults;
  scopeWOCount: number;
  ruleChecks: RuleCheckResult;
  aiFlagSummary: AIFlagSummary | null;
}

export async function runPipeline(opts: RunPipelineOptions): Promise<PipelineOutput> {
  const {
    runId,
    project,
    columnMap,
    catalogAvailable,
    ruleChecksOnly,
    onAIProgress,
  } = opts;
  const filters = opts.filters ?? EMPTY_FILTERS;
  const cancelRef = opts.cancelRef ?? { current: false };
  const aiConfig = opts.aiConfig;

  const scopeWOCount = await createAnalysisScopeView(filters, columnMap, project);

  const ruleChecks = await runRuleChecks({ columnMap, catalogAvailable });

  let aiFlagSummary: AIFlagSummary | null = null;
  const aiEnabled =
    !ruleChecksOnly &&
    aiConfig &&
    (aiConfig.apiKey?.trim() || aiConfig.provider === 'copilot') &&
    scopeWOCount > 0;

  if (aiEnabled) {
    try {
      aiFlagSummary = await runAITextModule({
        runId,
        columnMap,
        aiConfig,
        catalogAvailable,
        scopeWOCount,
        onProgress: onAIProgress ?? (() => {}),
        cancelRef,
      });
    } catch (err) {
      console.warn('AI text module failed', err);
    }
  }

  const results: AnalysisResults = {
    runId,
    scopeWOCount,
    filters,
    ruleChecks,
    aiFlagSummary,
    computedAt: new Date().toISOString(),
  };

  return { results, scopeWOCount, ruleChecks, aiFlagSummary };
}
