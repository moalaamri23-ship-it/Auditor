/**
 * AI Text Analysis Module — Triangle Check
 *
 * SAP PM records contain three artefacts written by different people at
 * different times:
 *
 *   SYMPTOM        — WO/notification description (operator, at notification)
 *   CLASSIFICATION — Reliability codes: failure mode, cause code, RC1/2/3
 *                    (technician/planner, at closure)
 *   CLOSURE        — Confirmation text short + long (technician, at closure)
 *
 * This module checks all three pairwise relationships (clashes) plus the
 * individual quality of each artefact:
 *
 *   symptom_code_conflict     — SYMPTOM ↔ CLASSIFICATION clash
 *   symptom_closure_conflict  — SYMPTOM ↔ CLOSURE clash
 *   code_closure_conflict     — CLASSIFICATION ↔ CLOSURE clash
 *   incomplete_classification — CLASSIFICATION quality (missing codes)
 *   poor_closure              — CLOSURE quality (vague/generic)
 *   generic_symptom           — SYMPTOM quality (too generic to audit)
 *
 * Each flag carries snapshots of the relevant artefacts for side-by-side
 * display in the UI without a DuckDB round-trip.
 */

import { query, createAIFlagsTable, insertAIFlagsBatch } from '../services/DuckDBService';
import { callAI } from '../services/AIService';
import type { ColumnMap, AIFlag, AIFlagSummary, FlagCategory, AIConfig } from '../types';

const BATCH_SIZE = 20;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a SAP PM data quality auditor. You review maintenance work order records and detect documentation quality issues.

Each SAP PM work order has three artefacts:
1. SYMPTOM — the WO/notification description written by the OPERATOR at the time they raised the notification. It describes what was observed (the symptom).
2. CLASSIFICATION — reliability codes assigned by the TECHNICIAN when closing the WO: failure mode code (fm), cause code (cc), reliability codes (rc1, rc2, rc3). These classify what actually failed and why.
3. CLOSURE — confirmation text written by the TECHNICIAN when closing: short confirmation (conf) and long confirmation (conf_long). This narrates what was found and done.

Your task: perform a triangle check — examine all three pairwise relationships and individual artefact quality.

FLAG CATEGORIES (use exactly these identifiers):

CLASH CHECKS (two artefacts contradict each other):
- symptom_code_conflict: The symptom description and the assigned codes are inconsistent. e.g., symptom says "bearing noise" but failure mode = CORROSION; or symptom says "routine greasing" but breakdown indicator is coded as failure.
- symptom_closure_conflict: The symptom description and the closure confirmation describe different things. e.g., symptom says "pump leaking at seal" but confirmation says "replaced motor bearings on compressor".
- code_closure_conflict: The classification codes and the closure confirmation are inconsistent. e.g., cause code = CORROSION but confirmation text says "replaced worn bearings due to fatigue".

QUALITY CHECKS (individual artefact is poor quality):
- incomplete_classification: Failure mode, cause code, and all reliability codes are blank or missing, but the symptom description clearly implies what they should be. Only flag if the description is specific enough to expect codes.
- poor_closure: The confirmation text (short and/or long) is too vague, too short, or clearly copy-pasted. Examples: "work done", "completed as per procedure", "PM carried out", single-word confirmations, or text identical to the WO description with nothing added.
- generic_symptom: The WO description is so generic it cannot be cross-checked with codes or closure. Examples: "Maintenance work", "PM job", "Repair equipment", "As per schedule". Note: if generic_symptom is raised, clash checks for that WO are unreliable — the other flags may not apply.

RULES:
- A single WO can have multiple flags from different categories.
- Only flag real issues. Do not flag records that look correct.
- Be specific: reference actual words from the text in your comment.
- Keep comments under 150 characters.
- Return ONLY a valid JSON array. No prose, no markdown fences.
- If there are no issues, return: []

OUTPUT FORMAT:
[
  {"wo": "WO_NUMBER", "cat": "category_id", "sev": "HIGH|MEDIUM|LOW", "cmt": "specific comment referencing actual text"}
]

