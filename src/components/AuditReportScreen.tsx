import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Icon from './Icon';
import FilterPanel from './FilterPanel';
import { useActiveRun, useActiveProject, useStore, useRunsForProject } from '../store/useStore';
import { useRunAutoRestore } from '../hooks/useRunAutoRestore';
import {
  query,
  getFilterOptions,
  getLiveScopeCount,
  getCascadingFilterOptions,
  createAnalysisScopeView,
} from '../services/DuckDBService';
import { EMPTY_FILTERS } from '../types';
import type { AnalysisFilters, FilterOptions, ColumnMap, AIFlag, RuleCheckResult, RuleCheckId, EmailTemplate } from '../types';

const RULE_LABELS: Record<string, string> = {
  missing_confirmation: 'Missing Confirmation',
  not_listed_codes:     '"Not Listed" Codes',
  missing_scoping_text: 'Missing Scoping Text',
  missing_codes:        'Missing Codes',
};

const AI_LABELS: Record<string, string> = {
  desc_code_conflict:              'Desc — Code Conflict',
  false_not_listed:                'False Not Listed',
  desc_confirmation_mismatch:      'Desc — Confirmation Mismatch',
  desc_code_confirmation_misalign: 'Desc — Code — Conf. Misalignment',
  generic_description:             'Generic Description',
  generic_confirmation:            'Generic Confirmation',
};

interface WorkCenterAuditData {
  workCenter: string;
  description: string;
  totalWOs: number;
  ruleFlagsCount: number;
  aiFlagsCount: number;
  ruleDistribution: Record<string, number>;
  aiDistribution: Record<string, number>;
  woNumbers: string[];
}

type WODetail = { equipment: string; description: string; codes: string };

// ── Standalone WC loader (mirrors ReportingSettingsScreen logic) ─────────────
async function loadWorkCenters(
  columnMap: ColumnMap,
  filters: AnalysisFilters,
  aiFlags: AIFlag[],
  ruleChecks: RuleCheckResult | null,
  missingCodeWOs: string[],
): Promise<[WorkCenterAuditData[], Map<string, WODetail>]> {
  const hasWC = !!columnMap.work_center;
  if (!hasWC) return [[], new Map()];

  const descCol = columnMap.work_center_description ? 'work_center_description' : null;

  const conditions: string[] = [`TRIM(CAST(work_center AS VARCHAR)) <> ''`];

  if (filters.dateFrom && columnMap.notification_date)
    conditions.push(`notification_date >= '${filters.dateFrom}'::DATE`);
  if (filters.dateTo && columnMap.notification_date)
    conditions.push(`notification_date <= '${filters.dateTo}'::DATE`);
  if (filters.workCenter.length > 0)
    conditions.push(`work_center IN (${filters.workCenter.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')})`);
  if (filters.functionalLocation.length > 0 && columnMap.functional_location)
    conditions.push(`functional_location IN (${filters.functionalLocation.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')})`);
  if (filters.equipment.length > 0) {
    const eq = columnMap.equipment_description ? 'equipment_description' : columnMap.equipment ? 'equipment' : null;
    if (eq) conditions.push(`${eq} IN (${filters.equipment.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')})`);
  }

  const where  = `WHERE ${conditions.join(' AND ')}`;
  const descExpr = descCol ? `MAX(${descCol})` : `''`;

  // STRING_AGG used instead of ARRAY_AGG for safe JS string handling across DuckDB versions
  const sql = `
    SELECT
      work_center,
      ${descExpr} AS description,
      COUNT(work_order_number) AS total_wos,
      STRING_AGG(CAST(work_order_number AS VARCHAR), '|') AS wo_list
    FROM v_wo_primary
    ${where}
    GROUP BY work_center
    ORDER BY work_center
  `;

  const rows = await query(sql);

  const wcData: WorkCenterAuditData[] = rows.map(r => {
    const woNumbers = String(r.wo_list ?? '').split('|').filter(Boolean);
    const woSet = new Set(woNumbers);

    // Rule distribution: count flagged WOs per rule check ID
    const ruleDistribution: Record<string, number> = {};
    let ruleFlagsCount = 0;
    if (ruleChecks?.flaggedWOs) {
      for (const fw of ruleChecks.flaggedWOs) {
        if (!woSet.has(fw.wo)) continue;
        ruleFlagsCount++;
        for (const checkId of fw.checks) {
          ruleDistribution[checkId] = (ruleDistribution[checkId] ?? 0) + 1;
        }
      }
    }
    // Guarantee patch for missing_codes using chartCache (authoritative source)
    const cacheMissingCount = missingCodeWOs.filter(wo => woSet.has(wo)).length;
    if (cacheMissingCount > (ruleDistribution['missing_codes'] ?? 0)) {
      ruleDistribution['missing_codes'] = cacheMissingCount;
    }

    // AI distribution: unique flagged WOs per category
    const aiDistribution: Record<string, number> = {};
    const aiFlaggedWOs = new Set<string>();
    for (const flag of aiFlags) {
      if (!woSet.has(flag.woNumber)) continue;
      aiFlaggedWOs.add(flag.woNumber);
      aiDistribution[flag.category] = (aiDistribution[flag.category] ?? 0) + 1;
    }

    return {
      workCenter:       String(r.work_center ?? ''),
      description:      String(r.description ?? ''),
      totalWOs:         Number(r.total_wos ?? 0),
      ruleFlagsCount,
      aiFlagsCount:     aiFlaggedWOs.size,
      ruleDistribution,
      aiDistribution,
      woNumbers,
    };
  });

  // Build per-WO detail map for rule-only WOs that have no AI flag data
  const woDetailMap = new Map<string, WODetail>();
  try {
    const allWONums = wcData.flatMap(d => d.woNumbers);
    if (allWONums.length > 0) {
      const esc = (s: string) => s.replace(/'/g, "''");
      const inList = allWONums.map(w => `'${esc(w)}'`).join(',');
      const detailRows = await query(`
        SELECT DISTINCT
          CAST(work_order_number AS VARCHAR) AS wo_num,
          COALESCE(CAST(equipment_description AS VARCHAR), '') AS equipment,
          COALESCE(CAST(work_order_description AS VARCHAR), '') AS description,
          COALESCE(
            CONCAT_WS(' | ',
              NULLIF(TRIM(CAST(object_part_code_description AS VARCHAR)), ''),
              NULLIF(TRIM(CAST(damage_code_description AS VARCHAR)), ''),
              NULLIF(TRIM(CAST(cause_code_description AS VARCHAR)), '')
            ), ''
          ) AS codes
        FROM v_wo_primary
        WHERE work_order_number IN (${inList})
      `);
      for (const dr of detailRows) {
        const wo = String(dr.wo_num ?? '');
        if (wo) woDetailMap.set(wo, {
          equipment:   String(dr.equipment   ?? ''),
          description: String(dr.description ?? ''),
          codes:       String(dr.codes       ?? ''),
        });
      }
    }
  } catch { /* detail map stays empty — rule-only WOs will show — */ }

  return [wcData, woDetailMap];
}

// ─── Calculation engine ───────────────────────────────────────────────────────
//
// Safe arithmetic evaluator (no eval / Function constructor). Supports
// + - * / and parens with standard precedence. Operands are real numbers.
// Used by the `calculate(EXPR)` template syntax.

function evalArithmetic(expr: string): number {
  // Strip percentage signs / commas left over after placeholder substitution
  const src = expr.replace(/%|,/g, '');
  let i = 0;

  const peek = () => src[i];
  const consume = () => src[i++];
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };

  // expression := term (('+'|'-') term)*
  const parseExpr = (): number => {
    skipWs();
    let v = parseTerm();
    skipWs();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const rhs = parseTerm();
      v = op === '+' ? v + rhs : v - rhs;
      skipWs();
    }
    return v;
  };
  // term := factor (('*'|'/') factor)*
  const parseTerm = (): number => {
    skipWs();
    let v = parseFactor();
    skipWs();
    while (peek() === '*' || peek() === '/') {
      const op = consume();
      const rhs = parseFactor();
      if (op === '*') v *= rhs;
      else v = rhs === 0 ? NaN : v / rhs;
      skipWs();
    }
    return v;
  };
  // factor := number | '(' expr ')' | '-' factor | '+' factor
  const parseFactor = (): number => {
    skipWs();
    const c = peek();
    if (c === '(') {
      consume();
      const v = parseExpr();
      skipWs();
      if (peek() !== ')') throw new Error('expected )');
      consume();
      return v;
    }
    if (c === '-') { consume(); return -parseFactor(); }
    if (c === '+') { consume(); return parseFactor(); }
    return parseNumber();
  };
  const parseNumber = (): number => {
    skipWs();
    let s = '';
    while (i < src.length && /[0-9.]/.test(src[i])) s += consume();
    if (!s) throw new Error('expected number');
    const n = Number(s);
    if (!isFinite(n)) throw new Error('invalid number');
    return n;
  };

  const result = parseExpr();
  skipWs();
  if (i < src.length) throw new Error(`unexpected '${src.slice(i)}'`);
  return result;
}

/** Replace every `calculate(EXPR)` in `text` with the numeric result. */
function applyCalculations(text: string): string {
  // Match calculate(...) with up to one level of nested parens.
  const RE = /calculate\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  return text.replace(RE, (_, inner: string) => {
    try {
      const v = evalArithmetic(inner);
      if (!isFinite(v)) return 'NaN';
      return Number.isInteger(v) ? String(v) : v.toFixed(2);
    } catch {
      return `[calc-error: ${inner}]`;
    }
  });
}

