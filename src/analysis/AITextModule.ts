import { query, createAIFlagsTable, insertAIFlagsBatch } from '../services/DuckDBService';
import { callAI } from '../services/AIService';
import type {
  ColumnMap, AIFlag, AIFlagSummary, FlagCategory, AIConfig,
} from '../types';

const BATCH_SIZE = 20;
const MAX_CATALOG_BRANCH_ROWS = 40; // cap per-WO catalog hint to keep prompts compact

// ─── Flag categories (must match types.ts FlagCategory union) ───────────────
const VALID_CATEGORIES: ReadonlySet<string> = new Set<FlagCategory>([
  'desc_code_conflict',
  'false_not_listed',
  'desc_confirmation_mismatch',
  'desc_code_confirmation_misalign',
  'generic_description',
  'generic_confirmation',
]);

const VALID_SEVERITIES = new Set(['HIGH', 'MEDIUM', 'LOW']);

// ─── System prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a SAP PM data quality auditor. You audit maintenance work order records for documentation alignment and reliability-coding discipline.

Each work order record has:
1. DESCRIPTION       — what the operator reported (work_order_description).
2. CODES             — the reliability classification: object_part, damage_code, cause_code (description form). The failure_catalog defines which codes are valid.
3. CATALOG_HINT      — for the equipment's failure catalog group, the valid (object_part → damage → cause) tuples. Use this to detect "False Not Listed".
4. CONFIRMATIONS     — array of confirmation entries, one per technician closure. Each entry has:
     row       — row sequence number (1-based)
     conf      — short confirmation text
     conf_long — detailed narrative (may be empty if the short text is sufficient)

Detect inconsistencies and classify them. Use these category ids verbatim:

- desc_code_conflict
   The DESCRIPTION clearly identifies a component or failure mode, but the CODES name something different (e.g. description says "bearing noise" but damage_code = "Plugged/Choked").
- false_not_listed
   CODES contain "Not Listed" / "Not Listed(Description Must Be Provided)" but DESCRIPTION or CONFIRMATION clearly imply a known catalog entry AND CATALOG_HINT contains a fitting tuple.
   Do NOT raise this flag merely because codes say "Not Listed" — bare "Not Listed" codes are already caught by rule-based checks.
   ONLY raise it when ALL of the following are true: (a) CATALOG_HINT is non-empty, (b) CATALOG_HINT contains a tuple that clearly matches the described failure, (c) DESCRIPTION or CONFIRMATION explicitly names or implies that specific component/failure mode.
   The "suggested" field MUST be populated with the best matching codes from CATALOG_HINT.
- desc_confirmation_mismatch
   DESCRIPTION asks for one thing but CONFIRMATION (or CONFIRMATION_LONG) reports a clearly different scope of work (e.g. description says "replace pump seal", confirmation says "painted enclosure").
   Do NOT flag if CONFIRMATION is empty or blank — empty confirmations are caught by rule-based checks.
- desc_code_confirmation_misalign
   All three of DESCRIPTION, CODES, CONFIRMATION contradict each other.
   Do NOT flag if CONFIRMATION is empty or blank — empty confirmations are caught by rule-based checks.
- generic_description
   DESCRIPTION is present but too vague to be useful for an auditor: "PM job", "Repair", "Maintenance", "Check equipment".
   Do NOT raise this flag if DESCRIPTION is empty or blank — empty descriptions are already caught by rule-based checks.
   Only flag when DESCRIPTION is PRESENT but conveys no specific information about what was requested.
- generic_confirmation
   CONFIRMATION provides no useful information beyond restating the description: "work done", "completed", "OK", or copy-pasted description.
   Do NOT raise this flag if CONFIRMATION is empty or blank — empty confirmations are already caught by rule-based checks.
   Before raising this flag, check CONFIRMATION_LONG — if CONFIRMATION_LONG provides sufficient detail or clear resolution of the work performed, do NOT raise generic_confirmation.
   Only flag when BOTH CONFIRMATION and CONFIRMATION_LONG are PRESENT but vague or uninformative.

RULES:
- One WO can have multiple flags from different categories.
- Only flag real issues. Records that look correct → return nothing for that WO.
- Be specific in the comment: quote actual words from the text.
- Keep the comment under 150 characters.
- For false_not_listed: if CATALOG_HINT is empty, do NOT raise this flag — there is no reference to compare against.
- For desc_confirmation_mismatch and desc_code_confirmation_misalign: evaluate each confirmation row independently — include "row" in the output to identify which confirmation entry is problematic.
- For generic_confirmation: evaluate each confirmation row independently — include "row" to identify which row is vague. Only flag if BOTH conf and conf_long of that row are vague or uninformative.
- CRITICAL: Do NOT raise any flag solely because a field is empty/blank or contains "Not Listed". Rule-based pre-checks already handle those patterns. Your role is exclusively to detect quality issues in POPULATED fields — text that is present but misleading, vague, or inconsistent.
- Return ONLY a JSON array — no prose, no markdown fences. If nothing is wrong return [].

