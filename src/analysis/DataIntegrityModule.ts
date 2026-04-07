/**
 * Module 1 — Data Integrity Audit
 *
 * Assesses the structural trustworthiness of the dataset before any
 * reliability metrics are computed. Produces a data readiness verdict:
 * which metrics CAN be trusted, and which cannot — and why.
 *
 * All SQL runs against v_analysis_scope (one row per WO).
 */

import { query } from '../services/DuckDBService';
import type { ColumnMap } from '../types';
import type { ModuleResult, Anomaly } from './analysisTypes';
import { TIMESTAMP_COLUMNS } from '../constants';

export async function runDataIntegrityModule(columnMap: ColumnMap): Promise<ModuleResult> {
  const anomalies: Anomaly[] = [];
  const warnings: string[] = [];
  const metrics: Record<string, unknown> = {};

  const has = (col: keyof ColumnMap) => !!columnMap[col];

  // ── 1. Total WOs in scope ────────────────────────────────────────────────
  const [totRow] = await query('SELECT COUNT(*) AS cnt FROM v_analysis_scope');
  const totalWOs = Number(totRow?.cnt ?? 0);
  metrics.totalWOs = totalWOs;

  if (totalWOs === 0) {
    return {
      moduleId:   'data-integrity',
      moduleName: 'Data Integrity',
      status:     'insufficient',
      score:      0,
      keyMetric:  { label: 'Work Orders', value: '0', note: 'No data loaded' },
      anomalies:  [],
      metrics,
      warnings:   ['No work orders found in the dataset.'],
      computedAt: new Date().toISOString(),
    };
  }

  // ── 2. Null rates on critical columns ────────────────────────────────────
  const criticals: Array<{ col: keyof ColumnMap; label: string; weight: number }> = [
    { col: 'work_order_number',  label: 'Work Order Number',  weight: 3 },
    { col: 'actual_start_date',  label: 'Actual Start Date',  weight: 2 },
    { col: 'actual_finish_date', label: 'Actual Finish Date', weight: 2 },
    { col: 'notification_date',  label: 'Notification Date',  weight: 1 },
    { col: 'confirmation_text',  label: 'Confirmation Text',  weight: 2 },
    { col: 'equipment',          label: 'Equipment',          weight: 1 },
  ];

  const nullRates: { col: string; label: string; pct: number }[] = [];

  for (const { col, label } of criticals) {
    if (!has(col)) continue;
    const [nr] = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(${col as string}) AS non_null
      FROM v_analysis_scope
    `);
    const total   = Number(nr?.total    ?? 0);
    const nonNull = Number(nr?.non_null ?? 0);
    const pct     = total > 0 ? Math.round(((total - nonNull) / total) * 100) : 0;
    nullRates.push({ col: col as string, label, pct });

    if (pct > 50) {
      anomalies.push({
        id:            `null-critical-${col}`,
        moduleId:      'data-integrity',
        severity:      'HIGH',
        type:          'HIGH_NULL_RATE',
        label:         `${pct}% null — ${label}`,
        description:   `${pct}% of work orders have no value in "${label}". This column is critical for reliability calculations.`,
        sqlBasis:      `SELECT COUNT(*) - COUNT(${col}) FROM v_analysis_scope`,
        affectedCount: total - nonNull,
        totalCount:    total,
        score:         Math.min(100, pct * 1.5),
        samples:       [],
      });
    } else if (pct > 20) {
      anomalies.push({
        id:            `null-warning-${col}`,
        moduleId:      'data-integrity',
        severity:      'MEDIUM',
        type:          'ELEVATED_NULL_RATE',
        label:         `${pct}% null — ${label}`,
        description:   `${pct}% of work orders are missing "${label}". Results using this column should be treated with caution.`,
        sqlBasis:      `SELECT COUNT(*) - COUNT(${col}) FROM v_analysis_scope`,
        affectedCount: total - nonNull,
        totalCount:    total,
        score:         Math.round(pct * 0.8),
        samples:       [],
      });
    }
  }
  metrics.nullRates = nullRates;

  // ── 3. Reversed timestamps ───────────────────────────────────────────────
  if (has('actual_start_date') && has('actual_finish_date')) {
    const [revRow] = await query(`
      SELECT COUNT(*) AS cnt FROM v_analysis_scope
      WHERE actual_start_date IS NOT NULL
        AND actual_finish_date IS NOT NULL
        AND actual_finish_date < actual_start_date
    `);
    const reversed = Number(revRow?.cnt ?? 0);
    metrics.reversedTimestamps = reversed;

    if (reversed > 0) {
      // Fetch samples
      const sampleRows = await query(`
        SELECT work_order_number, actual_start_date::VARCHAR AS s, actual_finish_date::VARCHAR AS f
        FROM v_analysis_scope
        WHERE actual_finish_date < actual_start_date
        LIMIT 5
      `);
      anomalies.push({
        id:            'reversed-timestamps',
        moduleId:      'data-integrity',
        severity:      'HIGH',
        type:          'REVERSED_TIMESTAMPS',
        label:         `${reversed} reversed timestamp${reversed > 1 ? 's' : ''}`,
        description:   `${reversed} work order(s) have actual_finish_date earlier than actual_start_date. These WOs are excluded from all duration calculations (MTTR, repair time). This is a data entry error — likely caused by manual corrections or SAP back-dating.`,
        sqlBasis:      'SELECT ... WHERE actual_finish_date < actual_start_date',
        affectedCount: reversed,
        totalCount:    totalWOs,
        score:         Math.min(100, reversed * 10),
        samples:       sampleRows.slice(0, 5).map(r => ({
          wo:    String(r.work_order_number ?? ''),
          value: `Start: ${r.s} → Finish: ${r.f}`,
          flag:  'reversed',
        })),
      });
      warnings.push(`${reversed} WOs have reversed timestamps — duration metrics (MTTR) may be understated.`);
    }
  }

  // ── 4. WOs with no timestamps at all ─────────────────────────────────────
  const availableTimestamps = TIMESTAMP_COLUMNS.filter(c => has(c as keyof ColumnMap));
  if (availableTimestamps.length > 0) {
    const nullChecks = availableTimestamps.map(c => `${c} IS NULL`).join(' AND ');
    const [noTsRow] = await query(`
      SELECT COUNT(*) AS cnt FROM v_analysis_scope WHERE ${nullChecks}
    `);
    const noTs = Number(noTsRow?.cnt ?? 0);
    metrics.wosWithNoTimestamps = noTs;

    if (noTs > 0) {
      const pct = Math.round((noTs / totalWOs) * 100);
      anomalies.push({
        id:            'no-timestamps',
        moduleId:      'data-integrity',
        severity:      pct > 20 ? 'HIGH' : 'MEDIUM',
        type:          'NO_TIMESTAMPS',
        label:         `${noTs} WOs with no dates`,
        description:   `${noTs} work order(s) (${pct}%) have no timestamps in any date column. These cannot be used for MTBF, MTTR, or timeline analysis.`,
        sqlBasis:      `SELECT ... WHERE ${nullChecks}`,
        affectedCount: noTs,
        totalCount:    totalWOs,
        score:         Math.min(100, pct * 1.2),
        samples:       [],
      });
    }
  }

  // ── 5. WOs with no confirmation text ─────────────────────────────────────
  if (has('confirmation_text')) {
    const [noConfRow] = await query(`
      SELECT COUNT(*) AS cnt FROM v_analysis_scope
      WHERE confirmation_text IS NULL OR TRIM(confirmation_text) = ''
    `);
    const noConf = Number(noConfRow?.cnt ?? 0);
    const pct    = Math.round((noConf / totalWOs) * 100);
    metrics.wosWithNoConfirmation = noConf;
    metrics.confirmationCompleteness = 100 - pct;

    if (pct > 30) {
      anomalies.push({
        id:            'no-confirmation',
        moduleId:      'data-integrity',
        severity:      pct > 60 ? 'HIGH' : 'MEDIUM',
        type:          'LOW_CONFIRMATION_COVERAGE',
        label:         `${pct}% WOs have no confirmation text`,
        description:   `${noConf} work order(s) (${pct}%) have no confirmation text recorded. Confirmation text is the primary ground truth for what maintenance was actually performed. AI analysis quality is reduced when this field is sparse.`,
        sqlBasis:      'SELECT ... WHERE confirmation_text IS NULL OR TRIM(confirmation_text) = \'\'',
        affectedCount: noConf,
        totalCount:    totalWOs,
        score:         Math.round(pct * 0.6),
        samples:       [],
      });
    }
  }

  // ── 6. Reliability code coverage ──────────────────────────────────────────
  const hasAnyCodes = has('reliability_code_1') || has('reliability_code_2') || has('reliability_code_3');
  if (hasAnyCodes) {
    const codeCol = columnMap.reliability_code_1 ? 'reliability_code_1'
                  : columnMap.reliability_code_2 ? 'reliability_code_2'
                  : 'reliability_code_3';
    const [codeRow] = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(${codeCol}) FILTER (WHERE ${codeCol} IS NOT NULL AND TRIM(${codeCol}) <> '') AS with_code
      FROM v_analysis_scope
    `);
    const total    = Number(codeRow?.total     ?? 0);
    const withCode = Number(codeRow?.with_code ?? 0);
    const codePct  = total > 0 ? Math.round((withCode / total) * 100) : 0;
    metrics.reliabilityCodeCoverage = codePct;

    if (codePct < 50) {
      warnings.push(`Only ${codePct}% of WOs have reliability codes filled. Code-based failure classification is unreliable — text analysis should be preferred.`);
    }
  }

  // ── 7. Data readiness verdicts ────────────────────────────────────────────
  const verdicts: string[] = [];
  const startNullRate = (nullRates.find(n => n.col === 'actual_start_date')?.pct ?? 100);
  const finishNullRate = (nullRates.find(n => n.col === 'actual_finish_date')?.pct ?? 100);
  const confNullRate = (nullRates.find(n => n.col === 'confirmation_text')?.pct ?? 100);

  if (startNullRate > 30 || finishNullRate > 30) {
    verdicts.push(`MTTR is unreliable: ${Math.max(startNullRate, finishNullRate)}% of WOs are missing start or finish dates.`);
  } else {
    verdicts.push('MTTR is computable: sufficient start and finish dates available.');
  }

  if (metrics.reversedTimestamps && (metrics.reversedTimestamps as number) > 0) {
    verdicts.push(`${metrics.reversedTimestamps} WOs excluded from duration calculations due to reversed timestamps.`);
  }

  if (confNullRate > 50) {
    verdicts.push(`Confirmation quality analysis limited: ${confNullRate}% of WOs lack confirmation text.`);
  }

  metrics.verdicts = verdicts;

  // ── 8. Compute module score ───────────────────────────────────────────────
  let score = 100;
  for (const a of anomalies) {
    if (a.severity === 'HIGH')   score -= 15;
    if (a.severity === 'MEDIUM') score -= 7;
    if (a.severity === 'LOW')    score -= 3;
  }
  score = Math.max(0, Math.min(100, score));

  const status = score >= 75 ? 'pass' : score >= 50 ? 'warning' : 'critical';

  const confCoverage = metrics.confirmationCompleteness ?? '—';

  return {
    moduleId:   'data-integrity',
    moduleName: 'Data Integrity',
    status,
    score,
    keyMetric: {
      label: 'Data Quality Score',
      value: `${score}`,
      unit:  '/100',
      note:  anomalies.length > 0 ? `${anomalies.length} issue(s) found` : 'No issues found',
    },
    anomalies: anomalies.sort((a, b) => b.score - a.score),
    metrics,
    warnings,
    computedAt: new Date().toISOString(),
  };
}