// ─── Rich text + table HTML rendering ────────────────────────────────────────
//
// Templates are written in plain text with embedded markers:
//   [B]bold[/B] [I]italic[/I] [U]underline[/U] [S]strike[/S]
//   [TABLE rows=R cols=C autofit=1 header=1] | a | b | ... [/TABLE]
//
// `renderTemplateHTML` produces an HTML string suitable for direct inclusion
// inside the existing <pre>...</pre> envelope used by sendEmail / preview.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseTableAttrs(raw: string): { autofit: boolean; header: boolean } {
  const get = (k: string) => {
    const m = new RegExp(`${k}\\s*=\\s*([^\\s\\]]+)`).exec(raw);
    return m ? m[1] : null;
  };
  const truthy = (v: string | null) => v !== null && v !== '0' && v.toLowerCase() !== 'false' && v !== '';
  return { autofit: truthy(get('autofit')), header: truthy(get('header')) };
}

const PRE_OPEN  = `<pre style="font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.7;color:#1e293b;white-space:pre-wrap;background:none;border:none;padding:0;margin:0">`;
const PRE_CLOSE = `</pre>`;

export function renderTemplateHTML(text: string): string {
  // 1. Escape user content first so injected markers can't break out
  let s = escapeHtml(text);

  // 2. Convert table blocks → <table> outside the surrounding <pre>
  //    (tables can't live inside <pre> meaningfully; close pre, render
  //    table, reopen pre.) The escaping above turned `[` into `&#x5b;`?
  //    No — `[` and `]` are not in the escape set, so they survive intact.
  s = s.replace(/\[TABLE([^\]]*)\]([\s\S]*?)\[\/TABLE\]/g, (_, attrsRaw: string, body: string) => {
    const attrs = parseTableAttrs(attrsRaw);
    const lines = body.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const rows = lines.map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    const tableStyle = attrs.autofit
      ? 'table-layout:auto;width:auto;border-collapse:collapse;margin:8px 0'
      : 'table-layout:fixed;width:100%;border-collapse:collapse;margin:8px 0';
    const cellBase   = 'border:1px solid #cbd5e1;padding:6px 10px;font-family:Inter,sans-serif;font-size:13px;vertical-align:top';
    const headerExtra = ';background:#f1f5f9;font-weight:bold;color:#0f172a';
    const html = rows.map((cells, rowIdx) => {
      const tag = (attrs.header && rowIdx === 0) ? 'th' : 'td';
      const style = cellBase + (tag === 'th' ? headerExtra : '');
      const tr = cells.map((c) => `<${tag} style="${style}">${c}</${tag}>`).join('');
      return `<tr>${tr}</tr>`;
    }).join('');
    return `${PRE_CLOSE}<table style="${tableStyle}">${html}</table>${PRE_OPEN}`;
  });

  // 3. Convert inline markers
  s = s
    .replace(/\[B\]([\s\S]*?)\[\/B\]/g, '<b>$1</b>')
    .replace(/\[I\]([\s\S]*?)\[\/I\]/g, '<i>$1</i>')
    .replace(/\[U\]([\s\S]*?)\[\/U\]/g, '<u style="text-decoration:underline">$1</u>')
    .replace(/\[S\]([\s\S]*?)\[\/S\]/g, '<s style="text-decoration:line-through">$1</s>');

  return s;
}

// ─── Email template system ────────────────────────────────────────────────────

export const DEFAULT_EMAIL_TEMPLATE = [
  '{Sep}',
  '  RELIABILITY AUDIT REPORT — {ProjectName}',
  '  Work Center: {WorkCenterLabel}',
  '  Period: {PeriodLabel}  |  Generated: {GeneratedDate}',
  '{Sep}',
  '',
  'Audit Scope: {AuditScope}',
  '',
  '',
  'SUMMARY',
  '{Dash}',
  'This is an automated Reliability Audit summary for Work',
  'Center {WorkCenter}. A full interactive dashboard is',
  'attached to this email — open it in any web browser to',
  'view charts, per-category breakdowns, and the complete',
  'list of flagged work orders with AI comments.',
  '',
  '',
  'FINDINGS',
  '{Dash}',
  '  Total Work Orders Analyzed    {TotalWOs}',
  '  Work Orders — Rule Flags      {TotalRuleFlaggedWOs}',
  '  Work Orders — AI Flags        {TotalAIFlaggedWOs}',
  '',
  '',
  '{ErrorDistSection}',
  '',
  '',
  'ACTION REQUIRED',
  '{Dash}',
  'Please review the flagged work orders for Work Center',
  '{WorkCenter} using the attached dashboard and apply',
  'the necessary corrections in SAP, prioritising:',
  '',
  '  1. HIGH-severity AI flags (misleading or conflicting data)',
  '  2. Missing Confirmation (no closure text recorded)',
  '  3. "Not Listed" Codes (incomplete failure coding)',
  '',
  '',
  '{Sep}',
  '  SAP Reliability Auditor  ·  {GeneratedDate}',
  '  This message was generated automatically. Do not reply.',
  '{Sep}',
].join('\n');

interface FieldRef { group: string; key: string; label: string; description: string; example: string; }

