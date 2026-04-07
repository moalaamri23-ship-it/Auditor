/**
 * AI Text Analysis Module
 *
 * Queries v_analysis_scope for WO text fields, sends batches of 20 WOs to the
 * AI, and writes per-record flags back to the ai_flags DuckDB table.
 *
 * The AI only sees sanitized text — no timestamps, no equipment IDs beyond what
 * is already visible in the WO description.  Raw row data never leaves DuckDB
 * except as the bounded text fields listed below.
 *
 * Flag categories:
 *   desc_code_alignment   — WO description vs reliability / failure codes
 *   confirmation_relevance — Confirmation unrelated to work described
 *   confirmation_quality  — Confirmation too vague / generic / copy-pasted
 *   code_completeness     — Codes missing when description implies they apply
 *   generic_description   — WO description too generic to be actionable
 */

import { query, createAIFlagsTable, insertAIFlagsBatch } from '../services/DuckDBService';
import { callAI } from '../services/AIService';
import type { ColumnMap, AIFlag, AIFlagSummary, FlagCategory, AIConfig } from '../types';

// ─── Batch size ───────────────────────────────────────────────────────────────

const BATCH_SIZE = 20;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a SAP PM data quality analyst reviewing maintenance work order records.

Your task: identify data quality issues in the text fields of each work order.

Check for these issues:
1. desc_code_alignment — The WO/notification description contradicts or is inconsistent with the assigned reliability codes, failure mode, or cause code. For example: description says "routine inspection" but failure mode is "CATASTROPHIC_FAILURE".
2. confirmation_relevance — The confirmation text (short or long) does not relate to the work described in the WO. For example: WO is for a pump repair but confirmation says "lubricated bearings on compressor".
3. confirmation_quality — The confirmation text is too vague, generic, or appears copy-pasted (e.g., "done", "completed", "work done as per procedure" with no specifics).
4. code_completeness — Key reliability codes (failure mode, cause code) are empty/missing, but the description clearly implies what they should be.
5. generic_description — The WO description is so generic (e.g., "Maintenance work", "PM job", "Repair") that it carries no diagnostic value.

Rules:
- Only flag records with real issues. Do not flag records that look correct.
- Be specific in comments — reference the actual text, not generic advice.
- Limit comment to 120 characters.
- A single WO can have multiple flags across different categories.
- Return ONLY a valid JSON array. No prose, no markdown, no code fences.

Output format:
[
  {"wo": "WO_NUMBER", "cat": "category_name", "sev": "HIGH|MEDIUM|LOW", "cmt": "specific comment"},
  ...
]

