import React, { useState, useEffect, useCallback } from 'react';
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
import type { AnalysisFilters, FilterOptions, ColumnMap, AIFlag, RuleCheckResult } from '../types';

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

const TEMPLATE_FIELD_REFERENCE = [
  { key: '{ProjectName}',         label: 'Project Name',             example: 'Q1 2026 Reliability Audit' },
  { key: '{WorkCenterLabel}',     label: 'Work Center (with desc)',   example: 'A100 (Mechanical)' },
  { key: '{PeriodLabel}',         label: 'Period Label',             example: '01 Jan – 31 Mar 2026' },
  { key: '{GeneratedDate}',       label: 'Generated Date',           example: '29 Apr 2026' },
  { key: '{AuditScope}',          label: 'Audit Scope (date range)', example: '01 Jan 2026 to 31 Mar 2026' },
  { key: '{WorkCenter}',          label: 'Work Center ID',           example: 'A100' },
  { key: '{TotalWOs}',            label: 'Total WOs Analyzed',       example: '245' },
  { key: '{TotalRuleFlaggedWOs}', label: 'Rule-Flagged WOs',         example: '12' },
  { key: '{TotalAIFlaggedWOs}',   label: 'AI-Flagged WOs',           example: '8' },
  { key: '{ErrorDistSection}',    label: 'Error Distribution Block', example: '(auto-generated table)' },
  { key: '{Sep}',                 label: 'Separator line (═ × 58)',  example: '══════…' },
  { key: '{Dash}',                label: 'Section divider (─ × 42)', example: '──────…' },
];

// ─────────────────────────────────────────────────────────────────────────────

export default function AuditReportScreen() {
  const run = useActiveRun();
  const project = useActiveProject();
  const projectRuns = useRunsForProject(run?.projectId ?? null);
  const { reportingEmails, aiConfig, setScreen, emailTemplate, setEmailTemplate } = useStore();

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

    const template = emailTemplate ?? DEFAULT_EMAIL_TEMPLATE;
    return template
      .replace(/{Sep}/g,                sep)
      .replace(/{Dash}/g,               dash)
      .replace(/{ProjectName}/g,        projectName)
      .replace(/{WorkCenterLabel}/g,    wcLabel)
      .replace(/{PeriodLabel}/g,        periodLabel || scope)
      .replace(/{GeneratedDate}/g,      now)
      .replace(/{AuditScope}/g,         scope)
      .replace(/{WorkCenter}/g,         wc.workCenter)
      .replace(/{TotalWOs}/g,           String(wc.totalWOs))
      .replace(/{TotalRuleFlaggedWOs}/g, String(wc.ruleFlagsCount))
      .replace(/{TotalAIFlaggedWOs}/g,  String(wc.aiFlagsCount))
      .replace(/{ErrorDistSection}/g,   errorDistSection);
  };

  const buildDashboardPayload = (wc: WorkCenterAuditData) => {
    const woSet = new Set(wc.woNumbers);

    const wcAIFlags  = (run?.aiFlags ?? []).filter(f => woSet.has(f.woNumber));
    const wcRuleWOs  = (run?.ruleChecks?.flaggedWOs ?? []).filter(fw => woSet.has(fw.wo));

    const aiFlaggedSet   = new Set(wcAIFlags.map(f => f.woNumber));
    const ruleFlaggedSet = new Set(wcRuleWOs.map(fw => fw.wo));
    const allFlaggedSet  = new Set([...aiFlaggedSet, ...ruleFlaggedSet]);
    const totalAIFlagInstances = wcAIFlags.length;
    const ruleFlagHits   = wcRuleWOs.reduce((s, fw) => s + fw.checks.length, 0);
    const totalFlags     = totalAIFlagInstances + ruleFlagHits;
    const cleanWOs       = wc.totalWOs - allFlaggedSet.size;

    const RULE_KEYS = [
      'missing_confirmation', 'not_listed_codes', 'missing_scoping_text',
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
        fw.checks.some(c => ['catalog_missing_match', 'missing_scoping_text'].includes(c)) &&
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
          emailBody: `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc"><tr><td align="center" valign="top" style="padding:32px 16px"><table cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:680px;width:100%"><tr><td align="left" valign="top"><pre style="font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.7;color:#1e293b;white-space:pre-wrap;background:none;border:none;padding:0;margin:0">${getEmailText(wc)}</pre></td></tr></table></td></tr></table>`,
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
              {emailTemplate && (
                <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-indigo-100 text-indigo-700 rounded">Custom</span>
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
              <pre className="p-6 text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed">
                {getEmailText(previewWC)}
              </pre>
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
        initial={emailTemplate ?? DEFAULT_EMAIL_TEMPLATE}
        onSave={(t) => setEmailTemplate(t)}
        onClose={() => setShowTemplateModal(false)}
      />
    )}
    </>
  );
}

// ─── Template editor modal ────────────────────────────────────────────────────

function TemplateEditorModal({
  initial,
  onSave,
  onClose,
}: {
  initial: string;
  onSave: (t: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [showRef, setShowRef] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Email Template Editor</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Edit the free text around <span className="font-mono bg-slate-100 px-1 rounded text-slate-700">{'{PLACEHOLDER}'}</span> markers — those are replaced with live data when the email is sent.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition p-1 rounded">
            <Icon name="x" className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4 min-h-0">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="w-full font-mono text-xs text-slate-800 border border-slate-300 rounded p-3 resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 leading-relaxed"
            rows={28}
            spellCheck={false}
          />

          {/* Field Reference */}
          <div className="border border-slate-200 rounded">
            <button
              onClick={() => setShowRef(v => !v)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50 transition rounded"
            >
              Field Reference — available placeholders
              <Icon name={showRef ? 'chevronUp' : 'chevronDown'} className="w-3.5 h-3.5" />
            </button>
            {showRef && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 p-4 border-t border-slate-100">
                {TEMPLATE_FIELD_REFERENCE.map(f => (
                  <div key={f.key} className="flex items-start gap-2 text-xs">
                    <code className="shrink-0 bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded font-mono text-[11px]">{f.key}</code>
                    <span className="text-slate-600">{f.label} <span className="text-slate-400">— e.g. {f.example}</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t shrink-0 bg-slate-50 rounded-b-xl">
          <button
            onClick={() => setDraft(DEFAULT_EMAIL_TEMPLATE)}
            className="px-3 py-2 text-sm border border-slate-300 rounded font-bold text-red-600 hover:bg-red-50 hover:border-red-300 transition"
          >
            Reset to Default
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm border border-slate-300 rounded font-bold hover:bg-slate-100 transition"
            >
              Cancel
            </button>
            <button
              onClick={() => { onSave(draft); onClose(); }}
              className="px-4 py-2 text-sm bg-brand-600 text-white rounded font-bold hover:bg-brand-700 transition"
            >
              Save Template
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