const TEMPLATE_FIELD_REFERENCE: FieldRef[] = [
  // ── Context ──────────────────────────────────────────────────────────────────
  { group: 'Context', key: '{ProjectName}',          label: 'Project Name',              description: 'Audit project name as configured',                        example: 'Q1 2026 Reliability Audit' },
  { group: 'Context', key: '{WorkCenter}',            label: 'Work Center ID',            description: 'SAP work center code',                                    example: 'A100' },
  { group: 'Context', key: '{WorkCenterLabel}',       label: 'Work Center (with desc)',   description: 'Work center ID and description combined',                  example: 'A100 (Mechanical)' },
  { group: 'Context', key: '{WorkCenterDescription}', label: 'Work Center Description',   description: 'Description text of the work center',                     example: 'Mechanical Maintenance' },
  { group: 'Context', key: '{PeriodLabel}',           label: 'Period Label',              description: 'Audit run period label',                                   example: '2026-BW1' },
  { group: 'Context', key: '{GeneratedDate}',         label: 'Generated Date',            description: 'Date the email was sent',                                  example: '29 Apr 2026' },
  { group: 'Context', key: '{AuditScope}',            label: 'Audit Scope (date range)',  description: 'Date range covered by this audit run',                     example: '1 Jan 2026 to 14 Jan 2026' },
  // ── Summary KPIs ─────────────────────────────────────────────────────────────
  { group: 'Summary KPIs', key: '{TotalWOs}',             label: 'Total WOs Analyzed',    description: 'Total work orders in scope for this work center',          example: '245' },
  { group: 'Summary KPIs', key: '{TotalRuleFlaggedWOs}',  label: 'Rule-Flagged WOs',      description: 'WOs with at least one rule-based flag',                   example: '12' },
  { group: 'Summary KPIs', key: '{TotalAIFlaggedWOs}',    label: 'AI-Flagged WOs',        description: 'WOs with at least one AI semantic flag',                  example: '8' },
  { group: 'Summary KPIs', key: '{CleanWOs}',             label: 'Clean WOs',             description: 'WOs with no flags of any kind (AI or rule)',               example: '225' },
  { group: 'Summary KPIs', key: '{RuleFlagPct}',          label: 'Rule-Flagged %',        description: 'Rule-flagged WOs as percentage of total',                 example: '4.9%' },
  { group: 'Summary KPIs', key: '{AIFlagPct}',            label: 'AI-Flagged %',          description: 'AI-flagged WOs as percentage of total',                   example: '3.3%' },
  { group: 'Summary KPIs', key: '{CleanPct}',             label: 'Clean %',               description: 'Clean WOs as percentage of total',                        example: '91.8%' },
  { group: 'Summary KPIs', key: '{TotalFlags}',           label: 'Total Flag Instances',  description: 'Sum of all individual flag hits (AI instances + rule hits)', example: '27' },
  // ── Rule Checks ──────────────────────────────────────────────────────────────
  { group: 'Rule Checks', key: '{RuleMissingConfirmation}', label: 'Missing Confirmation',  description: 'WOs with no confirmation text recorded (neither short nor long)',   example: '5' },
  { group: 'Rule Checks', key: '{RuleNotListedCodes}',      label: '"Not Listed" Codes',    description: 'WOs with at least one "Not Listed" code field',                   example: '3' },
  { group: 'Rule Checks', key: '{RuleMissingScopingText}',  label: 'Missing Scoping Text',  description: 'WOs with no Code Group — description written ad-hoc',             example: '4' },
  { group: 'Rule Checks', key: '{RuleMissingCodes}',        label: 'Missing Codes',         description: 'WOs where all three code description fields are blank',           example: '2' },
  // ── AI Categories ────────────────────────────────────────────────────────────
  { group: 'AI Categories', key: '{AIDescCodeConflict}',              label: 'Desc–Code Conflict',        description: 'Description identifies failure clearly but codes disagree',              example: '4' },
  { group: 'AI Categories', key: '{AIFalseNotListed}',                label: 'False "Not Listed"',        description: 'Codes are "Not Listed" but catalog implies a specific entry exists',    example: '2' },
  { group: 'AI Categories', key: '{AIDescConfirmationMismatch}',      label: 'Desc–Conf Mismatch',        description: 'Description and confirmation text describe different issues',             example: '3' },
  { group: 'AI Categories', key: '{AIDescCodeConfirmationMisalign}',  label: 'Three-Way Misalignment',    description: 'Description, codes, and confirmation all contradict each other',         example: '1' },
  { group: 'AI Categories', key: '{AIGenericDescription}',            label: 'Generic Description',       description: 'Description is present but too vague to identify the work request',    example: '5' },
  { group: 'AI Categories', key: '{AIGenericConfirmation}',           label: 'Generic Confirmation',      description: 'Confirmation is present but provides no useful closure information',   example: '3' },
  // ── Code Quality ─────────────────────────────────────────────────────────────
  { group: 'Code Quality', key: '{CQValid}',              label: 'Valid Coded WOs',         description: 'WOs with all three codes present and not set to "Not Listed"',    example: '220' },
  { group: 'Code Quality', key: '{CQNotListed}',          label: '"Not Listed" WOs',        description: 'WOs with at least one "Not Listed" code field',                  example: '10' },
  { group: 'Code Quality', key: '{CQInvalidHierarchy}',   label: 'Invalid Hierarchy WOs',   description: 'WOs with a code–description conflict flagged by AI',             example: '5' },
  { group: 'Code Quality', key: '{CQMissingCodes}',       label: 'Missing Codes WOs',       description: 'WOs where all three code description fields are blank',          example: '10' },
  { group: 'Code Quality', key: '{CQValidPct}',           label: 'Valid Coded %',           description: 'Valid coded WOs as percentage of total',                         example: '89.8%' },
  { group: 'Code Quality', key: '{CQNotListedPct}',       label: '"Not Listed" %',          description: '"Not Listed" WOs as percentage of total',                        example: '4.1%' },
  { group: 'Code Quality', key: '{CQInvalidHierarchyPct}',label: 'Invalid Hierarchy %',     description: 'Invalid hierarchy WOs as percentage of total',                   example: '2.0%' },
  { group: 'Code Quality', key: '{CQMissingCodesPct}',    label: 'Missing Codes %',         description: 'Missing codes WOs as percentage of total',                       example: '4.1%' },
  // ── Overall Quality ──────────────────────────────────────────────────────────
  { group: 'Overall Quality', key: '{OQClean}',            label: 'Clean WOs',           description: 'WOs with zero flags of any kind (same as Clean WOs KPI)',           example: '225' },
  { group: 'Overall Quality', key: '{OQEntryQuality}',     label: 'Entry Quality WOs',   description: 'WOs with at least one AI flag — text or semantic quality issue',    example: '8' },
  { group: 'Overall Quality', key: '{OQMissingFields}',    label: 'Missing Fields WOs',  description: 'WOs with rule flags only and no AI flags',                          example: '12' },
  { group: 'Overall Quality', key: '{OQCleanPct}',         label: 'Clean %',             description: 'Clean WOs as percentage of total',                                  example: '91.8%' },
  { group: 'Overall Quality', key: '{OQEntryQualityPct}',  label: 'Entry Quality %',     description: 'Entry quality WOs as percentage of total',                          example: '3.3%' },
  { group: 'Overall Quality', key: '{OQMissingFieldsPct}', label: 'Missing Fields %',    description: 'Missing fields WOs as percentage of total',                         example: '4.9%' },
  // ── Top Equipment ────────────────────────────────────────────────────────────
  { group: 'Top Equipment', key: '{TopEq1}',      label: 'Top equipment #1 name',  description: 'Most-flagged equipment in this work center',           example: 'PUMP-101' },
  { group: 'Top Equipment', key: '{TopEq1Count}', label: 'Top equipment #1 count', description: 'Distinct flagged WO count for the #1 equipment',       example: '12' },
  { group: 'Top Equipment', key: '{TopEq2}',      label: 'Top equipment #2 name',  description: '2nd most-flagged equipment',                           example: 'MOTOR-22' },
  { group: 'Top Equipment', key: '{TopEq2Count}', label: 'Top equipment #2 count', description: 'Distinct flagged WO count for the #2 equipment',       example: '9' },
  { group: 'Top Equipment', key: '{TopEq3}',      label: 'Top equipment #3 name',  description: '3rd most-flagged equipment',                           example: 'VALVE-7' },
  { group: 'Top Equipment', key: '{TopEq3Count}', label: 'Top equipment #3 count', description: 'Distinct flagged WO count for the #3 equipment',       example: '6' },
  { group: 'Top Equipment', key: '{TopEq4}',      label: 'Top equipment #4 name',  description: '4th most-flagged equipment',                           example: 'GEAR-A' },
  { group: 'Top Equipment', key: '{TopEq4Count}', label: 'Top equipment #4 count', description: 'Distinct flagged WO count for the #4 equipment',       example: '4' },
  { group: 'Top Equipment', key: '{TopEq5}',      label: 'Top equipment #5 name',  description: '5th most-flagged equipment',                           example: 'BRG-12' },
  { group: 'Top Equipment', key: '{TopEq5Count}', label: 'Top equipment #5 count', description: 'Distinct flagged WO count for the #5 equipment',       example: '3' },
  // ── Severity ─────────────────────────────────────────────────────────────────
  { group: 'Severity', key: '{HighSeverityAICount}',   label: 'High-severity AI flags',   description: 'Count of AI flag instances marked HIGH',          example: '6' },
  { group: 'Severity', key: '{MediumSeverityAICount}', label: 'Medium-severity AI flags', description: 'Count of AI flag instances marked MEDIUM',        example: '4' },
  { group: 'Severity', key: '{LowSeverityAICount}',    label: 'Low-severity AI flags',    description: 'Count of AI flag instances marked LOW',           example: '2' },
  // ── Comparison ───────────────────────────────────────────────────────────────
  { group: 'Comparison', key: '{PrevPeriodLabel}',      label: 'Previous run period',      description: 'Period label of the prior analysed run in this project', example: '2026-Q1' },
  { group: 'Comparison', key: '{PrevTotalWOs}',         label: 'Previous total WOs',       description: 'Total WOs analysed in the prior run',                  example: '232' },
  { group: 'Comparison', key: '{PrevRuleFlaggedWOs}',   label: 'Previous rule-flagged WOs',description: 'Rule-flagged WO count in the prior run',                example: '15' },
  { group: 'Comparison', key: '{PrevAIFlaggedWOs}',     label: 'Previous AI-flagged WOs',  description: 'AI-flagged WO count in the prior run',                  example: '11' },
  { group: 'Comparison', key: '{DeltaTotalWOs}',        label: 'Δ Total WOs',              description: 'Current minus previous total WOs (signed)',             example: '+13' },
  { group: 'Comparison', key: '{DeltaRuleFlaggedWOs}',  label: 'Δ Rule-flagged WOs',       description: 'Current minus previous rule-flagged WOs',               example: '-3' },
  { group: 'Comparison', key: '{DeltaAIFlaggedWOs}',    label: 'Δ AI-flagged WOs',         description: 'Current minus previous AI-flagged WOs',                 example: '-2' },
  { group: 'Comparison', key: '{TopIssueLabel}',        label: 'Top issue category',       description: 'The single error-distribution category with the highest count', example: 'Missing Confirmation' },
  { group: 'Comparison', key: '{TopIssueCount}',        label: 'Top issue count',          description: 'Count for the dominant error category',                 example: '8' },
  // ── Catalog ──────────────────────────────────────────────────────────────────
  { group: 'Catalog', key: '{CatalogMatchPct}', label: 'Catalog match %', description: 'Fraction of WOs whose failure_catalog_desc exists in the catalog (as %)', example: '92.4%' },
  { group: 'Catalog', key: '{Now}',             label: 'Current ISO date', description: 'Full ISO timestamp of when the email was generated',                       example: '2026-04-29T14:30:00Z' },
  // ── Calculation ──────────────────────────────────────────────────────────────
  { group: 'Calculation', key: 'calculate(EXPR)', label: 'Inline arithmetic',          description: 'Evaluate an arithmetic expression using placeholders. Supports + - * / and parens.', example: 'calculate(({TotalWOs}-{CleanWOs})/{TotalWOs}*100) → 4.97' },
  // ── Formatting ───────────────────────────────────────────────────────────────
  { group: 'Formatting', key: '{ErrorDistSection}', label: 'Error Distribution Block', description: 'Auto-generated full breakdown of all flagged categories (rule + AI)', example: '(auto-generated table)' },
  { group: 'Formatting', key: '{Sep}',              label: 'Separator line',           description: '═ repeated 58 times — use as a major section divider',               example: '══════…' },
  { group: 'Formatting', key: '{Dash}',             label: 'Section divider',          description: '- repeated 42 times — use as a sub-section divider',                 example: '──────…' },
  { group: 'Formatting', key: '[B]…[/B]',           label: 'Bold',                     description: 'Wrap text with these markers to render bold in the email',           example: '[B]Action[/B]' },
  { group: 'Formatting', key: '[I]…[/I]',           label: 'Italic',                   description: 'Wrap text with these markers to render italic in the email',         example: '[I]note[/I]' },
  { group: 'Formatting', key: '[U]…[/U]',           label: 'Underline',                description: 'Wrap text with these markers to render underline in the email',      example: '[U]key[/U]' },
  { group: 'Formatting', key: '[S]…[/S]',           label: 'Strikethrough',            description: 'Wrap text with these markers to render strikethrough in the email',  example: '[S]old[/S]' },
  { group: 'Formatting', key: '[TABLE …][/TABLE]',  label: 'Table block',              description: 'Pipe-delimited rows. Attributes: rows, cols, autofit, header. Use the toolbar Insert Table button.', example: '[TABLE rows=2 cols=2]…[/TABLE]' },
];

// ─────────────────────────────────────────────────────────────────────────────

