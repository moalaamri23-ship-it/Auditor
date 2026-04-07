import * as duckdb from '@duckdb/duckdb-wasm';
import type {
  ColumnMap,
  DataProfile,
  ColumnProfile,
  GranularityLevel,
  CanonicalColumn,
} from '../types';
import {
  TIMESTAMP_COLUMNS,
  TEXT_COLUMNS,
  IDENTIFIER_COLUMNS,
  GRANULARITY,
  COLUMN_LABELS,
} from '../constants';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton DuckDB instance
// ─────────────────────────────────────────────────────────────────────────────

let _db:   duckdb.AsyncDuckDB | null = null;
let _conn: duckdb.AsyncDuckDBConnection | null = null;
let _initPromise: Promise<void> | null = null;

export async function initDuckDB(): Promise<void> {
  if (_conn) return;                       // already ready
  if (_initPromise) return _initPromise;   // init in progress

  _initPromise = (async () => {
    const { mvp } = duckdb.getJsDelivrBundles();

    // Pre-fetch the worker script in the main thread so the Blob worker
    // runs entirely same-origin with no cross-origin importScripts call.
    const workerScript = await fetch(mvp.mainWorker!).then(r => {
      if (!r.ok) throw new Error(`Failed to fetch DuckDB worker: ${r.status}`);
      return r.text();
    });
    const workerUrl = URL.createObjectURL(
      new Blob([workerScript], { type: 'text/javascript' })
    );
    const worker = new Worker(workerUrl);
    URL.revokeObjectURL(workerUrl);

    const logger = new duckdb.VoidLogger();
    _db = new duckdb.AsyncDuckDB(logger, worker);
    await _db.instantiate(mvp.mainModule);

    _conn = await _db.connect();
  })();

  return _initPromise;
}

