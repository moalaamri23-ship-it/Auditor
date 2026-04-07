/**
 * Module 3 — Process Compliance
 *
 * Evaluates whether the maintenance process is being executed and documented
 * as required. Focuses on: schedule adherence, response lag, confirmation
 * completeness, and closure hygiene.
 *
 * All aggregations use v_analysis_scope (one row per WO).
 */

import { query } from '../services/DuckDBService';
import type { ColumnMap } from '../types';
import type { ModuleResult, Anomaly } from './analysisTypes';

export async function runProcessModule(columnMap: ColumnMap): Promise<ModuleResult> {
  const anomalies: Anomaly[] = [];
  const warnings:  string[] = [];
  const metrics:   Record<string, unknown> = {};

  const has = (col: keyof ColumnMap) => !!columnMap[col];

  const [totRow] = await query('SELECT COUNT(*) AS cnt FROM v_analysis_scope');
  const totalWOs = Number(totRow?.cnt ?? 0);
  metrics.totalWOs = totalWOs;

  if (totalWOs === 0) {
    return _insufficient(metrics, warnings);
  }

  // ── 1. Missing actual dates ───────────────────────────────────────────────
  if (has('actual_start_date')) {
    const [r] = await query(`
      SELECT COUNT(*) AS cnt FROM v_analysis_scope
      WHERE actual_start_date IS NULL
    `);
    const noStart = Number(r?.cnt ?? 0);
    const pct     = Math.round((noStart / totalWOs) * 100);
    metrics.wosWithNoActualStart = noStart;
    metrics.noActualStartPct     = pct;

    if (pct > 15) {
      anomalies.push({
        id:            'no-actual-start',
        moduleId:      'process',
        severity:      pct > 40 ? 'HIGH' : 'MEDIUM',
        type:          'MISSING_ACTUAL_START',
        label:         `${pct}% WOs missing actual start date`,
        description:   `${noStart} work order(s) (${pct}%) have no actual start date recorded. These cannot be included in response-time or scheduling analysis. This may indicate WOs were closed without proper confirmation entry.`,
        sqlBasis:      'SELECT ... WHERE actual_start_date IS NULL',
        affectedCount: noStart,
        totalCount:    totalWOs,
        score:         Math.min(80, pct),
        samples:       [],
      });
    }
  }

  if (has('actual_finish_date')) {
    const [r] = await query(`
      SELECT COUNT(*) AS cnt FROM v_analysis_scope
      WHERE actual_finish_date IS NULL
    `);
    const noFinish = Number(r?.cnt ?? 0);
    const pct      = Math.round((noFinish / totalWOs) * 100);
    metrics.wosWithNoActualFinish = noFinish;
    metrics.noActualFinishPct     = pct;

    if (pct > 15) {
      anomalies.push({
        id:            'no-actual-finish',
        moduleId:      'process',
        severity:      pct > 40 ? 'HIGH' : 'MEDIUM',
        type:          'MISSING_ACTUAL_FINISH',
        label:         `${pct}% WOs missing actual finish date`,
        description:   `${noFinish} work order(s) (${pct}%) have no actual finish date. This makes repair duration (MTTR) impossible to compute for these WOs, and suggests incomplete closure procedures.`,
        sqlBasis:      'SELECT ... WHERE actual_finish_date IS NULL',
        affectedCount: noFinish,
        totalCount:    totalWOs,
        score:         Math.min(80, pct),
        samples:       [],
      });
    }
  }

  // ── 2. Schedule adherence ─────────────────────────────────────────────────
  if (has('scheduled_start_date') && has('actual_start_date')) {
    const [schedRow] = await query(`
      SELECT
        COUNT(*) AS total_with_both,
        COUNT(*) FILTER (WHERE actual_start_date <= scheduled_start_date) AS on_time,
        COUNT(*) FILTER (WHERE actual_start_date >  scheduled_start_date) AS late,
        AVG(DATEDIFF('day', scheduled_start_date, actual_start_date))     AS avg_delay_days,
        MAX(DATEDIFF('day', scheduled_start_date, actual_start_date))     AS max_delay_days
      FROM v_analysis_scope
      WHERE scheduled_start_date IS NOT NULL
        AND actual_start_date    IS NOT NULL
    `);

    const total    = Number(schedRow?.total_with_both ?? 0);
    const onTime   = Number(schedRow?.on_time         ?? 0);
    const avgDelay = Number(schedRow?.avg_delay_days  ?? 0);
    const maxDelay = Number(schedRow?.max_delay_days  ?? 0);

    if (total > 0) {
      const adherenceRate = Math.round((onTime / total) * 100);
      metrics.scheduleAdherenceRate = adherenceRate;
      metrics.avgScheduleDelayDays  = Math.round(avgDelay * 10) / 10;
      metrics.maxScheduleDelayDays  = maxDelay;
      metrics.scheduleAnalysisWOs   = total;

      if (adherenceRate < 70) {
        anomalies.push({
          id:            'low-schedule-adherence',
          moduleId:      'process',
          severity:      adherenceRate < 50 ? 'HIGH' : 'MEDIUM',
          type:          'LOW_SCHEDULE_ADHERENCE',
          label:         `${adherenceRate}% schedule adherence`,
          description:   `Only ${adherenceRate}% of work orders with both a scheduled and actual start date were started on time. The average delay is ${Math.round(avgDelay)} day(s). Poor schedule adherence may indicate resource constraints, competing priorities, or unrealistic planning.`,
          sqlBasis:      'actual_start_date <= scheduled_start_date',
          affectedCount: total - onTime,
          totalCount:    total,
          score:         100 - adherenceRate,
          samples:       [],
        });
      }

      if (maxDelay > 30) {
        // Fetch worst offenders
        const lateRows = await query(`
          SELECT
            work_order_number,
            ${has('equipment') ? 'equipment,' : ''}
            DATEDIFF('day', scheduled_start_date, actual_start_date) AS delay_days
          FROM v_analysis_scope
          WHERE scheduled_start_date IS NOT NULL
            AND actual_start_date    IS NOT NULL
            AND actual_start_date > scheduled_start_date
          ORDER BY delay_days DESC
          LIMIT 5
        `);
        anomalies.push({
          id:            'extreme-schedule-delay',
          moduleId:      'process',
          severity:      'MEDIUM',
          type:          'EXTREME_SCHEDULE_DELAY',
          label:         `Max schedule delay: ${maxDelay} days`,
          description:   `The longest delay between scheduled and actual start is ${maxDelay} day(s). Extreme delays can indicate that the scheduling system is not being maintained or that WOs are being left unexecuted for extended periods.`,
          sqlBasis:      'MAX(DATEDIFF(day, scheduled_start_date, actual_start_date))',
          affectedCount: lateRows.length,
          totalCount:    total,
          score:         Math.min(60, Math.round(maxDelay / 5)),
          samples:       lateRows.map(r => ({
            wo:    String(r.work_order_number ?? ''),
            equipment: r.equipment ? String(r.equipment) : undefined,
            value: `${r.delay_days} days late`,
          })),
        });
      }
    }
  }

  // ── 3. Response lag (notification → actual start) ─────────────────────────
  if (has('notification_date') && has('actual_start_date')) {
    const [lagRow] = await query(`
      SELECT
        COUNT(*) AS cnt,
        AVG(DATEDIFF('hour', notification_date, actual_start_date))  AS avg_hours,
        MAX(DATEDIFF('hour', notification_date, actual_start_date))  AS max_hours,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY DATEDIFF('hour', notification_date, actual_start_date)
        ) AS median_hours
      FROM v_analysis_scope
      WHERE notification_date IS NOT NULL
        AND actual_start_date IS NOT NULL
        AND actual_start_date >= notification_date
    `);

    const cnt        = Number(lagRow?.cnt        ?? 0);
    const avgHours   = Number(lagRow?.avg_hours  ?? 0);
    const maxHours   = Number(lagRow?.max_hours  ?? 0);
    const medianHours= Number(lagRow?.median_hours ?? 0);

    if (cnt > 0) {
      metrics.avgResponseLagHours    = Math.round(avgHours   * 10) / 10;
      metrics.maxResponseLagHours    = Math.round(maxHours   * 10) / 10;
      metrics.medianResponseLagHours = Math.round(medianHours * 10) / 10;

      if (avgHours > 48) {
        anomalies.push({
          id:            'high-response-lag',
          moduleId:      'process',
          severity:      avgHours > 168 ? 'HIGH' : 'MEDIUM',
          type:          'HIGH_RESPONSE_LAG',
          label:         `Avg response lag: ${Math.round(avgHours)} hours`,
          description:   `The average time from notification to actual start is ${Math.round(avgHours)} hour(s). High response lag may indicate notification backlogs, insufficient maintenance crew availability, or poor work scheduling.`,
          sqlBasis:      'AVG(DATEDIFF(hour, notification_date, actual_start_date))',
          affectedCount: cnt,
          totalCount:    totalWOs,
          score:         Math.min(70, Math.round(avgHours / 10)),
          samples:       [],
        });
      }

      // Per-equipment response lag (top worst)
      if (has('equipment')) {
        const eqLagRows = await query(`
          SELECT
            equipment,
            COUNT(*) AS cnt,
            AVG(DATEDIFF('hour', notification_date, actual_start_date)) AS avg_hours
          FROM v_analysis_scope
          WHERE notification_date IS NOT NULL
            AND actual_start_date IS NOT NULL
            AND actual_start_date >= notification_date
            AND equipment IS NOT NULL
          GROUP BY equipment
          HAVING COUNT(*) >= 2
          ORDER BY avg_hours DESC
          LIMIT 10
        `);
        metrics.equipmentResponseLag = eqLagRows.map(r => ({
          equipment: String(r.equipment ?? ''),
          count:     Number(r.cnt ?? 0),
          avgHours:  Math.round(Number(r.avg_hours ?? 0) * 10) / 10,
        }));
      }
    }
  }

  // ── 4. Confirmation completeness ──────────────────────────────────────────
  if (has('confirmation_text')) {
    const [cRow] = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE confirmation_text IS NOT NULL AND TRIM(confirmation_text) <> '') AS with_conf
      FROM v_analysis_scope
    `);
    const total    = Number(cRow?.total     ?? 0);
    const withConf = Number(cRow?.with_conf ?? 0);
    const confPct  = total > 0 ? Math.round((withConf / total) * 100) : 0;
    metrics.confirmationCompleteness = confPct;

    if (confPct < 70) {
      anomalies.push({
        id:            'low-confirmation-completeness',
        moduleId:      'process',
        severity:      confPct < 40 ? 'HIGH' : 'MEDIUM',
        type:          'LOW_CONFIRMATION_COMPLETENESS',
        label:         `${confPct}% WOs have confirmation text`,
        description:   `Only ${confPct}% of work orders have confirmation text recorded. Without confirmation text, it is impossible to know what was actually done — affecting both audit quality and AI analysis depth. This is a process compliance failure.`,
        sqlBasis:      'COUNT(*) FILTER (WHERE confirmation_text IS NOT NULL AND TRIM(confirmation_text) <> \'\')',
        affectedCount: total - withConf,
        totalCount:    total,
        score:         100 - confPct,
        samples:       [],
      });
    }
  }

  // ── 5. Avg confirmation word count (text quality proxy) ──────────────────
  if (has('confirmation_text')) {
    const [wRow] = await query(`
      SELECT
        AVG(LENGTH(TRIM(confirmation_text)) - LENGTH(REPLACE(TRIM(confirmation_text), ' ', '')) + 1) AS avg_words
      FROM v_analysis_scope
      WHERE confirmation_text IS NOT NULL
        AND TRIM(confirmation_text) <> ''
    `);
    const avgWords = Number(wRow?.avg_words ?? 0);
    if (avgWords > 0) {
      metrics.avgConfirmationWords = Math.round(avgWords);
      if (avgWords < 5) {
        warnings.push(`Average confirmation length is only ${Math.round(avgWords)} word(s). Text is too sparse for meaningful AI analysis.`);
      }
    }
  }

  // ── Module score ──────────────────────────────────────────────────────────
  let score = 100;
  for (const a of anomalies) {
    if (a.severity === 'HIGH')   score -= 20;
    if (a.severity === 'MEDIUM') score -= 10;
  }
  score = Math.max(0, Math.min(100, score));
  const status = score >= 75 ? 'pass' : score >= 50 ? 'warning' : 'critical';

  // Key metric: schedule adherence or confirmation completeness
  const keyVal = metrics.scheduleAdherenceRate != null
    ? `${metrics.scheduleAdherenceRate}%`
    : metrics.confirmationCompleteness != null
    ? `${metrics.confirmationCompleteness}%`
    : 'N/A';

  const keyLabel = metrics.scheduleAdherenceRate != null
    ? 'Schedule Adherence'
    : 'Confirmation Coverage';

  return {
    moduleId:   'process',
    moduleName: 'Process Compliance',
    status,
    score,
    keyMetric:  { label: keyLabel, value: keyVal },
    anomalies:  anomalies.sort((a, b) => b.score - a.score),
    metrics,
    warnings,
    computedAt: new Date().toISOString(),
  };
}

function _insufficient(metrics: Record<string, unknown>, warnings: string[]): ModuleResult {
  return {
    moduleId:   'process',
    moduleName: 'Process Compliance',
    status:     'insufficient',
    score:      0,
    keyMetric:  { label: 'Schedule Adherence', value: 'N/A', note: 'Insufficient data' },
    anomalies:  [],
    metrics,
    warnings,
    computedAt: new Date().toISOString(),
  };
}