export default function AuditReportScreen() {
  const run = useActiveRun();
  const project = useActiveProject();
  const projectRuns = useRunsForProject(run?.projectId ?? null);
  const {
    reportingEmails,
    aiConfig,
    setScreen,
    emailTemplate,                  // legacy fallback
    emailTemplates,
    activeEmailTemplateId,
    addEmailTemplate,
    updateEmailTemplate,
    deleteEmailTemplate,
    setActiveEmailTemplate,
  } = useStore();

  // Active template body — falls back to legacy emailTemplate, then DEFAULT
  const activeTemplate: EmailTemplate | null = useMemo(() => {
    if (!activeEmailTemplateId) return null;
    return emailTemplates.find((t) => t.id === activeEmailTemplateId) ?? null;
  }, [emailTemplates, activeEmailTemplateId]);

  const activeBody: string = activeTemplate?.body ?? emailTemplate ?? DEFAULT_EMAIL_TEMPLATE;

  useRunAutoRestore(run);

  const [filters, setFilters] = useState<AnalysisFilters>(EMPTY_FILTERS);
  const [baseFilterOptions, setBaseFilterOptions] = useState<FilterOptions | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);

  const [wcData, setWcData] = useState<WorkCenterAuditData[]>([]);
  const [woDetailMap, setWoDetailMap] = useState<Map<string, WODetail>>(new Map());
  const [loadingData, setLoadingData] = useState(false);

  const [selectedWCs, setSelectedWCs] = useState<Set<string>>(new Set());
  const [previewWC, setPreviewWC] = useState<WorkCenterAuditData | null>(null);
  const [sendingStatus, setSendingStatus] = useState<Record<string, 'sending' | 'success' | 'error'>>({});
  const [showTemplateModal, setShowTemplateModal] = useState(false);

  // ── Effect 1: load filter options on mount ──────────────────────────────────
  useEffect(() => {
    if (!run?.columnMap) return;
    getFilterOptions(run.columnMap).then((opts) => {
      setBaseFilterOptions(opts);
      setFilterOptions(opts);
    }).catch(console.error);
  }, [run?.id, run?.hasDataInDB, run?.columnMap]);

  // ── Effect 2: fetch WC list — no hasDataInDB guard (mirrors ReportingSettingsScreen) ──
  useEffect(() => {
    if (!run?.columnMap) return;

    const t = setTimeout(async () => {
      setLoadingData(true);
      try {
        const [data, detailMap] = await loadWorkCenters(
          run.columnMap,
          filters,
          run.aiFlags ?? [],
          run.ruleChecks ?? null,
          run.chartCache?.missingCodeWOs ?? [],
        );
        setWcData(data);
        setWoDetailMap(detailMap);
        setSelectedWCs(prev => {
          const next = new Set<string>();
          data.forEach(d => { if (prev.has(d.workCenter)) next.add(d.workCenter); });
          return next;
        });
      } catch (err) {
        console.error('WC load error:', err);
      } finally {
        setLoadingData(false);
      }
    }, 200);

    return () => clearTimeout(t);
  }, [filters, run?.id, run?.hasDataInDB, run?.columnMap, run?.aiFlags, run?.ruleChecks]);

  // ── Effect 3: cascade filter options when baseFilterOptions is ready ─────────
  useEffect(() => {
    if (!run?.columnMap || !baseFilterOptions) return;

    const t = setTimeout(async () => {
      try {
        const [, cascaded] = await Promise.all([
          getLiveScopeCount(filters, run.columnMap, project),
          getCascadingFilterOptions(filters, run.columnMap, project, baseFilterOptions),
        ]);
        setFilterOptions(cascaded);
        await createAnalysisScopeView(filters, run.columnMap, project);
      } catch (err) {
        console.error('Cascade error:', err);
      }
    }, 300);

    return () => clearTimeout(t);
  }, [filters, run?.id, run?.columnMap, baseFilterOptions, project]);

  const handleSelectAll = () => {
    if (selectedWCs.size === wcData.length && wcData.length > 0) {
      setSelectedWCs(new Set());
    } else {
      setSelectedWCs(new Set(wcData.map(w => w.workCenter)));
    }
  };

  const toggleSelect = (wc: string) => {
    const next = new Set(selectedWCs);
    if (next.has(wc)) next.delete(wc);
    else next.add(wc);
    setSelectedWCs(next);
  };

  const getEmailText = (wc: WorkCenterAuditData): string => {
    const dateFrom = filters.dateFrom || run?.dataProfile?.dateRange?.min || null;
    const dateTo   = filters.dateTo   || run?.dataProfile?.dateRange?.max || null;
    const scope = (dateFrom || dateTo)
      ? `${dateFrom || 'Start'} to ${dateTo || 'End'}`
      : (run?.periodLabel || 'All time');
    const projectName = project?.name || 'Reliability Audit';
    const periodLabel = run?.periodLabel || '';
    const now = new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
    const sep  = '='.repeat(58);
    const dash = '-'.repeat(42);
    const wcLabel = wc.description ? `${wc.workCenter} (${wc.description})` : wc.workCenter;

    const distLine = (label: string, count: number) =>
      `    ${label.padEnd(38)}${count} WO${count !== 1 ? 's' : ''}`;

    const ruleLines = Object.entries(wc.ruleDistribution)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([key, val]) => distLine(RULE_LABELS[key] ?? key, val));

    const aiLines = Object.entries(wc.aiDistribution)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([key, val]) => distLine(AI_LABELS[key] ?? key, val));

    const hasAnyFlags = wc.ruleFlagsCount > 0 || wc.aiFlagsCount > 0;
    const errorDistLines: string[] = ['ERROR DISTRIBUTION', dash];
    if (!hasAnyFlags) {
      errorDistLines.push('  No issues detected for this work center.');
    } else {
      if (ruleLines.length > 0) errorDistLines.push('  Rule-Based Issues:', ...ruleLines, '');
      if (aiLines.length > 0)  errorDistLines.push('  AI-Detected Issues:', ...aiLines);
    }
    const errorDistSection = errorDistLines.join('\n');

    // Per-WC derived metrics for the extended placeholder set
    const woSet2        = new Set(wc.woNumbers);
    const wcAIFlags2    = (run?.aiFlags ?? []).filter(f => woSet2.has(f.woNumber));
    const wcRuleWOs2    = (run?.ruleChecks?.flaggedWOs ?? []).filter(fw => woSet2.has(fw.wo));
    const aiFlaggedSet2  = new Set(wcAIFlags2.map(f => f.woNumber));
    const ruleFlaggedSet2 = new Set(wcRuleWOs2.map(fw => fw.wo));
    const allFlaggedSet2  = new Set([...aiFlaggedSet2, ...ruleFlaggedSet2]);
    const cleanWOs       = Math.max(0, wc.totalWOs - allFlaggedSet2.size);
    const pct = (n: number) => wc.totalWOs > 0 ? (n / wc.totalWOs * 100).toFixed(1) + '%' : '0.0%';
    const totalFlagInstances = wcRuleWOs2.reduce((s, fw) => s + fw.checks.length, 0) + wcAIFlags2.length;

    // Code Quality (per WC, same derivation as buildDashboardPayload)
    const cqNotListed = wc.ruleDistribution['not_listed_codes'] ?? 0;
    // Patch missing_codes count with chartCache as the authoritative source if present
    const cacheMissingForWC = (run?.chartCache?.missingCodeWOs ?? []).filter((wo) => woSet2.has(wo)).length;
    const cqMissing   = Math.max(wc.ruleDistribution['missing_codes'] ?? 0, cacheMissingForWC);
    const cqInvalidH  = new Set(wcAIFlags2.filter(f => f.category === 'desc_code_conflict').map(f => f.woNumber)).size;
    const cqValid     = Math.max(0, wc.totalWOs - cqNotListed - cqMissing - cqInvalidH);

    // Overall Quality (per WC)
    const oqEntry   = aiFlaggedSet2.size;
    const oqMissing = [...ruleFlaggedSet2].filter(wo => !aiFlaggedSet2.has(wo)).length;

    // Top Equipment (per WC) — count distinct flagged WOs per equipment via AI flag metadata
    //   Mirrors the buildDashboardPayload computation but stops at top 5.
    const equipMap = new Map<string, Set<string>>();
    for (const f of wcAIFlags2) {
      if (!f.equipment) continue;
      let s = equipMap.get(f.equipment);
      if (!s) { s = new Set(); equipMap.set(f.equipment, s); }
      s.add(f.woNumber);
    }
    const topEqList = [...equipMap.entries()]
      .map(([equipment, wos]) => ({ equipment, count: wos.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Severity counts — count of AI flag instances by severity (not WOs)
    let highSev = 0, medSev = 0, lowSev = 0;
    for (const f of wcAIFlags2) {
      if (f.severity === 'HIGH') highSev++;
      else if (f.severity === 'MEDIUM') medSev++;
      else if (f.severity === 'LOW') lowSev++;
    }

    // Comparison — derive deltas from prior analysed run in this project
    const analysed = projectRuns
      .filter((r) => r.stage === 'analysed' && r.ruleChecks)
      .sort((a, b) => a.runIndex - b.runIndex);
    const currIdx = analysed.findIndex((r) => r.id === run?.id);
    const prev = currIdx > 0 ? analysed[currIdx - 1] : null;
    const prevTotalWOs       = prev?.ruleChecks?.totalWOs ?? 0;
    const prevRuleFlaggedWOs = prev ? new Set((prev.ruleChecks?.flaggedWOs ?? []).map(fw => fw.wo)).size : 0;
    const prevAIFlaggedWOs   = prev ? new Set((prev.aiFlags ?? []).map(f => f.woNumber)).size : 0;
    const prevPeriodLabel    = prev?.periodLabel ?? '';
    const sign = (n: number) => (n >= 0 ? '+' : '') + String(n);

    // Top issue across the error distribution (rule + AI)
    type DistEntry = { label: string; value: number };
    const dist: DistEntry[] = [];
    for (const [k, v] of Object.entries(wc.ruleDistribution)) dist.push({ label: RULE_LABELS[k] ?? k, value: v });
    for (const [k, v] of Object.entries(wc.aiDistribution))   dist.push({ label: AI_LABELS[k]   ?? k, value: v });
    const topIssue = dist.sort((a, b) => b.value - a.value)[0];
    const topIssueLabel = topIssue?.value ? topIssue.label : 'None';
    const topIssueCount = topIssue?.value ?? 0;

    // Catalog match
    const catMatchPct = run?.dataProfile?.failureCatalogMatchRate != null
      ? (run.dataProfile.failureCatalogMatchRate * 100).toFixed(1) + '%'
      : 'N/A';

    const template = activeBody;
    return template
      .replace(/{Sep}/g,                         sep)
      .replace(/{Dash}/g,                        dash)
      .replace(/{ProjectName}/g,                 projectName)
      .replace(/{WorkCenterLabel}/g,             wcLabel)
      .replace(/{WorkCenterDescription}/g,       wc.description || wc.workCenter)
      .replace(/{PeriodLabel}/g,                 periodLabel || scope)
      .replace(/{GeneratedDate}/g,               now)
      .replace(/{AuditScope}/g,                  scope)
      .replace(/{WorkCenter}/g,                  wc.workCenter)
      // Summary KPIs
      .replace(/{TotalWOs}/g,                    String(wc.totalWOs))
      .replace(/{TotalRuleFlaggedWOs}/g,         String(wc.ruleFlagsCount))
      .replace(/{TotalAIFlaggedWOs}/g,           String(wc.aiFlagsCount))
      .replace(/{CleanWOs}/g,                    String(cleanWOs))
      .replace(/{RuleFlagPct}/g,                 pct(wc.ruleFlagsCount))
      .replace(/{AIFlagPct}/g,                   pct(wc.aiFlagsCount))
      .replace(/{CleanPct}/g,                    pct(cleanWOs))
      .replace(/{TotalFlags}/g,                  String(totalFlagInstances))
      // Rule Checks
      .replace(/{RuleMissingConfirmation}/g,     String(wc.ruleDistribution['missing_confirmation'] ?? 0))
      .replace(/{RuleNotListedCodes}/g,          String(wc.ruleDistribution['not_listed_codes']     ?? 0))
      .replace(/{RuleMissingScopingText}/g,      String(wc.ruleDistribution['missing_scoping_text'] ?? 0))
      // {RuleMissingCodes} falls back to chartCache so the email body matches the
      // Code Quality donut even if the persisted ruleChecks ever underreports.
      .replace(/{RuleMissingCodes}/g,            String(cqMissing))
      // AI Categories
      .replace(/{AIDescCodeConflict}/g,             String(wc.aiDistribution['desc_code_conflict']              ?? 0))
      .replace(/{AIFalseNotListed}/g,               String(wc.aiDistribution['false_not_listed']                ?? 0))
      .replace(/{AIDescConfirmationMismatch}/g,     String(wc.aiDistribution['desc_confirmation_mismatch']      ?? 0))
      .replace(/{AIDescCodeConfirmationMisalign}/g, String(wc.aiDistribution['desc_code_confirmation_misalign'] ?? 0))
      .replace(/{AIGenericDescription}/g,           String(wc.aiDistribution['generic_description']             ?? 0))
      .replace(/{AIGenericConfirmation}/g,          String(wc.aiDistribution['generic_confirmation']            ?? 0))
      // Code Quality
      .replace(/{CQValid}/g,              String(cqValid))
      .replace(/{CQNotListed}/g,          String(cqNotListed))
      .replace(/{CQInvalidHierarchy}/g,   String(cqInvalidH))
      .replace(/{CQMissingCodes}/g,       String(cqMissing))
      .replace(/{CQValidPct}/g,           pct(cqValid))
      .replace(/{CQNotListedPct}/g,       pct(cqNotListed))
      .replace(/{CQInvalidHierarchyPct}/g,pct(cqInvalidH))
      .replace(/{CQMissingCodesPct}/g,    pct(cqMissing))
      // Overall Quality
      .replace(/{OQClean}/g,             String(cleanWOs))
      .replace(/{OQEntryQuality}/g,      String(oqEntry))
      .replace(/{OQMissingFields}/g,     String(oqMissing))
      .replace(/{OQCleanPct}/g,          pct(cleanWOs))
      .replace(/{OQEntryQualityPct}/g,   pct(oqEntry))
      .replace(/{OQMissingFieldsPct}/g,  pct(oqMissing))
      // Top Equipment 1..5 (empty string when absent)
      .replace(/{TopEq1}/g,        topEqList[0]?.equipment ?? '')
      .replace(/{TopEq1Count}/g,   String(topEqList[0]?.count ?? 0))
      .replace(/{TopEq2}/g,        topEqList[1]?.equipment ?? '')
      .replace(/{TopEq2Count}/g,   String(topEqList[1]?.count ?? 0))
      .replace(/{TopEq3}/g,        topEqList[2]?.equipment ?? '')
      .replace(/{TopEq3Count}/g,   String(topEqList[2]?.count ?? 0))
      .replace(/{TopEq4}/g,        topEqList[3]?.equipment ?? '')
      .replace(/{TopEq4Count}/g,   String(topEqList[3]?.count ?? 0))
      .replace(/{TopEq5}/g,        topEqList[4]?.equipment ?? '')
      .replace(/{TopEq5Count}/g,   String(topEqList[4]?.count ?? 0))
      // Severity
      .replace(/{HighSeverityAICount}/g,   String(highSev))
      .replace(/{MediumSeverityAICount}/g, String(medSev))
      .replace(/{LowSeverityAICount}/g,    String(lowSev))
      // Comparison
      .replace(/{PrevPeriodLabel}/g,      prevPeriodLabel || 'N/A')
      .replace(/{PrevTotalWOs}/g,         String(prevTotalWOs))
      .replace(/{PrevRuleFlaggedWOs}/g,   String(prevRuleFlaggedWOs))
      .replace(/{PrevAIFlaggedWOs}/g,     String(prevAIFlaggedWOs))
      .replace(/{DeltaTotalWOs}/g,        sign(wc.totalWOs - prevTotalWOs))
      .replace(/{DeltaRuleFlaggedWOs}/g,  sign(wc.ruleFlagsCount - prevRuleFlaggedWOs))
      .replace(/{DeltaAIFlaggedWOs}/g,    sign(wc.aiFlagsCount - prevAIFlaggedWOs))
      .replace(/{TopIssueLabel}/g,        topIssueLabel)
      .replace(/{TopIssueCount}/g,        String(topIssueCount))
      // Catalog
      .replace(/{CatalogMatchPct}/g,      catMatchPct)
      .replace(/{Now}/g,                  new Date().toISOString())
      // Auto-generated section (last — may contain other braces)
      .replace(/{ErrorDistSection}/g,     errorDistSection)
      // Final pass: evaluate calculate(...) expressions
      .replace(/calculate\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_, inner: string) => {
        try {
          const v = evalArithmetic(inner);
          if (!isFinite(v)) return 'NaN';
          return Number.isInteger(v) ? String(v) : v.toFixed(2);
        } catch {
          return `[calc-error: ${inner}]`;
        }
      });
  };

  const buildDashboardPayload = (wc: WorkCenterAuditData) => {
    const woSet = new Set(wc.woNumbers);

    const wcAIFlags  = (run?.aiFlags ?? []).filter(f => woSet.has(f.woNumber));
    const wcRuleWOs: Array<{ wo: string; checks: RuleCheckId[] }> =
      (run?.ruleChecks?.flaggedWOs ?? [])
        .filter(fw => woSet.has(fw.wo))
        // Clone so we can safely augment with missing_codes from chartCache without mutating store state
        .map(fw => ({ wo: fw.wo, checks: [...fw.checks] }));

    // Guarantee patch: if chartCache has missingCodeWOs that aren't represented
    // in wcRuleWOs, inject 'missing_codes' for them. This keeps dashboard.html
    // Code Quality donut + Issues Rule Flags tab in agreement with the live donut.
    const cacheMissing = (run?.chartCache?.missingCodeWOs ?? []).filter(wo => woSet.has(wo));
    if (cacheMissing.length > 0) {
      const seen = new Map(wcRuleWOs.map(fw => [fw.wo, fw] as const));
      for (const wo of cacheMissing) {
        const existing = seen.get(wo);
        if (existing) {
          if (!existing.checks.includes('missing_codes')) {
            existing.checks.push('missing_codes');
          }
        } else {
          const fresh = { wo, checks: ['missing_codes' as const] };
          wcRuleWOs.push(fresh);
          seen.set(wo, fresh);
        }
      }
    }

    const aiFlaggedSet   = new Set(wcAIFlags.map(f => f.woNumber));
    const ruleFlaggedSet = new Set(wcRuleWOs.map(fw => fw.wo));
    const allFlaggedSet  = new Set([...aiFlaggedSet, ...ruleFlaggedSet]);
    const totalAIFlagInstances = wcAIFlags.length;
    const ruleFlagHits   = wcRuleWOs.reduce((s, fw) => s + fw.checks.length, 0);
    const totalFlags     = totalAIFlagInstances + ruleFlagHits;
    const cleanWOs       = wc.totalWOs - allFlaggedSet.size;

    const RULE_KEYS = [
      'missing_confirmation', 'not_listed_codes', 'missing_scoping_text', 'missing_codes',
    ] as const;
    const AI_KEYS = [
      'desc_code_conflict', 'false_not_listed', 'desc_confirmation_mismatch',
      'desc_code_confirmation_misalign', 'generic_description', 'generic_confirmation',
    ] as const;

    const errorDistribution = [
      ...RULE_KEYS.map(key => ({ key, label: RULE_LABELS[key], value: wc.ruleDistribution[key] ?? 0, type: 'Rule' })),
      ...AI_KEYS.map(key  => ({ key, label: AI_LABELS[key],   value: wc.aiDistribution[key]  ?? 0, type: 'AI'   })),
    ];

    const overallQuality = {
      valid:         cleanWOs,
      entryQuality:  aiFlaggedSet.size,
      missingFields: [...ruleFlaggedSet].filter(wo => !aiFlaggedSet.has(wo)).length,
      total:         wc.totalWOs,
    };

    // Top equipment — count distinct flagged WOs per equipment (AI ∪ rule)
    const equipWoMap = new Map<string, Set<string>>();
    for (const flag of wcAIFlags) {
      if (flag.equipment) {
        const s = equipWoMap.get(flag.equipment) ?? new Set<string>();
        s.add(flag.woNumber);
        equipWoMap.set(flag.equipment, s);
      }
    }
    // Also include rule-flagged WOs using equipment looked up from AI flags
    const woEquipmentMap = new Map((run?.aiFlags ?? []).map(f => [f.woNumber, f.equipment ?? '']));
    for (const fw of wcRuleWOs) {
      const eq = woEquipmentMap.get(fw.wo);
      if (eq) {
        const s = equipWoMap.get(eq) ?? new Set<string>();
        s.add(fw.wo);
        equipWoMap.set(eq, s);
      }
    }
    const topEquipment = [...equipWoMap.entries()]
      .sort(([, a], [, b]) => b.size - a.size)
      .slice(0, 10)
      .map(([equipment, wos]) => ({ equipment, count: wos.size }));

    // Code quality: invalid hierarchy = desc_code_conflict AI flags (aligned with main dashboard)
    const notListedWOs = new Set(
      wcRuleWOs.filter(fw => fw.checks.includes('not_listed_codes')).map(fw => fw.wo));
    const invalidHierarchyWOs = new Set(
      wcAIFlags.filter(f => f.category === 'desc_code_conflict').map(f => f.woNumber));
    const missingCodeWOs = new Set(
      wcRuleWOs.filter(fw =>
        fw.checks.includes('missing_codes') &&
        !notListedWOs.has(fw.wo) && !invalidHierarchyWOs.has(fw.wo)
      ).map(fw => fw.wo));
    const allCodeIssueWOs = new Set([...notListedWOs, ...invalidHierarchyWOs, ...missingCodeWOs]);
    const codeQuality = {
      valid: wc.totalWOs - allCodeIssueWOs.size,
      notListed: notListedWOs.size,
      invalidHierarchy: invalidHierarchyWOs.size,
      missing: missingCodeWOs.size,
    };

    const issues = [...allFlaggedSet].map(woNumber => {
      const flagsForWO = wcAIFlags.filter(f => f.woNumber === woNumber);
      const ruleEntry  = wcRuleWOs.find(fw => fw.wo === woNumber);
      const ref        = flagsForWO[0];
      // For rule-only WOs (no AI flag), fall back to the WO detail map from the DB query
      const detail = !ref ? woDetailMap.get(woNumber) : undefined;
      return {
        woNumber,
        equipment:   ref?.equipment   ?? detail?.equipment   ?? '',
        workCenter:  wc.workCenter,
        description: ref?.description ?? detail?.description ?? '',
        codes:       ref?.codes       ?? detail?.codes       ?? '',
        ruleFlags:   ruleEntry?.checks ?? [],
        aiFlags: flagsForWO.map(f => ({
          category:      f.category,
          severity:      f.severity,
          comment:       f.comment,
          rowSeq:        f.rowSeq ?? null,
          operationDesc: f.operationDesc ?? '',
          closure:       f.closure ?? '',
        })),
      };
    });

    // Build comparison data from all analysed runs in this project
    const analysedRuns = projectRuns
      .filter(r => r.stage === 'analysed' && r.ruleChecks)
      .sort((a, b) => a.runIndex - b.runIndex);
    const comparison = analysedRuns.length >= 2 ? {
      runs: analysedRuns.map(r => ({
        runIndex:       r.runIndex,
        periodLabel:    r.periodLabel,
        totalWOs:       r.ruleChecks!.totalWOs,
        ruleCategories: Object.fromEntries(
          Object.entries(r.ruleChecks!.perCheck ?? {}).map(([k, v]) => [k, (v as { matched: number }).matched ?? 0])
        ),
        aiCategories: r.aiFlagSummary?.byCategory ?? {},
      }))
    } : null;

    return {
      project: {
        name:   project?.name   ?? '',
        type:   project?.type   ?? 'TOTAL',
        period: project?.period ?? '',
      },
      run: {
        runIndex:             run?.runIndex ?? 1,
        periodLabel:          run?.periodLabel ?? '',
        fileName:             run?.fileName ?? '',
        lastAnalysedAt:       run?.lastAnalysedAt ?? '',
        analysisFilters:      { ...filters, workCenter: [wc.workCenter] },
        workCenterDescription: wc.description,
      },
      kpi: {
        totalWOs:       wc.totalWOs,
        ruleFlaggedWOs: wc.ruleFlagsCount,
        aiFlaggedWOs:   wc.aiFlagsCount,
        totalFlags,
        cleanWOs,
      },
      errorDistribution,
      codeQuality,
      overallQuality,
      perWorkCenter: [{ workCenter: wc.workCenter, total: wc.totalWOs, flagged: allFlaggedSet.size }],
      topEquipment,
      issues,
      comparison,
    };
  };

  const sendEmail = async (wc: WorkCenterAuditData) => {
    if (!aiConfig.reportingWebhookUrl) {
      alert('Please configure Reporting Integration URL in Settings first.');
      return;
    }
    const emailTo = reportingEmails[wc.workCenter];
    if (!emailTo) return;

    setSendingStatus(prev => ({ ...prev, [wc.workCenter]: 'sending' }));
    try {
      const res = await fetch(aiConfig.reportingWebhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailTo,
          subject: `Reliability Audit Report — ${wc.description || wc.workCenter}`,
          emailBody: `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc"><tr><td align="center" valign="top" style="padding:32px 16px"><table cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:680px;width:100%"><tr><td align="left" valign="top"><pre style="font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.7;color:#1e293b;white-space:pre-wrap;background:none;border:none;padding:0;margin:0">${renderTemplateHTML(getEmailText(wc))}</pre></td></tr></table></td></tr></table>`,
          dashboardJson: JSON.stringify(buildDashboardPayload(wc)),
        }),
      });
      setSendingStatus(prev => ({ ...prev, [wc.workCenter]: res.ok ? 'success' : 'error' }));
    } catch {
      setSendingStatus(prev => ({ ...prev, [wc.workCenter]: 'error' }));
    }
  };

  const sendBulk = async () => {
    const toSend = wcData.filter(w => selectedWCs.has(w.workCenter) && reportingEmails[w.workCenter]);
    for (const wc of toSend) await sendEmail(wc);
  };

  if (!run) return <div className="p-10 text-slate-500">No active run.</div>;

  return (
    <>
    <div className="flex flex-col h-full bg-slate-50">
      {/* ── Top bar ── */}
      <div className="bg-white border-b shrink-0 px-6 py-4 shadow-sm z-20 relative" style={{ overflow: 'visible' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <Icon name="mail" className="w-6 h-6 text-brand-600" />
              Audit Report Distribution
            </h1>
            <p className="text-sm text-slate-500 mt-1">Filter scope and dispatch summary reports to Work Center owners.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowTemplateModal(true)}
              className="px-4 py-2 text-sm border border-slate-300 rounded font-bold hover:bg-slate-50 transition flex items-center gap-2"
            >
              <Icon name="wand" className="w-4 h-4" /> Customize Template
              {activeTemplate && (
                <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-indigo-100 text-indigo-700 rounded truncate max-w-[120px]" title={activeTemplate.name}>
                  {activeTemplate.name}
                </span>
              )}
            </button>
            <button
              onClick={() => setScreen('reporting-settings')}
              className="px-4 py-2 text-sm border border-slate-300 rounded font-bold hover:bg-slate-50 transition flex items-center gap-2"
            >
              <Icon name="gear" className="w-4 h-4" /> Reporting Settings
            </button>
          </div>
        </div>

        {filterOptions ? (
          <FilterPanel
            filters={filters}
            onChange={setFilters}
            options={filterOptions}
            columnMap={run.columnMap}
            totalWOs={run.dataProfile?.distinctWOs ?? 0}
          />
        ) : (
          <div className="h-[68px] flex items-center justify-center text-xs text-slate-400">Loading filters…</div>
        )}
      </div>

      {/* ── Main split ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: WC table */}
        <div className="w-1/2 flex flex-col border-r border-slate-200 bg-white">
          <div className="p-4 border-b flex justify-between items-center bg-slate-50/50">
            <div className="flex items-center gap-2">
              <button
                onClick={handleSelectAll}
                className="px-3 py-1.5 text-xs font-bold border border-slate-300 rounded hover:bg-white transition"
              >
                {selectedWCs.size === wcData.length && wcData.length > 0 ? 'Deselect All' : 'Select All'}
              </button>
              <button
                onClick={() => setSelectedWCs(new Set())}
                disabled={selectedWCs.size === 0}
                className="px-3 py-1.5 text-xs font-bold border border-slate-300 rounded hover:bg-white transition disabled:opacity-40"
              >
                Clear
              </button>
            </div>
            <button
              onClick={sendBulk}
              disabled={selectedWCs.size === 0 || !aiConfig.reportingWebhookUrl}
              className="px-4 py-1.5 text-sm bg-brand-600 text-white rounded font-bold hover:bg-brand-700 transition disabled:opacity-50 flex items-center gap-2"
            >
              <Icon name="send" className="w-4 h-4" />
              Send Selected ({selectedWCs.size})
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingData ? (
              <div className="p-10 text-center text-slate-400 flex flex-col items-center gap-2">
                <Icon name="loader" className="w-6 h-6 animate-spin" />
                Loading work centers…
              </div>
            ) : wcData.length === 0 ? (
              <div className="p-10 text-center text-slate-400">
                {!run.columnMap?.work_center
                  ? 'Work Center column is not mapped. Please map it in the Schema Mapper.'
                  : 'No work centers match the current filters.'}
              </div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] font-bold border-b sticky top-0 z-[1]">
                  <tr>
                    <th className="px-4 py-2 w-8" />
                    <th className="px-4 py-2">Work Center</th>
                    <th className="px-4 py-2">Total WOs</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {wcData.map(wc => {
                    const hasEmail = !!reportingEmails[wc.workCenter];
                    const status = sendingStatus[wc.workCenter];
                    const selected = selectedWCs.has(wc.workCenter);
                    const isPreviewed = previewWC?.workCenter === wc.workCenter;

                    return (
                      <tr
                        key={wc.workCenter}
                        className={`transition ${isPreviewed ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelect(wc.workCenter)}
                            className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div
                              className={`w-2 h-2 rounded-full shrink-0 ${hasEmail ? 'bg-green-500' : 'bg-red-400'}`}
                              title={hasEmail ? reportingEmails[wc.workCenter] : 'No email assigned'}
                            />
                            <div>
                              <div className="font-mono font-medium text-slate-700">{wc.workCenter}</div>
                              {wc.description && (
                                <div className="text-xs text-slate-400 truncate max-w-[160px]">{wc.description}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-600">{wc.totalWOs}</td>
                        <td className="px-4 py-3 text-right flex items-center justify-end gap-2">
                          <button
                            onClick={() => setPreviewWC(wc)}
                            className="px-2 py-1 border border-slate-200 text-xs rounded font-bold text-slate-600 hover:bg-slate-100 transition"
                          >
                            Preview
                          </button>
                          <button
                            onClick={() => sendEmail(wc)}
                            disabled={!hasEmail || status === 'sending'}
                            className={`px-3 py-1 border text-xs rounded font-bold transition flex items-center gap-1 ${
                              status === 'sending' ? 'bg-slate-100 border-slate-200 text-slate-400' :
                              status === 'success' ? 'bg-green-500 border-green-600 text-white' :
                              status === 'error'   ? 'bg-red-500 border-red-600 text-white' :
                              hasEmail            ? 'bg-white border-brand-300 text-brand-600 hover:bg-brand-50' :
                                                    'bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed'
                            }`}
                          >
                            {status === 'sending' ? <Icon name="loader" className="w-3 h-3 animate-spin" /> :
                             status === 'success' ? <Icon name="check"  className="w-3 h-3" /> :
                             status === 'error'   ? <Icon name="alertTriangle" className="w-3 h-3" /> :
                                                    <Icon name="send"   className="w-3 h-3" />}
                            Send
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right: Email Preview */}
        <div className="w-1/2 bg-slate-100 p-6 flex flex-col overflow-y-auto">
          {previewWC ? (
            <div className="bg-white rounded-lg shadow-xl border border-slate-200 mx-auto w-full max-w-xl mt-4">
              <div className="border-b border-slate-100 bg-slate-50 p-4 rounded-t-lg space-y-2">
                <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Email Preview</div>
                <div className="flex text-sm gap-2">
                  <span className="w-16 text-slate-400 shrink-0">To:</span>
                  <span className="font-mono text-slate-700">
                    {reportingEmails[previewWC.workCenter] || (
                      <span className="text-red-500 italic">Unassigned — configure in Reporting Settings</span>
                    )}
                  </span>
                </div>
                <div className="flex text-sm gap-2">
                  <span className="w-16 text-slate-400 shrink-0">Subject:</span>
                  <span className="font-semibold text-slate-800">
                    Reliability Audit Report — {previewWC.description || previewWC.workCenter}
                  </span>
                </div>
              </div>
              <div
                className="p-6 text-xs font-mono text-slate-700 leading-relaxed"
                style={{ whiteSpace: 'pre-wrap' }}
                dangerouslySetInnerHTML={{ __html: renderTemplateHTML(getEmailText(previewWC)) }}
              />
            </div>
          ) : (
            <div className="m-auto text-center text-slate-400 max-w-xs">
              <Icon name="mail" className="w-12 h-12 mx-auto text-slate-300 mb-4" />
              <p>Select <strong>Preview</strong> on a Work Center to see its email summary here.</p>
            </div>
          )}
        </div>
      </div>
    </div>

    {showTemplateModal && (
      <TemplateEditorModal
        templates={emailTemplates}
        activeId={activeEmailTemplateId}
        onAdd={addEmailTemplate}
        onUpdate={updateEmailTemplate}
        onDelete={deleteEmailTemplate}
        onSetActive={setActiveEmailTemplate}
        onClose={() => setShowTemplateModal(false)}
      />
    )}
    </>
  );
}

// ─── Template editor modal ────────────────────────────────────────────────────

const DEFAULT_TEMPLATE_ID = '__default__';

interface TemplateEditorModalProps {
  templates: EmailTemplate[];
  activeId: string | null;
  onAdd:       (name: string, body: string) => string;
  onUpdate:    (id: string, updates: Partial<Pick<EmailTemplate, 'name' | 'body'>>) => void;
  onDelete:    (id: string) => void;
  onSetActive: (id: string | null) => void;
  onClose:     () => void;
}

function TemplateEditorModal(props: TemplateEditorModalProps) {
  const { templates, activeId, onAdd, onUpdate, onDelete, onSetActive, onClose } = props;

  // Selected template in the dropdown — DEFAULT_TEMPLATE_ID for the read-only built-in,
  // otherwise an EmailTemplate.id from the library.
  const [selectedId, setSelectedId] = useState<string>(activeId ?? DEFAULT_TEMPLATE_ID);
  const selected = useMemo(() => templates.find(t => t.id === selectedId) ?? null, [templates, selectedId]);
  const isDefault = selectedId === DEFAULT_TEMPLATE_ID;

  // Local editable copies — name + body. Reset whenever the selection changes.
  const [draftName, setDraftName] = useState(selected?.name ?? 'Default');
  const [draft, setDraft]         = useState(selected?.body ?? DEFAULT_EMAIL_TEMPLATE);
  useEffect(() => {
    setDraftName(selected?.name ?? 'Default');
    setDraft(selected?.body ?? DEFAULT_EMAIL_TEMPLATE);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mini-modal states
  const [showRef, setShowRef]     = useState(false);
  const [refSearch, setRefSearch] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [tableRows, setTableRows] = useState(3);
  const [tableCols, setTableCols] = useState(4);
  const [tableAutofit, setTableAutofit] = useState(true);
  const [tableHeader, setTableHeader]   = useState(true);
  const [showCalc, setShowCalc]   = useState(false);
  const [calcExpr, setCalcExpr]   = useState('({TotalWOs}-{CleanWOs})/{TotalWOs}*100');

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleCopy = (key: string) => {
    navigator.clipboard.writeText(key).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  // Insert text at the cursor position; replace selection if any
  const insertAtCursor = (text: string, opts?: { selectInsertion?: boolean }) => {
    const ta = textareaRef.current;
    if (!ta) {
      setDraft((d) => d + text);
      return;
    }
    const start = ta.selectionStart;
    const end   = ta.selectionEnd;
    const before = draft.slice(0, start);
    const after  = draft.slice(end);
    const next = before + text + after;
    setDraft(next);
    requestAnimationFrame(() => {
      ta.focus();
      const newStart = opts?.selectInsertion ? start : start + text.length;
      const newEnd   = start + text.length;
      ta.setSelectionRange(newStart, newEnd);
    });
  };

  // Wrap the current selection with a marker pair; if no selection, insert empty marker
  const wrapSelection = (open: string, close: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end   = ta.selectionEnd;
    const sel   = draft.slice(start, end);
    const before = draft.slice(0, start);
    const after  = draft.slice(end);
    const wrapped = open + (sel || '') + close;
    setDraft(before + wrapped + after);
    requestAnimationFrame(() => {
      ta.focus();
      // Place cursor inside the wrapper if no selection, or select the wrapped content
      const innerStart = start + open.length;
      const innerEnd   = innerStart + sel.length;
      ta.setSelectionRange(innerStart, innerEnd);
    });
  };

  // Insert a table block at the cursor based on the mini-modal inputs
  const handleInsertTable = () => {
    const rows = Math.max(1, Math.min(20, Math.floor(tableRows || 1)));
    const cols = Math.max(1, Math.min(10, Math.floor(tableCols || 1)));
    const attrs = [`rows=${rows}`, `cols=${cols}`];
    if (tableAutofit) attrs.push('autofit=1');
    if (tableHeader)  attrs.push('header=1');
    const headerRow = tableHeader
      ? '| ' + Array.from({ length: cols }, (_, i) => `Header ${i + 1}`).join(' | ') + ' |'
      : null;
    const bodyRowCount = headerRow ? rows - 1 : rows;
    const bodyRows = Array.from({ length: Math.max(0, bodyRowCount) }, () =>
      '| ' + Array.from({ length: cols }, () => 'Cell').join(' | ') + ' |'
    );
    const lines = [
      `[TABLE ${attrs.join(' ')}]`,
      ...(headerRow ? [headerRow] : []),
      ...bodyRows,
      `[/TABLE]`,
    ];
    insertAtCursor('\n' + lines.join('\n') + '\n');
    setShowTable(false);
  };

  const handleInsertCalc = () => {
    const trimmed = (calcExpr || '').trim();
    if (!trimmed) return;
    insertAtCursor(`calculate(${trimmed})`);
    setShowCalc(false);
  };

  // Field reference — search/group/copy
  const q = refSearch.trim().toLowerCase();
  const filtered = q
    ? TEMPLATE_FIELD_REFERENCE.filter(f =>
        f.key.toLowerCase().includes(q) ||
        f.label.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q)
      )
    : TEMPLATE_FIELD_REFERENCE;
  const groups = q ? null : Array.from(
    TEMPLATE_FIELD_REFERENCE.reduce((m, f) => {
      if (!m.has(f.group)) m.set(f.group, []);
      m.get(f.group)!.push(f);
      return m;
    }, new Map<string, FieldRef[]>())
  );

  const FieldRow = ({ f }: { f: FieldRef }) => (
    <div className="flex items-start gap-2 text-xs py-1">
      <button
        onClick={() => handleCopy(f.key)}
        title="Click to copy"
        className="shrink-0 flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded font-mono text-[11px] transition group"
      >
        {copiedKey === f.key ? '✓ Copied' : f.key}
      </button>
      <span className="text-slate-700 font-medium">{f.label}</span>
      <span className="text-slate-400 hidden sm:inline">—</span>
      <span className="text-slate-500 hidden sm:inline">{f.description}</span>
      <span className="ml-auto shrink-0 bg-slate-100 text-slate-500 px-1 py-0.5 rounded text-[10px] font-mono">{f.example}</span>
    </div>
  );

  // ── Save / New / Delete handlers ─────────────────────────────────────────────
  const handleSaveAsNew = () => {
    const name = window.prompt('New template name:', draftName === 'Default' ? 'Custom Template' : draftName);
    if (!name) return;
    const newId = onAdd(name.trim(), draft);
    setSelectedId(newId);
  };

  const handleSave = () => {
    if (isDefault) {
      // Default is read-only — fork into a new template instead
      handleSaveAsNew();
      return;
    }
    onUpdate(selectedId, { name: draftName.trim() || 'Untitled', body: draft });
    onSetActive(selectedId);
    onClose();
  };

  const handleDelete = () => {
    if (isDefault) return;
    const cur = selected;
    if (!cur) return;
    if (!window.confirm(`Delete template "${cur.name}"? This cannot be undone.`)) return;
    onDelete(cur.id);
    setSelectedId(DEFAULT_TEMPLATE_ID);
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col">

        {/* Header — title + close */}
        <div className="flex items-center justify-between px-6 py-3 border-b shrink-0">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Email Template Editor</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Use <span className="font-mono bg-slate-100 px-1 rounded text-slate-700">{'{PLACEHOLDER}'}</span>, <span className="font-mono bg-slate-100 px-1 rounded text-slate-700">[B]…[/B]</span>, <span className="font-mono bg-slate-100 px-1 rounded text-slate-700">[TABLE …][/TABLE]</span>, and <span className="font-mono bg-slate-100 px-1 rounded text-slate-700">calculate(…)</span> markers — they're replaced when the email is sent.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition p-1 rounded">
            <Icon name="x" className="w-5 h-5" />
          </button>
        </div>

        {/* Template selector + name */}
        <div className="px-6 py-3 border-b shrink-0 bg-slate-50/50 flex items-center gap-3 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-slate-500 font-bold">Template</span>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="text-sm border border-slate-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-400 min-w-[180px]"
          >
            <option value={DEFAULT_TEMPLATE_ID}>Default (built-in)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {!isDefault && (
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Template name"
              className="text-sm border border-slate-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleSaveAsNew}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded font-bold hover:bg-white transition flex items-center gap-1.5"
              title="Save current draft as a new template"
            >
              <Icon name="copy" className="w-3.5 h-3.5" /> Save As New
            </button>
            <button
              onClick={() => { onSetActive(isDefault ? null : selectedId); onClose(); }}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded font-bold hover:bg-white transition"
              title="Use this template for outgoing emails"
            >
              Set Active
            </button>
            <button
              onClick={handleDelete}
              disabled={isDefault}
              className="px-3 py-1.5 text-xs border border-red-200 rounded font-bold text-red-600 hover:bg-red-50 transition disabled:opacity-30 disabled:cursor-not-allowed"
              title={isDefault ? 'The Default template cannot be deleted' : 'Delete this template'}
            >
              Delete
            </button>
          </div>
        </div>

        {/* Formatting toolbar */}
        <div className="px-6 py-2 border-b shrink-0 flex items-center gap-1 flex-wrap bg-white">
          <button
            onClick={() => wrapSelection('[B]', '[/B]')}
            title="Bold"
            className="w-8 h-8 flex items-center justify-center font-bold text-slate-700 hover:bg-slate-100 rounded transition"
          >
            B
          </button>
          <button
            onClick={() => wrapSelection('[I]', '[/I]')}
            title="Italic"
            className="w-8 h-8 flex items-center justify-center italic text-slate-700 hover:bg-slate-100 rounded transition"
          >
            I
          </button>
          <button
            onClick={() => wrapSelection('[U]', '[/U]')}
            title="Underline"
            className="w-8 h-8 flex items-center justify-center underline text-slate-700 hover:bg-slate-100 rounded transition"
          >
            U
          </button>
          <button
            onClick={() => wrapSelection('[S]', '[/S]')}
            title="Strikethrough"
            className="w-8 h-8 flex items-center justify-center line-through text-slate-700 hover:bg-slate-100 rounded transition"
          >
            S
          </button>
          <div className="h-5 w-px bg-slate-200 mx-1" />
          <button
            onClick={() => setShowTable((v) => !v)}
            className={`px-2.5 h-8 flex items-center gap-1.5 text-xs font-bold rounded transition ${showTable ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-100'}`}
            title="Insert a pipe-delimited table block"
          >
            <Icon name="table" className="w-3.5 h-3.5" /> Insert Table
          </button>
          <button
            onClick={() => setShowCalc((v) => !v)}
            className={`px-2.5 h-8 flex items-center gap-1.5 text-xs font-bold rounded transition ${showCalc ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-100'}`}
            title="Insert a calculated arithmetic expression"
          >
            ƒ Insert Calculation
          </button>
          <div className="ml-auto text-[10px] text-slate-400 font-mono">
            Markers: [B] [I] [U] [S] [TABLE …][/TABLE] · calculate(…)
          </div>
        </div>

        {/* Conditional mini-modals (table builder + calculation builder) */}
        {showTable && (
          <div className="px-6 py-3 border-b bg-amber-50/40 flex items-end gap-3 flex-wrap shrink-0">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Rows</label>
              <input type="number" min={1} max={20} value={tableRows} onChange={(e) => setTableRows(Number(e.target.value))} className="w-16 text-sm border border-slate-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-brand-400" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Columns</label>
              <input type="number" min={1} max={10} value={tableCols} onChange={(e) => setTableCols(Number(e.target.value))} className="w-16 text-sm border border-slate-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-brand-400" />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
              <input type="checkbox" checked={tableAutofit} onChange={(e) => setTableAutofit(e.target.checked)} />
              AutoFit Contents
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
              <input type="checkbox" checked={tableHeader} onChange={(e) => setTableHeader(e.target.checked)} />
              Header row (bold)
            </label>
            <div className="ml-auto flex gap-2">
              <button onClick={() => setShowTable(false)} className="px-3 py-1.5 text-xs border border-slate-300 rounded font-bold hover:bg-white">Cancel</button>
              <button onClick={handleInsertTable} className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded font-bold hover:bg-brand-700">Insert</button>
            </div>
          </div>
        )}
        {showCalc && (
          <div className="px-6 py-3 border-b bg-violet-50/40 flex flex-col gap-2 shrink-0">
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Expression</label>
              <input
                value={calcExpr}
                onChange={(e) => setCalcExpr(e.target.value)}
                placeholder="({TotalWOs}-{CleanWOs})/{TotalWOs}*100"
                className="flex-1 text-sm font-mono border border-slate-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
              <div className="flex gap-1">
                {['(', ')', '+', '-', '*', '/'].map((op) => (
                  <button key={op} onClick={() => setCalcExpr((s) => s + op)} className="w-7 h-7 text-sm font-mono text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100">{op}</button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 shrink-0">Insert placeholder:</span>
              {['{TotalWOs}', '{CleanWOs}', '{TotalRuleFlaggedWOs}', '{TotalAIFlaggedWOs}', '{TotalFlags}', '{PrevTotalWOs}', '{DeltaTotalWOs}'].map((p) => (
                <button key={p} onClick={() => setCalcExpr((s) => s + p)} className="text-[11px] font-mono bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-700 hover:bg-indigo-50 hover:border-indigo-200">{p}</button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowCalc(false)} className="px-3 py-1.5 text-xs border border-slate-300 rounded font-bold hover:bg-white">Cancel</button>
              <button onClick={handleInsertCalc} className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded font-bold hover:bg-brand-700">Insert calculate(…)</button>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4 min-h-0">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="w-full font-mono text-xs text-slate-800 border border-slate-300 rounded p-3 resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 leading-relaxed"
            rows={isDefault ? 24 : 22}
            spellCheck={false}
            readOnly={isDefault}
          />
          {isDefault && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-1.5">
              The Default template is read-only. Click <b>Save As New</b> to fork it into your library.
            </p>
          )}

          {/* Field Reference */}
          <div className="border border-slate-200 rounded">
            <button
              onClick={() => setShowRef(v => !v)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50 transition rounded"
            >
              Field Reference — {TEMPLATE_FIELD_REFERENCE.length} available placeholders
              <Icon name={showRef ? 'chevronUp' : 'chevronDown'} className="w-3.5 h-3.5" />
            </button>
            {showRef && (
              <div className="border-t border-slate-100">
                {/* Search bar */}
                <div className="px-4 pt-3 pb-2">
                  <input
                    type="text"
                    value={refSearch}
                    onChange={e => setRefSearch(e.target.value)}
                    placeholder="Search placeholders by name, label or description…"
                    className="w-full text-xs border border-slate-200 rounded px-3 py-1.5 font-mono focus:outline-none focus:ring-2 focus:ring-brand-400 bg-slate-50 placeholder-slate-400"
                  />
                </div>
                {/* Results */}
                <div className="px-4 pb-4 max-h-72 overflow-y-auto scroll-thin">
                  {q ? (
                    filtered.length === 0
                      ? <p className="text-xs text-slate-400 py-2">No placeholders match "{refSearch}".</p>
                      : filtered.map(f => <FieldRow key={f.key} f={f} />)
                  ) : (
                    groups!.map(([grp, items]) => (
                      <div key={grp} className="mb-3">
                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider py-1.5 border-b border-slate-100 mb-1">{grp}</div>
                        {items.map(f => <FieldRow key={f.key} f={f} />)}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t shrink-0 bg-slate-50 rounded-b-xl">
          <button
            onClick={() => setDraft(DEFAULT_EMAIL_TEMPLATE)}
            disabled={isDefault}
            className="px-3 py-2 text-sm border border-slate-300 rounded font-bold text-red-600 hover:bg-red-50 hover:border-red-300 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Reset to Default Body
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm border border-slate-300 rounded font-bold hover:bg-slate-100 transition"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-brand-600 text-white rounded font-bold hover:bg-brand-700 transition"
            >
              {isDefault ? 'Save As New' : 'Save Template'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