SEVERITY GUIDE:
- HIGH: Clear, direct contradiction between artefacts, or completely empty classification with specific symptom
- MEDIUM: Partial mismatch, ambiguous alignment, or confirmation that adds no information beyond the WO description
- LOW: Minor inconsistency, possible but uncertain mismatch, or borderline generic text`;

// ─── WO record sent to AI ─────────────────────────────────────────────────────

interface WORecord {
  wo:        string;
  symptom:   string;   // WO/notification description
  fm:        string;   // failure_mode
  cc:        string;   // cause_code
  rc1:       string;
  rc2:       string;
  rc3:       string;
  conf:      string;   // confirmation_text (short)
  conf_long: string;   // confirmation_long_text
  equipment: string;
}

// ─── AI response item ─────────────────────────────────────────────────────────

interface AIResponseItem {
  wo:  string;
  cat: string;
  sev: string;
  cmt: string;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface AITextModuleOptions {
  sessionId:    string;
  columnMap:    ColumnMap;
  aiConfig:     AIConfig;
  scopeWOCount: number;
  onProgress:   (processed: number, total: number) => void;
  cancelRef:    { current: boolean };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function runAITextModule(opts: AITextModuleOptions): Promise<AIFlagSummary> {
  const { columnMap, aiConfig, scopeWOCount, onProgress, cancelRef } = opts;

  // ── 1. Fetch WO text fields from v_analysis_scope ─────────────────────────
  const rows = await query(`
    SELECT
      ${columnMap.work_order_number        ? 'work_order_number'        : "'' AS work_order_number"},
      ${columnMap.work_order_description   ? 'work_order_description'   : columnMap.notification_description ? 'notification_description AS work_order_description' : "'' AS work_order_description"},
      ${columnMap.failure_mode             ? 'failure_mode'             : "'' AS failure_mode"},
      ${columnMap.cause_code               ? 'cause_code'               : "'' AS cause_code"},
      ${columnMap.reliability_code_1       ? 'reliability_code_1'       : "'' AS reliability_code_1"},
      ${columnMap.reliability_code_2       ? 'reliability_code_2'       : "'' AS reliability_code_2"},
      ${columnMap.reliability_code_3       ? 'reliability_code_3'       : "'' AS reliability_code_3"},
      ${columnMap.confirmation_text        ? 'confirmation_text'        : "'' AS confirmation_text"},
      ${columnMap.confirmation_long_text   ? 'confirmation_long_text'   : "'' AS confirmation_long_text"},
      ${columnMap.equipment                ? 'equipment'                : "'' AS equipment"}
    FROM v_analysis_scope
    ORDER BY work_order_number
  `);

  const woRecords: WORecord[] = rows.map(r => ({
    wo:        String(r.work_order_number      ?? '').trim(),
    symptom:   String(r.work_order_description ?? '').trim(),
    fm:        String(r.failure_mode           ?? '').trim(),
    cc:        String(r.cause_code             ?? '').trim(),
    rc1:       String(r.reliability_code_1     ?? '').trim(),
    rc2:       String(r.reliability_code_2     ?? '').trim(),
    rc3:       String(r.reliability_code_3     ?? '').trim(),
    conf:      String(r.confirmation_text      ?? '').trim(),
    conf_long: String(r.confirmation_long_text ?? '').trim(),
    equipment: String(r.equipment              ?? '').trim(),
  }));

  // ── 2. Reset DuckDB table ─────────────────────────────────────────────────
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

  // ── 4. Build summary ──────────────────────────────────────────────────────
  const byCategory: Record<FlagCategory, number> = {
    symptom_code_conflict:     0,
    symptom_closure_conflict:  0,
    code_closure_conflict:     0,
    incomplete_classification: 0,
    poor_closure:              0,
    generic_symptom:           0,
  };

  for (const f of allFlags) {
    if (f.category in byCategory) byCategory[f.category as FlagCategory]++;
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

async function _processBatch(batch: WORecord[], aiConfig: AIConfig): Promise<AIFlag[]> {
  // Build payload — field names match what the prompt describes
  const payload = batch.map(r => {
    const item: Record<string, string> = { wo: r.wo };
    if (r.symptom)   item.symptom   = r.symptom.slice(0, 300);
    if (r.fm)        item.fm        = r.fm;
    if (r.cc)        item.cc        = r.cc;
    if (r.rc1)       item.rc1       = r.rc1;
    if (r.rc2)       item.rc2       = r.rc2;
    if (r.rc3)       item.rc3       = r.rc3;
    if (r.conf)      item.conf      = r.conf.slice(0, 300);
    if (r.conf_long) item.conf_long = r.conf_long.slice(0, 600);
    return item;
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
    return [];
  }

  // Strip accidental markdown fences
  const cleaned = responseText.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

  let parsed: AIResponseItem[] = [];
  try {
    const raw = JSON.parse(cleaned);
    if (Array.isArray(raw)) parsed = raw;
  } catch {
    return [];
  }

  const VALID_CATEGORIES: FlagCategory[] = [
    'symptom_code_conflict',
    'symptom_closure_conflict',
    'code_closure_conflict',
    'incomplete_classification',
    'poor_closure',
    'generic_symptom',
  ];
  const VALID_SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;

  // Build WO lookup for snapshot population
  const lookup = new Map(batch.map(r => [r.wo, r]));

  const flags: AIFlag[] = [];
  for (const item of parsed) {
    if (!item.wo || !item.cat || !item.sev || !item.cmt) continue;
    if (!VALID_CATEGORIES.includes(item.cat as FlagCategory)) continue;
    if (!VALID_SEVERITIES.includes(item.sev as any)) continue;

    const src = lookup.get(item.wo);
    if (!src) continue;

    // Build formatted codes string for display
    const codeParts = [
      src.fm  ? `FM: ${src.fm}`   : null,
      src.cc  ? `Cause: ${src.cc}` : null,
      src.rc1 ? `RC1: ${src.rc1}` : null,
      src.rc2 ? `RC2: ${src.rc2}` : null,
      src.rc3 ? `RC3: ${src.rc3}` : null,
    ].filter(Boolean);

    flags.push({
      woNumber:  item.wo,
      category:  item.cat as FlagCategory,
      severity:  item.sev as AIFlag['severity'],
      comment:   String(item.cmt).slice(0, 160),
      symptom:   src.symptom,
      codes:     codeParts.length > 0 ? codeParts.join(' | ') : '— none assigned —',
      closure:   src.conf || src.conf_long.slice(0, 200) || '',
      equipment: src.equipment,
    });
  }

  return flags;
}