export function isDuckDBReady(): boolean {
  return _conn !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remaps raw rows to canonical column names, loads into DuckDB, then
 * creates a typed `audit` table and the standard views.
 */
export async function loadData(
  rows: Record<string, string>[],
  columnMap: ColumnMap
): Promise<void> {
  if (!_conn || !_db) throw new Error('DuckDB is not initialised.');

  // 1. Remap rows: raw header names → canonical column names
  const remapped = rows.map((rawRow) => {
    const out: Record<string, string> = {};
    for (const [canonical, rawName] of Object.entries(columnMap)) {
      if (rawName && rawRow[rawName] !== undefined) {
        out[canonical] = rawRow[rawName] ?? '';
      }
    }
    return out;
  });

  // 2. Register JSON buffer with DuckDB
  const jsonBytes = new TextEncoder().encode(JSON.stringify(remapped));
  await _db.registerFileBuffer('audit_raw.json', jsonBytes);

  // 3. Create raw string table
  await _conn.query('DROP TABLE IF EXISTS audit_raw');
  await _conn.query(`
    CREATE TABLE audit_raw AS
    SELECT * FROM read_json_auto('audit_raw.json', ignore_errors=true)
  `);

  // 4. Create typed, derived table
  await _createTypedTable(columnMap);

  // 5. Create analysis views
  await _createViews(columnMap);
}

async function _createTypedTable(columnMap: ColumnMap): Promise<void> {
  const selects: string[] = [];

  for (const canonical of Object.keys(columnMap) as CanonicalColumn[]) {
    if (!columnMap[canonical]) continue;

    if (TIMESTAMP_COLUMNS.includes(canonical)) {
      selects.push(
        `TRY_CAST("${canonical}" AS DATE) AS ${canonical}`
      );
    } else {
      selects.push(
        `TRIM(CAST(COALESCE("${canonical}", '') AS VARCHAR)) AS ${canonical}`
      );
    }
  }

  // Add row-within-WO sequence for deduplication
  const hasWO = !!columnMap.work_order_number;
  if (hasWO) {
    selects.push(
      `ROW_NUMBER() OVER (PARTITION BY work_order_number ORDER BY ROWID) AS _row_seq`
    );
  } else {
    selects.push(`ROW_NUMBER() OVER () AS _row_seq`);
  }

  await _conn!.query('DROP TABLE IF EXISTS audit');
  await _conn!.query(`
    CREATE TABLE audit AS
    SELECT ${selects.join(',\n    ')}
    FROM audit_raw
  `);
}

async function _createViews(columnMap: ColumnMap): Promise<void> {
  const hasWO = !!columnMap.work_order_number;

  // v_wo_primary — one row per WO (safe for WO-level aggregations)
  await _conn!.query('DROP VIEW IF EXISTS v_wo_primary');
  if (hasWO) {
    await _conn!.query(`
      CREATE VIEW v_wo_primary AS
      SELECT * FROM audit WHERE _row_seq = 1
    `);
  } else {
    await _conn!.query(`
      CREATE VIEW v_wo_primary AS SELECT * FROM audit
    `);
  }

  // v_confirmations — rows that have confirmation text
  await _conn!.query('DROP VIEW IF EXISTS v_confirmations');
  if (columnMap.confirmation_text) {
    await _conn!.query(`
      CREATE VIEW v_confirmations AS
      SELECT * FROM audit
      WHERE confirmation_text IS NOT NULL
        AND LENGTH(TRIM(confirmation_text)) > 0
    `);
  } else {
    await _conn!.query(`
      CREATE VIEW v_confirmations AS SELECT * FROM audit WHERE false
    `);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data profiling
// ─────────────────────────────────────────────────────────────────────────────

export async function runProfiling(columnMap: ColumnMap): Promise<DataProfile> {
  if (!_conn) throw new Error('DuckDB is not initialised.');

  const hasWO    = !!columnMap.work_order_number;
  const hasNotif = !!columnMap.notification_number;
  const hasEq    = !!columnMap.equipment;
  const hasFL    = !!columnMap.functional_location;

  // Total rows
  const totalRows = Number((await _q('SELECT COUNT(*) AS cnt FROM audit'))[0]?.cnt ?? 0);

  // Distinct counts
  const dRows = await _q(`
    SELECT
      ${hasWO    ? 'COUNT(DISTINCT work_order_number)'   : '0'} AS d_wo,
      ${hasNotif ? 'COUNT(DISTINCT notification_number)' : '0'} AS d_notif,
      ${hasEq    ? 'COUNT(DISTINCT equipment)'           : '0'} AS d_eq,
      ${hasFL    ? 'COUNT(DISTINCT functional_location)' : '0'} AS d_fl
    FROM audit
  `);
  const dRow = dRows[0] ?? {};

  const distinctWOs                 = Number(dRow.d_wo    ?? 0);
  const distinctNotifications       = Number(dRow.d_notif ?? 0);
  const distinctEquipment           = Number(dRow.d_eq    ?? 0);
  const distinctFunctionalLocations = Number(dRow.d_fl    ?? 0);

  const rowsPerWO = distinctWOs > 0 ? totalRows / distinctWOs : 1;

  // Max rows per WO
  let maxRowsPerWO = 1;
  if (hasWO && distinctWOs > 0) {
    const mRows = await _q(`
      SELECT MAX(cnt) AS mx FROM (
        SELECT work_order_number, COUNT(*) AS cnt FROM audit GROUP BY 1
      )
    `);
    maxRowsPerWO = Number(mRows[0]?.mx ?? 1);
  }

  // Granularity classification
  let granularityLevel: GranularityLevel;
  if (rowsPerWO < GRANULARITY.WO_LEVEL_MAX)  granularityLevel = 'WO_LEVEL';
  else if (rowsPerWO < GRANULARITY.MIXED_MAX) granularityLevel = 'MIXED';
  else                                         granularityLevel = 'CONFIRMATION_LEVEL';

  // Date range — use first available date column
  let dateRange: DataProfile['dateRange'] = null;
  const dateCols = TIMESTAMP_COLUMNS.filter((c) => !!columnMap[c]);
  for (const col of dateCols) {
    try {
      const drRows = await _q(`
        SELECT
          MIN(${col})::VARCHAR AS mn,
          MAX(${col})::VARCHAR AS mx
        FROM audit
        WHERE ${col} IS NOT NULL
      `);
      const dr = drRows[0];
      if (dr?.mn && dr?.mx) {
        dateRange = { min: String(dr.mn), max: String(dr.mx) };
        break;
      }
    } catch { /* column may not exist */ }
  }

  // Column profiles
  const columnProfiles = await _buildColumnProfiles(columnMap);

  // Composite quality score
  const dataQualityScore = _computeQualityScore(columnProfiles, granularityLevel, hasWO);

  return {
    totalRows,
    distinctWOs,
    distinctNotifications,
    distinctEquipment,
    distinctFunctionalLocations,
    rowsPerWO:   Math.round(rowsPerWO * 10) / 10,
    maxRowsPerWO,
    granularityLevel,
    dateRange,
    columnProfiles,
    duplicateRowCount: 0, // computed separately in Phase 2
    dataQualityScore,
  };
}

async function _buildColumnProfiles(columnMap: ColumnMap): Promise<ColumnProfile[]> {
  // Invert columnMap to find raw→canonical
  const canonicalByRaw: Record<string, CanonicalColumn> = {};
  for (const [canonical, raw] of Object.entries(columnMap)) {
    if (raw) canonicalByRaw[raw] = canonical as CanonicalColumn;
  }

  const profiles: ColumnProfile[] = [];

  // Get all columns in the typed audit table
  const schemaRows = await _q('DESCRIBE audit');

  for (const schemaRow of schemaRows) {
    const colName = String((schemaRow as any).column_name ?? '');
    if (colName.startsWith('_')) continue; // skip internal columns

    try {
      const [countRow] = await _q(`
        SELECT
          COUNT(*) AS total,
          COUNT("${colName}") AS non_null,
          COUNT(DISTINCT "${colName}") AS distinct_count
        FROM audit
      `);
      const total       = Number((countRow as any)?.total        ?? 0);
      const nonNull     = Number((countRow as any)?.non_null     ?? 0);
      const distinctCnt = Number((countRow as any)?.distinct_count ?? 0);
      const nullCount   = total - nonNull;
      const nullPct     = total > 0 ? Math.round((nullCount / total) * 100) : 0;

      // Sample values (up to 3 distinct non-empty)
      const sampleRows = await _q(`
        SELECT DISTINCT CAST("${colName}" AS VARCHAR) AS val
        FROM audit
        WHERE "${colName}" IS NOT NULL
          AND TRIM(CAST("${colName}" AS VARCHAR)) <> ''
        LIMIT 3
      `);
      const sampleValues = sampleRows.map((r: any) => String(r.val ?? ''));

      // Detect type and mapping
      const isTimestamp = TIMESTAMP_COLUMNS.includes(colName as CanonicalColumn);
      const isText      = TEXT_COLUMNS.includes(colName as CanonicalColumn);
      const isId        = IDENTIFIER_COLUMNS.includes(colName as CanonicalColumn);

      let detectedType: ColumnProfile['detectedType'];
      if (isTimestamp)                                     detectedType = 'date';
      else if (isId)                                       detectedType = 'id';
      else if (isText)                                     detectedType = 'text';
      else if (sampleValues.some((v) => !isNaN(Number(v)))) detectedType = 'number';
      else                                                  detectedType = 'text';

      // Confidence: canonical columns that were mapped get HIGH, others UNMAPPED
      const mappingConfidence: ColumnProfile['mappingConfidence'] =
        colName in COLUMN_LABELS ? 'HIGH' : 'UNMAPPED';

      profiles.push({
        rawName:          colName,
        canonicalName:    colName as CanonicalColumn,
        detectedType,
        nullCount,
        nullPct,
        distinctCount:    distinctCnt,
        sampleValues,
        mappingConfidence,
      });
    } catch {
      // skip problematic columns silently
    }
  }

  return profiles;
}

function _computeQualityScore(
  profiles: ColumnProfile[],
  granularity: GranularityLevel,
  hasWO: boolean
): number {
  let score = 100;

  if (!hasWO) score -= 30;

  const criticalCols = ['work_order_number', 'actual_start_date', 'actual_finish_date', 'notification_date'];
  for (const col of criticalCols) {
    const p = profiles.find((pr) => pr.rawName === col);
    if (!p) continue;
    if (p.nullPct > 50)      score -= 15;
    else if (p.nullPct > 20) score -= 7;
    else if (p.nullPct > 5)  score -= 3;
  }

  // Heavy confirmation explosion is a data quality concern
  if (granularity === 'CONFIRMATION_LEVEL') score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic query helper
// Returns an array of plain JS objects (one per row).
// ─────────────────────────────────────────────────────────────────────────────

async function _q(sql: string): Promise<Record<string, unknown>[]> {
  if (!_conn) throw new Error('DuckDB is not initialised.');
  const result = await _conn.query(sql);
  return result.toArray().map((row: any) =>
    typeof row?.toJSON === 'function' ? (row.toJSON() as Record<string, unknown>) : ({ ...row } as Record<string, unknown>)
  );
}

/** Public generic query — returns array of plain objects */
export async function query(sql: string): Promise<Record<string, unknown>[]> {
  return _q(sql);
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter options — distinct values for each filterable column
// ─────────────────────────────────────────────────────────────────────────────

import type { FilterOptions, AnalysisFilters, AIFlag } from '../types';

export async function getFilterOptions(columnMap: ColumnMap): Promise<FilterOptions> {
  const distinct = async (col: string): Promise<string[]> => {
    if (!columnMap[col as keyof ColumnMap]) return [];
    try {
      const rows = await _q(`
        SELECT DISTINCT CAST(${col} AS VARCHAR) AS v
        FROM v_wo_primary
        WHERE ${col} IS NOT NULL AND TRIM(CAST(${col} AS VARCHAR)) <> ''
        ORDER BY v
        LIMIT 500
      `);
      return rows.map(r => String(r.v ?? ''));
    } catch { return []; }
  };

  const [equipment, functionalLocation, orderType, systemStatus] = await Promise.all([
    distinct('equipment'),
    distinct('functional_location'),
    distinct('order_type'),
    distinct('system_status'),
  ]);

  // Date range from actual_start_date or notification_date
  let dateMin: string | null = null;
  let dateMax: string | null = null;
  const dateCols = ['actual_start_date', 'notification_date', 'scheduled_start_date'];
  for (const col of dateCols) {
    if (!columnMap[col as keyof ColumnMap]) continue;
    try {
      const [row] = await _q(`
        SELECT MIN(${col})::VARCHAR AS mn, MAX(${col})::VARCHAR AS mx
        FROM v_wo_primary WHERE ${col} IS NOT NULL
      `);
      if (row?.mn && row?.mx) {
        dateMin = String(row.mn).slice(0, 10);
        dateMax = String(row.mx).slice(0, 10);
        break;
      }
    } catch { continue; }
  }

  return { equipment, functionalLocation, orderType, systemStatus, dateMin, dateMax };
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis scope view — applies filters on top of v_wo_primary
// ─────────────────────────────────────────────────────────────────────────────

export async function createAnalysisScopeView(
  filters: AnalysisFilters,
  columnMap: ColumnMap
): Promise<number> {
  if (!_conn) throw new Error('DuckDB is not initialised.');

  const conditions: string[] = [];
  const has = (col: string) => !!columnMap[col as keyof ColumnMap];

  // Date range — use actual_start_date if available, else notification_date
  const dateCol = has('actual_start_date') ? 'actual_start_date'
    : has('notification_date') ? 'notification_date' : null;

  if (dateCol) {
    if (filters.dateFrom) conditions.push(`${dateCol} >= '${filters.dateFrom}'::DATE`);
    if (filters.dateTo)   conditions.push(`${dateCol} <= '${filters.dateTo}'::DATE`);
  }

  const inList = (col: string, vals: string[]) => {
    if (!has(col) || vals.length === 0) return;
    const escaped = vals.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');
    conditions.push(`${col} IN (${escaped})`);
  };

  inList('equipment',          filters.equipment);
  inList('functional_location', filters.functionalLocation);
  inList('order_type',          filters.orderType);
  inList('system_status',       filters.systemStatus);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  await _conn.query(`
    CREATE OR REPLACE VIEW v_analysis_scope AS
    SELECT * FROM v_wo_primary ${where}
  `);

  const [row] = await _q('SELECT COUNT(*) AS cnt FROM v_analysis_scope');
  return Number(row?.cnt ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// AI flags table — per-record flags written during AI text analysis
// ─────────────────────────────────────────────────────────────────────────────

/** Create (or recreate) the ai_flags table */
export async function createAIFlagsTable(): Promise<void> {
  if (!_conn) throw new Error('DuckDB is not initialised.');
  await _conn.query(`
    CREATE OR REPLACE TABLE ai_flags (
      wo_number       VARCHAR,
      category        VARCHAR,
      severity        VARCHAR,
      comment         VARCHAR,
      description     VARCHAR,
      equipment       VARCHAR
    )
  `);
}

/** Insert a batch of flags into the ai_flags table */
export async function insertAIFlagsBatch(flags: AIFlag[]): Promise<void> {
  if (!_conn || flags.length === 0) return;
  const rows = flags.map(f =>
    `('${esc(f.woNumber)}','${esc(f.category)}','${esc(f.severity)}','${esc(f.comment)}','${esc(f.description ?? '')}','${esc(f.equipment ?? '')}')`
  ).join(',\n');
  await _conn.query(`
    INSERT INTO ai_flags (wo_number, category, severity, comment, description, equipment)
    VALUES ${rows}
  `);
}

/** Restore ai_flags table from persisted session data (called after re-upload) */
export async function restoreAIFlagsFromSession(flags: AIFlag[]): Promise<void> {
  await createAIFlagsTable();
  if (flags.length > 0) await insertAIFlagsBatch(flags);
}

/** Fetch AI-flagged WOs for a given category from DuckDB */
export async function queryAIFlags(category?: string): Promise<AIFlag[]> {
  const where = category ? `WHERE category = '${esc(category)}'` : '';
  const rows = await _q(`SELECT * FROM ai_flags ${where} ORDER BY severity DESC, wo_number`);
  return rows.map(r => ({
    woNumber:    String(r.wo_number   ?? ''),
    category:    String(r.category    ?? '') as AIFlag['category'],
    severity:    String(r.severity    ?? '') as AIFlag['severity'],
    comment:     String(r.comment     ?? ''),
    description: String(r.description ?? ''),
    equipment:   String(r.equipment   ?? ''),
  }));
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}