If there are no issues, return: []`;

// ─── WO record shape sent to AI ───────────────────────────────────────────────

interface WORecord {
  wo:        string;
  desc:      string;
  notif:     string;
  rc1:       string;
  rc2:       string;
  rc3:       string;
  fm:        string;  // failure_mode
  cc:        string;  // cause_code
  conf:      string;  // confirmation_text (short)
  conf_long: string;  // confirmation_long_text
  equip:     string;  // for display in flag, not sent to AI
}

// ─── AI response item ─────────────────────────────────────────────────────────

interface AIResponseItem {
  wo:  string;
  cat: string;
  sev: string;
  cmt: string;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export interface AITextModuleOptions {
  sessionId:    string;
  columnMap:    ColumnMap;
  aiConfig:     AIConfig;
  scopeWOCount: number;
  onProgress:   (processed: number, total: number) => void;
  cancelRef:    { current: boolean };
}

export async function runAITextModule(
  opts: AITextModuleOptions
): Promise<AIFlagSummary> {
  const { columnMap, aiConfig, scopeWOCount, onProgress, cancelRef } = opts;

  // ── 1. Build SELECT from available columns ─────────────────────────────────
  const col = (c: string) => columnMap[c as keyof ColumnMap] ? c : "''";

  const rows = await query(`
    SELECT
      ${columnMap.work_order_number      ? 'work_order_number'       : "'' AS work_order_number"},
      ${columnMap.work_order_description ? 'work_order_description'  : "'' AS work_order_description"},
      ${columnMap.notification_description ? 'notification_description' : "'' AS notification_description"},
      ${columnMap.reliability_code_1     ? 'reliability_code_1'      : "'' AS reliability_code_1"},
      ${columnMap.reliability_code_2     ? 'reliability_code_2'      : "'' AS reliability_code_2"},
      ${columnMap.reliability_code_3     ? 'reliability_code_3'      : "'' AS reliability_code_3"},
      ${columnMap.failure_mode           ? 'failure_mode'            : "'' AS failure_mode"},
      ${columnMap.cause_code             ? 'cause_code'              : "'' AS cause_code"},
      ${columnMap.confirmation_text      ? 'confirmation_text'       : "'' AS confirmation_text"},
      ${columnMap.confirmation_long_text ? 'confirmation_long_text'  : "'' AS confirmation_long_text"},
      ${columnMap.equipment              ? 'equipment'               : "'' AS equipment"}
    FROM v_analysis_scope
    ORDER BY work_order_number
  `);

  const woRecords: WORecord[] = rows.map(r => ({
    wo:        String(r.work_order_number       ?? '').trim(),
    desc:      String(r.work_order_description  ?? '').trim(),
    notif:     String(r.notification_description ?? '').trim(),
    rc1:       String(r.reliability_code_1      ?? '').trim(),
    rc2:       String(r.reliability_code_2      ?? '').trim(),
    rc3:       String(r.reliability_code_3      ?? '').trim(),
    fm:        String(r.failure_mode            ?? '').trim(),
    cc:        String(r.cause_code              ?? '').trim(),
    conf:      String(r.confirmation_text       ?? '').trim(),
    conf_long: String(r.confirmation_long_text  ?? '').trim(),
    equip:     String(r.equipment               ?? '').trim(),
  }));

  // ── 2. Prepare DuckDB table ────────────────────────────────────────────────
  await createAIFlagsTable();

  const allFlags: AIFlag[] = [];
  let processed = 0;

  // ── 3. Process in batches ─────────────────────────────────────────────────
  for (let i = 0; i < woRecords.length; i += BATCH_SIZE) {
    if (cancelRef.current) break;

    const batch = woRecords.slice(i, i + BATCH_SIZE);
    const batchFlags = await _processBatch(batch, aiConfig);

    if (batchFlags.length > 0) {
      await insertAIFlagsBatch(batchFlags);
      allFlags.push(...batchFlags);
    }

    processed = Math.min(i + BATCH_SIZE, woRecords.length);
    onProgress(processed, woRecords.length);
  }

  // ── 4. Compute summary ────────────────────────────────────────────────────
  const byCategory: Record<FlagCategory, number> = {
    desc_code_alignment:    0,
    confirmation_relevance: 0,
    confirmation_quality:   0,
    code_completeness:      0,
    generic_description:    0,
  };

  for (const f of allFlags) {
    if (f.category in byCategory) {
      byCategory[f.category as FlagCategory]++;
    }
  }

  const distinctWOs = new Set(allFlags.map(f => f.woNumber)).size;

  return {
    totalFlagged:  distinctWOs,
    totalFlags:    allFlags.length,
    byCategory,
    generatedAt:   new Date().toISOString(),
    scopeWOCount,
  };
}

// ─── Batch processor ─────────────────────────────────────────────────────────

async function _processBatch(
  batch: WORecord[],
  aiConfig: AIConfig
): Promise<AIFlag[]> {
  // Build the payload — only text fields, no timestamps or raw IDs beyond WO#
  const payload = batch.map(r => {
    const parts: Record<string, string> = { wo: r.wo };
    if (r.desc)      parts.desc  = r.desc.slice(0, 200);
    if (r.notif)     parts.notif = r.notif.slice(0, 200);
    if (r.rc1)       parts.rc1   = r.rc1;
    if (r.rc2)       parts.rc2   = r.rc2;
    if (r.rc3)       parts.rc3   = r.rc3;
    if (r.fm)        parts.fm    = r.fm;
    if (r.cc)        parts.cc    = r.cc;
    if (r.conf)      parts.conf  = r.conf.slice(0, 300);
    if (r.conf_long) parts.conf_long = r.conf_long.slice(0, 500);
    return parts;
  });

  let responseText = '';
  try {
    responseText = await callAI(
      aiConfig.provider,
      aiConfig.apiKey,
      aiConfig.modelId,
      [{ role: 'user', content: JSON.stringify(payload) }],
      SYSTEM_PROMPT,
    );
  } catch {
    // If AI call fails for this batch, skip it gracefully
    return [];
  }

  // Parse JSON — strip any accidental markdown fences
  const cleaned = responseText.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');

  let parsed: AIResponseItem[] = [];
  try {
    const raw = JSON.parse(cleaned);
    if (Array.isArray(raw)) parsed = raw;
  } catch {
    return [];
  }

  // Map back to AIFlag, validate categories and severity
  const VALID_CATEGORIES: FlagCategory[] = [
    'desc_code_alignment',
    'confirmation_relevance',
    'confirmation_quality',
    'code_completeness',
    'generic_description',
  ];
  const VALID_SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;

  // Build wo→equip/desc lookup
  const lookup = new Map(batch.map(r => [r.wo, r]));

  const flags: AIFlag[] = [];
  for (const item of parsed) {
    if (!item.wo || !item.cat || !item.sev || !item.cmt) continue;
    if (!VALID_CATEGORIES.includes(item.cat as FlagCategory)) continue;
    if (!VALID_SEVERITIES.includes(item.sev as any)) continue;

    const source = lookup.get(item.wo);
    flags.push({
      woNumber:    item.wo,
      category:    item.cat as FlagCategory,
      severity:    item.sev as AIFlag['severity'],
      comment:     String(item.cmt).slice(0, 150),
      description: source?.desc ?? '',
      equipment:   source?.equip ?? '',
    });
  }

  return flags;
}
