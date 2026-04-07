/**
 * Module 2 — Reliability Analysis
 *
 * Computes MTBF, MTTR, and availability — but critically, this module
 * also assesses the CONDITIONS required for these metrics to be valid.
 *
 * The report does not just output numbers. It explains WHY each metric
 * may or may not be trustworthy based on data quality findings.
 *
 * All aggregations use v_analysis_scope (one row per WO, deduplicated).
 */

import { query } from '../services/DuckDBService';
import type { ColumnMap } from '../types';
import type { ModuleResult, Anomaly } from './analysisTypes';

interface EquipmentMetric {
  equipment:    string;
  failureCount: number;
  mtbfDays:     number | null;
  mttrHours:    number | null;
  availability: number | null;
}

export async function runReliabilityModule(columnMap: ColumnMap): Promise<ModuleResult> {
  const anomalies: Anomaly[] = [];
  const warnings:  string[] = [];
  const metrics:   Record<string, unknown> = {};

  const has = (col: keyof ColumnMap) => !!columnMap[col];

  // ── Pre-flight: assess data readiness ────────────────────────────────────
  const hasStart  = has('actual_start_date');
  const hasFinish = has('actual_finish_date');
  const hasEq     = has('equipment');

  const reliabilityReasons: string[] = [];

  if (!hasStart) reliabilityReasons.push('No actual_start_date column — MTBF cannot be computed.');
  if (!hasFinish) reliabilityReasons.push('No actual_finish_date column — MTTR and availability cannot be computed.');
  if (!hasEq)     reliabilityReasons.push('No equipment column — per-equipment analysis is unavailable.');

  // Check null rates on date columns
  let startNullPct  = 100;
  let finishNullPct = 100;

  if (hasStart) {
    const [r] = await query('SELECT COUNT(*) AS t, COUNT(actual_start_date) AS nn FROM v_analysis_scope');
    const t  = Number(r?.t  ?? 0);
    const nn = Number(r?.nn ?? 0);
    startNullPct = t > 0 ? Math.round(((t - nn) / t) * 100) : 100;
    if (startNullPct > 20) reliabilityReasons.push(`${startNullPct}% of WOs have no actual_start_date — MTBF covers only ${100 - startNullPct}% of events.`);
  }

  if (hasFinish) {
    const [r] = await query('SELECT COUNT(*) AS t, COUNT(actual_finish_date) AS nn FROM v_analysis_scope');
    const t  = Number(r?.t  ?? 0);
    const nn = Number(r?.nn ?? 0);
    finishNullPct = t > 0 ? Math.round(((t - nn) / t) * 100) : 100;
    if (finishNullPct > 20) reliabilityReasons.push(`${finishNullPct}% of WOs have no actual_finish_date — MTTR is understated.`);
  }

  // Check reversed timestamps
  let reversedCount = 0;
  if (hasStart && hasFinish) {
    const [r] = await query(`
      SELECT COUNT(*) AS cnt FROM v_analysis_scope
      WHERE actual_start_date IS NOT NULL
        AND actual_finish_date IS NOT NULL
        AND actual_finish_date < actual_start_date
    `);
    reversedCount = Number(r?.cnt ?? 0);
    if (reversedCount > 0) reliabilityReasons.push(`${reversedCount} WOs have reversed timestamps and are excluded from duration calculations.`);
  }

  metrics.dataReadinessReasons = reliabilityReasons;
  warnings.push(...reliabilityReasons);

  // ── Total WOs ────────────────────────────────────────────────────────────
  const [totRow] = await query('SELECT COUNT(*) AS cnt FROM v_analysis_scope');
  const totalWOs = Number(totRow?.cnt ?? 0);
  metrics.totalWOs = totalWOs;

  if (totalWOs === 0) {
    return _insufficient(metrics, warnings);
  }

  // ── Fleet-level MTBF ──────────────────────────────────────────────────────
  let fleetMTBF: number | null = null;
  if (hasStart && startNullPct < 80) {
    const [mbRow] = await query(`
      SELECT
        COUNT(*) AS failures,
        DATEDIFF('day', MIN(actual_start_date), MAX(actual_start_date)) AS period_days
      FROM v_analysis_scope
      WHERE actual_start_date IS NOT NULL
    `);
    const failures   = Number(mbRow?.failures    ?? 0);
    const periodDays = Number(mbRow?.period_days ?? 0);
    if (failures > 1 && periodDays > 0) {
      fleetMTBF = Math.round((periodDays / failures) * 10) / 10;
    }
  }
  metrics.fleetMTBFDays = fleetMTBF;

  // ── Fleet-level MTTR ─────────────────────────────────────────────────────
  let fleetMTTR: number | null = null;
  if (hasStart && hasFinish) {
    const [mrRow] = await query(`
      SELECT AVG(DATEDIFF('minute', actual_start_date, actual_finish_date) / 60.0) AS avg_hours
      FROM v_analysis_scope
      WHERE actual_start_date IS NOT NULL
        AND actual_finish_date IS NOT NULL
        AND actual_finish_date >= actual_start_date
    `);
    const avgH = Number(mrRow?.avg_hours ?? null);
    if (!isNaN(avgH) && avgH > 0) {
      fleetMTTR = Math.round(avgH * 10) / 10;
    }
  }
  metrics.fleetMTTRHours = fleetMTTR;

  // ── Fleet availability ────────────────────────────────────────────────────
  let fleetAvailability: number | null = null;
  if (fleetMTBF !== null && fleetMTTR !== null) {
    const mttrDays = fleetMTTR / 24;
    fleetAvailability = Math.round((fleetMTBF / (fleetMTBF + mttrDays)) * 10000) / 100;
  }
  metrics.fleetAvailabilityPct = fleetAvailability;

  // ── Per-equipment metrics ─────────────────────────────────────────────────
  let equipmentMetrics: EquipmentMetric[] = [];

  if (hasEq && hasStart) {
    const eqRows = await query(`
      SELECT
        equipment,
        COUNT(*) AS failure_count,
        ${hasStart ? `DATEDIFF('day', MIN(actual_start_date), MAX(actual_start_date)) AS period_days,` : 'NULL AS period_days,'}
        ${(hasStart && hasFinish) ? `
          AVG(CASE
            WHEN actual_finish_date >= actual_start_date
            THEN DATEDIFF('minute', actual_start_date, actual_finish_date) / 60.0
            ELSE NULL
          END) AS avg_repair_hours
        ` : 'NULL AS avg_repair_hours'}
      FROM v_analysis_scope
      WHERE equipment IS NOT NULL AND TRIM(equipment) <> ''
        AND actual_start_date IS NOT NULL
      GROUP BY equipment
      ORDER BY failure_count DESC
      LIMIT 20
    `);

    equipmentMetrics = eqRows.map(r => {
      const fc   = Number(r.failure_count ?? 0);
      const pd   = Number(r.period_days   ?? 0);
      const arh  = r.avg_repair_hours != null ? Number(r.avg_repair_hours) : null;
      const mtbf = fc > 1 && pd > 0 ? Math.round((pd / fc) * 10) / 10 : null;
      const mttr = arh != null && !isNaN(arh) && arh > 0 ? Math.round(arh * 10) / 10 : null;
      const avail = (mtbf !== null && mttr !== null && mtbf > 0)
        ? Math.round((mtbf / (mtbf + mttr / 24)) * 10000) / 100
        : null;
      return {
        equipment:    String(r.equipment ?? ''),
        failureCount: fc,
        mtbfDays:     mtbf,
        mttrHours:    mttr,
        availability: avail,
      };
    });
  }
  metrics.equipmentMetrics = equipmentMetrics;

  // ── Pareto data ───────────────────────────────────────────────────────────
  if (hasEq && equipmentMetrics.length > 0) {
    const total = equipmentMetrics.reduce((s, e) => s + e.failureCount, 0);
    let cumulative = 0;
    const pareto = equipmentMetrics.map(e => {
      cumulative += e.failureCount;
      return {
        equipment:  e.equipment,
        count:      e.failureCount,
        cumPct:     Math.round((cumulative / total) * 100),
      };
    });
    metrics.paretoData = pareto;

    // Vital few — equipment covering 80% of failures
    const vitalFew = pareto.filter(p => p.cumPct <= 80);
    metrics.vitalFewCount = vitalFew.length;
    metrics.vitalFewPct   = Math.round((vitalFew.length / pareto.length) * 100);

    if (vitalFew.length > 0 && vitalFew.length <= Math.ceil(pareto.length * 0.25)) {
      anomalies.push({
        id:            'pareto-concentration',
        moduleId:      'reliability',
        severity:      'HIGH',
        type:          'FAILURE_CONCENTRATION',
        label:         `${vitalFew.length} equipment = 80% of failures`,
        description:   `${vitalFew.length} out of ${pareto.length} equipment assets account for 80% of all work orders. These are your critical assets requiring priority attention.`,
        sqlBasis:      'Pareto analysis: cumulative failure % by equipment',
        affectedCount: vitalFew.length,
        totalCount:    pareto.length,
        score:         70,
        samples:       vitalFew.slice(0, 5).map(p => ({
          equipment: p.equipment,
          value:     `${p.count} WOs`,
          flag:      `${p.cumPct}% cumulative`,
        })),
      });
    }
  }

  // ── High MTTR equipment (outliers) ────────────────────────────────────────
  if (equipmentMetrics.length > 2) {
    const validMttr = equipmentMetrics.filter(e => e.mttrHours !== null) as (EquipmentMetric & { mttrHours: number })[];
    if (validMttr.length > 2) {
      const avg = validMttr.reduce((s, e) => s + e.mttrHours, 0) / validMttr.length;
      const outliers = validMttr.filter(e => e.mttrHours > avg * 2);
      if (outliers.length > 0) {
        anomalies.push({
          id:            'high-mttr-outliers',
          moduleId:      'reliability',
          severity:      'MEDIUM',
          type:          'HIGH_MTTR_OUTLIERS',
          label:         `${outliers.length} equipment with abnormally high repair time`,
          description:   `${outliers.length} equipment assets have average repair time more than 2× the fleet average (${Math.round(avg)} hrs). This may indicate skill gaps, parts availability issues, or complex failure modes.`,
          sqlBasis:      'AVG(repair_hours) per equipment vs fleet mean',
          affectedCount: outliers.length,
          totalCount:    validMttr.length,
          score:         50,
          samples:       outliers.slice(0, 5).map(e => ({
            equipment: e.equipment,
            value:     `${e.mttrHours} hrs avg repair`,
            flag:      `fleet avg: ${Math.round(avg)} hrs`,
          })),
        });
      }
    }
  }

  // ── Module score ──────────────────────────────────────────────────────────
  // Score reflects data readiness, not the reliability performance
  let score = 80;
  score -= reliabilityReasons.length * 10;
  score -= reversedCount > 0 ? 10 : 0;
  score  = Math.max(0, Math.min(100, score));

  const status = score >= 75 ? 'pass' : score >= 50 ? 'warning' : 'critical';

  const keyValue = fleetMTBF !== null
    ? `${fleetMTBF} days`
    : reliabilityReasons.length > 0 ? 'Limited' : 'N/A';

  return {
    moduleId:   'reliability',
    moduleName: 'Reliability Analysis',
    status,
    score,
    keyMetric: {
      label: 'Fleet MTBF',
      value: keyValue,
      note:  reliabilityReasons.length > 0
        ? `⚠ ${reliabilityReasons.length} data condition(s) limit this metric`
        : undefined,
    },
    anomalies: anomalies.sort((a, b) => b.score - a.score),
    metrics,
    warnings,
    computedAt: new Date().toISOString(),
  };
}

function _insufficient(metrics: Record<string, unknown>, warnings: string[]): ModuleResult {
  return {
    moduleId:   'reliability',
    moduleName: 'Reliability Analysis',
    status:     'insufficient',
    score:      0,
    keyMetric:  { label: 'Fleet MTBF', value: 'N/A', note: 'Insufficient data' },
    anomalies:  [],
    metrics,
    warnings,
    computedAt: new Date().toISOString(),
  };
}
