/**
 * Analysis Engine
 *
 * Orchestrates all analysis modules and assembles the final AnalysisResults.
 * Creates v_analysis_scope from active filters before running modules — all
 * modules query v_analysis_scope, never v_wo_primary directly.
 */

import { runDataIntegrityModule } from './DataIntegrityModule';
import { runReliabilityModule }   from './ReliabilityModule';
import { runProcessModule }       from './ProcessModule';
import { createAnalysisScopeView } from '../services/DuckDBService';
import {
  computeMaturityScore,
  maturityGrade,
  type AnalysisResults,
} from './analysisTypes';
import type { ColumnMap, AnalysisFilters } from '../types';
import { EMPTY_FILTERS } from '../types';

export async function runAllModules(
  sessionId: string,
  columnMap: ColumnMap,
  filters: AnalysisFilters = EMPTY_FILTERS
): Promise<AnalysisResults> {

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

  return {
    sessionId,
    maturityScore:  maturity,
    maturityGrade:  grade,
    modules,
    totalAnomalies,
    scopeWOCount,
    filters,
    computedAt: new Date().toISOString(),
  };
}