OUTPUT FORMAT — each item:
{"wo": "WO_NUMBER", "cat": "category_id", "sev": "HIGH|MEDIUM|LOW", "cmt": "specific comment quoting actual text"}

For flags specific to one confirmation row (generic_confirmation, desc_confirmation_mismatch, desc_code_confirmation_misalign), add "row": <row_number>:
{"wo": "WO_NUMBER", "row": 2, "cat": "generic_confirmation", "sev": "MEDIUM", "cmt": "Row 2 conf says only 'done'"}

For WO-level flags (desc_code_conflict, false_not_listed, generic_description) omit "row" entirely.

The "suggested" object is REQUIRED only when cat = "false_not_listed", and the values MUST come from CATALOG_HINT for that WO. Omit the field for other categories.

SEVERITY GUIDE:
- HIGH: clear, direct contradiction, or completely missing classification despite a specific description
- MEDIUM: partial mismatch, ambiguous alignment, or confirmation that adds no information
- LOW: minor inconsistency, possible but uncertain mismatch, or borderline-generic text`;

// ─── WO record sent to AI ───────────────────────────────────────────────────
interface WORecord {
  wo: string;
  description: string;
  catalog: string;
  part: string;
  damage: string;
  cause: string;
  equipment: string;
  catalog_hint: Array<{ part: string; damage: string; cause: string }>;
  confirmations: Array<{ row: number; conf: string; conf_long: string; operationDesc: string }>;
}

// ─── AI response item ───────────────────────────────────────────────────────
interface AIResponseItem {
  wo: string;
  row?: number;
  cat: string;
  sev: string;
  cmt: string;
  suggested?: { part?: string; damage?: string; cause?: string };
}

// ─── Options ────────────────────────────────────────────────────────────────
export interface AITextModuleOptions {
  runId: string;
  columnMap: ColumnMap;
  aiConfig: AIConfig;
  catalogAvailable: boolean;
  scopeWOCount: number;
  onProgress: (processed: number, total: number) => void;
  cancelRef: { current: boolean };
}

export async function runAITextModule(opts: AITextModuleOptions): Promise<AIFlagSummary> {
  const { columnMap, aiConfig, scopeWOCount, onProgress, cancelRef, catalogAvailable } = opts;

  // 1. Build WO record set — all rows from audit for WOs in v_analysis_scope
  const records = await _fetchWORecords(columnMap, catalogAvailable);

  // 2. Reset DB flags table
  await createAIFlagsTable();

  if (records.length === 0) {
    return {
      totalFlagged: 0,
      totalFlags: 0,
      byCategory: {},
      generatedAt: new Date().toISOString(),
      scopeWOCount,
    };
  }

  // 3. Process in batches
  const allFlags: AIFlag[] = [];
  let processed = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    if (cancelRef.current) break;
    const batch = records.slice(i, i + BATCH_SIZE);
    try {
      const batchFlags = await _processBatch(batch, aiConfig);
      if (batchFlags.length > 0) {
        await insertAIFlagsBatch(batchFlags);
        allFlags.push(...batchFlags);
      }
    } catch (err) {
      console.warn('AI batch failed', err);
    }
    processed += batch.length;
    onProgress(processed, records.length);
  }

  // 4. Aggregate summary
  const byCategory: Partial<Record<FlagCategory, number>> = {};
  const flaggedWOs = new Set<string>();
  for (const f of allFlags) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    flaggedWOs.add(f.woNumber);
  }

  return {
    totalFlagged: flaggedWOs.size,
    totalFlags: allFlags.length,
    byCategory,
    generatedAt: new Date().toISOString(),
    scopeWOCount,
  };
}

// ─── Fetch WO records — all rows from audit, grouped by WO ────────────────
async function _fetchWORecords(
  columnMap: ColumnMap,
  catalogAvailable: boolean,
): Promise<WORecord[]> {
  if (!columnMap.work_order_number) return [];

  const has = (k: keyof ColumnMap) => !!columnMap[k];

  const select = (col: keyof ColumnMap, alias: string) =>
    has(col) ? `CAST(${col} AS VARCHAR) AS ${alias}` : `'' AS ${alias}`;

  // Fetch all confirmation rows for WOs in scope, ordered by _row_seq
  const rows = await query(`
    SELECT
      CAST(work_order_number AS VARCHAR) AS wo,
      _row_seq AS row_seq,
      ${select('work_order_description', 'description')},
      ${select('failure_catalog_desc', 'catalog')},
      ${select('object_part_code_description', 'part')},
      ${select('damage_code_description', 'damage')},
      ${select('cause_code_description', 'cause')},
      ${select('confirmation_text', 'conf')},
      ${select('confirmation_long_text', 'conf_long')},
      ${select('equipment_description', 'equipment')},
      ${select('operation_description', 'operation_desc')}
    FROM audit
    WHERE work_order_number IN (SELECT work_order_number FROM v_analysis_scope)
    ORDER BY work_order_number, _row_seq
  `);

  // Build per-catalog hint map (for false_not_listed). Only when catalog table exists
  // AND audit has failure_catalog_desc mapped.
  const hintByCatalog: Record<string, Array<{ part: string; damage: string; cause: string }>> = {};
  if (catalogAvailable && has('failure_catalog_desc')) {
    try {
      const distinctCatalogs = Array.from(
        new Set(rows.map((r) => String(r.catalog ?? '')).filter((c) => c)),
      );
      for (const cat of distinctCatalogs) {
        const cRows = await query(`
          SELECT object_part_code_description AS part,
                 damage_code_description     AS damage,
                 cause_code_description      AS cause
          FROM failure_catalog
          WHERE failure_catalog_desc = '${cat.replace(/'/g, "''")}'
          LIMIT ${MAX_CATALOG_BRANCH_ROWS}
        `);
        hintByCatalog[cat] = cRows.map((r) => ({
          part: String(r.part ?? ''),
          damage: String(r.damage ?? ''),
          cause: String(r.cause ?? ''),
        }));
      }
    } catch (err) {
      console.warn('Catalog hint lookup failed', err);
    }
  }

  // Group rows by WO number — one WORecord per WO with all confirmation rows
  const woMap = new Map<string, WORecord>();
  for (const r of rows) {
    const wo = String(r.wo ?? '');
    if (!wo) continue;
    if (!woMap.has(wo)) {
      const catalog = String(r.catalog ?? '');
      woMap.set(wo, {
        wo,
        description: String(r.description ?? ''),
        catalog,
        part: String(r.part ?? ''),
        damage: String(r.damage ?? ''),
        cause: String(r.cause ?? ''),
        equipment: String(r.equipment ?? ''),
        catalog_hint: hintByCatalog[catalog] ?? [],
        confirmations: [],
      });
    }
    woMap.get(wo)!.confirmations.push({
      row: Number(r.row_seq ?? 1),
      conf: String(r.conf ?? ''),
      conf_long: String(r.conf_long ?? ''),
      operationDesc: String(r.operation_desc ?? ''),
    });
  }

  return Array.from(woMap.values());
}

async function _processBatch(records: WORecord[], aiConfig: AIConfig): Promise<AIFlag[]> {
  const userPrompt =
    'Audit these work orders. Return JSON array only.\n\n' +
    JSON.stringify(records, null, 2);

  const raw = await callAI(
    aiConfig.provider,
    aiConfig.apiKey,
    aiConfig.modelId,
    [{ role: 'user', content: userPrompt }],
    SYSTEM_PROMPT,
    '',
    aiConfig.powerAutomateUrl ?? '',
  );

  const parsed = _parseJsonArray(raw);
  if (!Array.isArray(parsed)) return [];

  const recordByWO = new Map(records.map((r) => [r.wo, r]));
  const flags: AIFlag[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const ai = item as AIResponseItem;
    const wo = String(ai.wo ?? '').trim();
    const cat = String(ai.cat ?? '').trim();
    const sev = String(ai.sev ?? '').trim().toUpperCase();
    if (!wo || !VALID_CATEGORIES.has(cat) || !VALID_SEVERITIES.has(sev)) continue;
    const rec = recordByWO.get(wo);
    if (!rec) continue;

    const codes =
      rec.part || rec.damage || rec.cause
        ? `Part: ${rec.part || '—'} | Damage: ${rec.damage || '—'} | Cause: ${rec.cause || '—'}`
        : '';
    const rowSeq = typeof ai.row === 'number' ? ai.row : undefined;
    const confEntry = rowSeq != null
      ? (rec.confirmations.find((c) => c.row === rowSeq) ?? rec.confirmations[0])
      : rec.confirmations[0];
    const closure = confEntry ? (confEntry.conf || confEntry.conf_long || '') : '';

    const opDesc = confEntry?.operationDesc?.trim() || undefined;
    const flag: AIFlag = {
      woNumber: wo,
      rowSeq,
      category: cat as FlagCategory,
      severity: sev as AIFlag['severity'],
      comment: String(ai.cmt ?? '').slice(0, 300),
      description: rec.description.slice(0, 500),
      codes,
      closure: closure.slice(0, 500),
      equipment: rec.equipment,
      operationDesc: opDesc,
    };

    if (cat === 'false_not_listed' && ai.suggested) {
      const part = String(ai.suggested.part ?? '').trim();
      const damage = String(ai.suggested.damage ?? '').trim();
      const cause = String(ai.suggested.cause ?? '').trim();
      if (part || damage || cause) {
        flag.suggested = { object_part: part, damage, cause };
      }
    }

    flags.push(flag);
  }

  return flags;
}

function _parseJsonArray(s: string): unknown[] | null {
  if (!s) return null;
  // Strip code fences if the model added them
  const cleaned = s
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  // Find first '[' to last ']'
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export const FLAG_CATEGORY_LABELS: Record<FlagCategory, string> = {
  desc_code_conflict: 'Desc — Code Conflict',
  false_not_listed: 'False Not Listed',
  desc_confirmation_mismatch: 'Desc — Confirmation Mismatch',
  desc_code_confirmation_misalign: 'Desc — Code — Confirmation Misalignment',
  generic_description: 'Generic Description',
  generic_confirmation: 'Generic Confirmation',
};
