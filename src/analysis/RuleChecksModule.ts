import { query } from '../services/DuckDBService';
import type { ColumnMap, RuleCheckId, RuleCheckResult, RuleCheckBucket } from '../types';

interface RuleCheckOptions {
  columnMap: ColumnMap;
  /** Whether the failure_catalog table is loaded — if not, catalog checks are skipped. */
  catalogAvailable: boolean;
}

/**
 * Pre-AI rule-based audit. All checks run as DuckDB SQL against `v_analysis_scope`.
 * Returns counts + sample WO numbers per check, plus a per-WO breakdown so the
 * AI module can scope itself to only the flagged subset.
 */
export async function runRuleChecks(opts: RuleCheckOptions): Promise<RuleCheckResult> {
  const { columnMap, catalogAvailable } = opts;
  const has = (k: keyof ColumnMap) => !!columnMap[k];

  const totalRow = await query(`SELECT COUNT(*) AS cnt FROM v_analysis_scope`);
  const totalWOs = Number(totalRow[0]?.cnt ?? 0);

  const perCheck: Partial<Record<RuleCheckId, RuleCheckBucket>> = {};
  const flaggedMap = new Map<string, Set<RuleCheckId>>();

  const recordFlag = (wo: string, check: RuleCheckId) => {
    if (!wo) return;
    let s = flaggedMap.get(wo);
    if (!s) {
      s = new Set();
      flaggedMap.set(wo, s);
    }
    s.add(check);
  };

  const runCheck = async (
    id: RuleCheckId,
    woExpr: string,
    whereClause: string,
  ): Promise<void> => {
    try {
      const rows = await query(`
        SELECT ${woExpr} AS wo
        FROM v_analysis_scope
        WHERE ${whereClause}
      `);
      const woList: string[] = [];
      for (const r of rows) {
        const wo = String(r.wo ?? '');
        if (wo) woList.push(wo);
      }
      if (woList.length === 0) {
        perCheck[id] = { matched: 0, sampleWOs: [] };
        return;
      }
      perCheck[id] = {
        matched: woList.length,
        sampleWOs: woList.slice(0, 5),
      };
      for (const wo of woList) recordFlag(wo, id);
    } catch (err) {
      console.warn(`Rule check ${id} failed`, err);
      perCheck[id] = { matched: 0, sampleWOs: [] };
    }
  };

  const woCol = has('work_order_number') ? 'work_order_number' : `'?'`;

  // 1. Missing confirmation — flag WOs where ANY row has no confirmation text
  if (has('confirmation_text') || has('confirmation_long_text')) {
    const shortBlank = has('confirmation_text')
      ? `(confirmation_text IS NULL OR TRIM(CAST(confirmation_text AS VARCHAR)) = '')`
      : `TRUE`;
    const longBlank = has('confirmation_long_text')
      ? `(confirmation_long_text IS NULL OR TRIM(CAST(confirmation_long_text AS VARCHAR)) = '')`
      : `TRUE`;
    try {
      const mcRows = await query(`
        SELECT DISTINCT CAST(${woCol} AS VARCHAR) AS wo
        FROM audit
        WHERE work_order_number IN (SELECT work_order_number FROM v_analysis_scope)
          AND ${shortBlank} AND ${longBlank}
      `);
      const mcWOs = mcRows.map((r) => String(r.wo ?? '')).filter(Boolean);
      perCheck['missing_confirmation'] = { matched: mcWOs.length, sampleWOs: mcWOs.slice(0, 5) };
      for (const wo of mcWOs) recordFlag(wo, 'missing_confirmation');
    } catch (err) {
      console.warn('Rule check missing_confirmation failed', err);
      perCheck['missing_confirmation'] = { matched: 0, sampleWOs: [] };
    }
  } else {
    perCheck['missing_confirmation'] = { matched: 0, sampleWOs: [] };
  }

  // 2. Not Listed codes — only meaningful when a failure catalog is loaded so the AI can
  //    suggest correct codes. Without catalog data there is no reference to compare against.
  if (catalogAvailable) {
    const notListedExpr = (col: string) =>
      `(${col} IS NOT NULL AND UPPER(TRIM(${col})) LIKE 'NOT LISTED%')`;
    const notListedConditions: string[] = [];
    if (has('object_part_code_description')) notListedConditions.push(notListedExpr('object_part_code_description'));
    if (has('damage_code_description')) notListedConditions.push(notListedExpr('damage_code_description'));
    if (has('cause_code_description')) notListedConditions.push(notListedExpr('cause_code_description'));
    if (notListedConditions.length > 0) {
      await runCheck('not_listed_codes', woCol, notListedConditions.join(' OR '));
    } else {
      perCheck['not_listed_codes'] = { matched: 0, sampleWOs: [] };
    }
  } else {
    perCheck['not_listed_codes'] = { matched: 0, sampleWOs: [] };
  }

  // 3. Missing scoping text (code_group blank)
  if (has('code_group')) {
    await runCheck(
      'missing_scoping_text',
      woCol,
      `(code_group IS NULL OR TRIM(code_group) = '')`,
    );
  }

  // 4. Catalog hierarchy validity (4 sub-checks)
  if (catalogAvailable && has('failure_catalog_desc')) {
    if (has('object_part_code_description')) {
      await runCheck(
        'catalog_invalid_object_part',
        woCol,
        `failure_catalog_desc IS NOT NULL AND TRIM(failure_catalog_desc) <> ''
          AND object_part_code_description IS NOT NULL AND TRIM(object_part_code_description) <> ''
          AND UPPER(TRIM(object_part_code_description)) NOT LIKE 'NOT LISTED%'
          AND NOT EXISTS (
            SELECT 1 FROM v_catalog_object_parts c
            WHERE c.failure_catalog_desc = v_analysis_scope.failure_catalog_desc
              AND c.object_part_code_description = v_analysis_scope.object_part_code_description
          )`,
      );
    }
    if (has('object_part_code_description') && has('damage_code_description')) {
      await runCheck(
        'catalog_invalid_damage_for_part',
        woCol,
        `failure_catalog_desc IS NOT NULL AND TRIM(failure_catalog_desc) <> ''
          AND object_part_code_description IS NOT NULL AND TRIM(object_part_code_description) <> ''
          AND damage_code_description IS NOT NULL AND TRIM(damage_code_description) <> ''
          AND UPPER(TRIM(damage_code_description)) NOT LIKE 'NOT LISTED%'
          AND NOT EXISTS (
            SELECT 1 FROM v_catalog_damage_for_part c
            WHERE c.failure_catalog_desc = v_analysis_scope.failure_catalog_desc
              AND c.object_part_code_description = v_analysis_scope.object_part_code_description
              AND c.damage_code_description = v_analysis_scope.damage_code_description
          )`,
      );
    }
    if (
      has('object_part_code_description') &&
      has('damage_code_description') &&
      has('cause_code_description')
    ) {
      await runCheck(
        'catalog_invalid_cause_for_damage',
        woCol,
        `failure_catalog_desc IS NOT NULL AND TRIM(failure_catalog_desc) <> ''
          AND object_part_code_description IS NOT NULL AND TRIM(object_part_code_description) <> ''
          AND damage_code_description IS NOT NULL AND TRIM(damage_code_description) <> ''
          AND cause_code_description IS NOT NULL AND TRIM(cause_code_description) <> ''
          AND UPPER(TRIM(cause_code_description)) NOT LIKE 'NOT LISTED%'
          AND NOT EXISTS (
            SELECT 1 FROM v_catalog_cause_for_damage c
            WHERE c.failure_catalog_desc = v_analysis_scope.failure_catalog_desc
              AND c.object_part_code_description = v_analysis_scope.object_part_code_description
              AND c.damage_code_description = v_analysis_scope.damage_code_description
              AND c.cause_code_description = v_analysis_scope.cause_code_description
          )`,
      );
    }

    // Missing match — any of the 4 fields blank or null
    const blankExpr = (col: string) =>
      has(col as keyof ColumnMap)
        ? `(${col} IS NULL OR TRIM(${col}) = '')`
        : `TRUE`;
    const missingConds: string[] = [];
    if (has('failure_catalog_desc')) missingConds.push(blankExpr('failure_catalog_desc'));
    if (has('object_part_code_description')) missingConds.push(blankExpr('object_part_code_description'));
    if (has('damage_code_description')) missingConds.push(blankExpr('damage_code_description'));
    if (has('cause_code_description')) missingConds.push(blankExpr('cause_code_description'));
    if (missingConds.length > 0) {
      await runCheck('catalog_missing_match', woCol, missingConds.join(' OR '));
    }
  }

  const flaggedWOs = Array.from(flaggedMap.entries()).map(([wo, set]) => ({
    wo,
    checks: Array.from(set),
  }));

  return {
    generatedAt: new Date().toISOString(),
    totalWOs,
    perCheck,
    flaggedWOs,
  };
}

