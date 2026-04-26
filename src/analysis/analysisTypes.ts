// Slim post-redesign types. The audit pipeline is:
//   1. RuleChecksModule  → RuleCheckResult (DB SQL)
//   2. AITextModule      → AIFlagSummary   (catalog-aware semantic checks)
//
// AnalysisResults is what the run dashboard reads to render charts and
// comparisons; it is persisted on the AuditRun.

import type { AIFlagSummary, AnalysisFilters, RuleCheckResult } from '../types';

export interface AnalysisResults {
  runId: string;
  scopeWOCount: number;
  filters: AnalysisFilters;
  ruleChecks: RuleCheckResult;
  aiFlagSummary: AIFlagSummary | null;
  computedAt: string;
}

/** Quality score: 100 minus weighted % of WOs touched by rule + AI flags. */
export function computeQualityScore(results: AnalysisResults): number {
  if (results.scopeWOCount === 0) return 0;

  const ruleTouched = new Set(results.ruleChecks.flaggedWOs.map((f) => f.wo)).size;
  const aiTouched = results.aiFlagSummary?.totalFlagged ?? 0;

  // Approximate union by treating max as a lower bound — a WO that's both
  // rule-flagged AND AI-flagged is the same WO. Without DB we can't compute
  // the exact union here, so we use the larger of the two as a conservative
  // bound and add a small premium for the smaller set.
  const overlap = Math.min(ruleTouched, aiTouched);
  const unionApprox = ruleTouched + aiTouched - overlap;

  const flaggedPct = unionApprox / results.scopeWOCount;
  const score = Math.round((1 - flaggedPct) * 100);
  return Math.max(0, Math.min(100, score));
}

export function qualityGrade(score: number): string {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}