export const RULE_CHECK_LABELS: Record<RuleCheckId, { label: string; severity: 'HIGH' | 'MEDIUM' | 'INFO'; description: string }> = {
  missing_confirmation: {
    label: 'Missing Confirmation',
    severity: 'HIGH',
    description: 'Work orders with no confirmation text — neither short nor long.',
  },
  not_listed_codes: {
    label: '"Not Listed" Codes',
    severity: 'MEDIUM',
    description: 'Object/Damage/Cause description set to "Not Listed" — incomplete coding.',
  },
  missing_scoping_text: {
    label: 'Missing Scoping Text',
    severity: 'MEDIUM',
    description: 'Description was written ad-hoc (no Code Group / scoping template selected).',
  },
  catalog_invalid_object_part: {
    label: 'Invalid Object Part',
    severity: 'HIGH',
    description: 'Object part is not listed under this Failure Catalog branch.',
  },
  catalog_invalid_damage_for_part: {
    label: 'Invalid Damage for Part',
    severity: 'HIGH',
    description: 'Damage code is valid in catalog but not under this object part.',
  },
  catalog_invalid_cause_for_damage: {
    label: 'Invalid Cause for Damage',
    severity: 'HIGH',
    description: 'Cause code is valid in catalog but not under this damage code.',
  },
  catalog_missing_match: {
    label: 'Missing Catalog Fields',
    severity: 'MEDIUM',
    description: 'One or more catalog fields (Failure Catalog / Part / Damage / Cause) is blank.',
  },
};
