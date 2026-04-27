import * as duckdb from '@duckdb/duckdb-wasm';
import type {
  ColumnMap,
  DataProfile,
  ColumnProfile,
  GranularityLevel,
  CanonicalColumn,
  FilterOptions,
  AnalysisFilters,
  AIFlag,
  FailureCatalogEntry,
  AuditProject,
} from '../types';
import {
  TIMESTAMP_COLUMNS,
  TEXT_COLUMNS,
  IDENTIFIER_COLUMNS,
  GRANULARITY,
  COLUMN_LABELS,
} from '../constants';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton DuckDB instance (referred to as "Database" in the UI)
// ─────────────────────────────────────────────────────────────────────────────

let _db: duckdb.AsyncDuckDB | null = null;
let _conn: duckdb.AsyncDuckDBConnection | null = null;
let _initPromise: Promise<void> | null = null;

export async function initDB(): Promise<void> {
  if (_conn) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);

    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.VoidLogger();
    _db = new duckdb.AsyncDuckDB(logger, worker);
    await _db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    _conn = await _db.connect();
  })();

  return _initPromise;
}

/** Back-compat alias (some callers still import initDuckDB). */
export const initDuckDB = initDB;

export function isDBReady(): boolean {
  return _conn !== null;
}

export const isDuckDBReady = isDBReady;

// ─────────────────────────────────────────────────────────────────────────────
// Audit data load
// ─────────────────────────────────────────────────────────────────────────────

export async function loadData(
  rows: Record<string, string>[],
  columnMap: ColumnMap
): Promise<void> {
  if (!_conn || !_db) throw new Error('Database is not initialised.');

  const remapped = rows.map((rawRow) => {
    const out: Record<string, string> = {};
    for (const [canonical, rawName] of Object.entries(columnMap)) {
      if (rawName && rawRow[rawName] !== undefined) {
        out[canonical] = rawRow[rawName] ?? '';
      }
    }
    return out;
  });

  const jsonBytes = new TextEncoder().encode(JSON.stringify(remapped));
  await _db.registerFileBuffer('audit_raw.json', jsonBytes);

  await _conn.query('DROP TABLE IF EXISTS audit_raw');
  await _conn.query(`
    CREATE TABLE audit_raw AS
    SELECT * FROM read_json_auto('audit_raw.json', ignore_errors=true)
  `);

  await _createTypedTable(columnMap);
  await _createViews(columnMap);
}

async function _createTypedTable(columnMap: ColumnMap): Promise<void> {
  const selects: string[] = [];

  for (const canonical of Object.keys(columnMap) as CanonicalColumn[]) {
    if (!columnMap[canonical]) continue;

    if (TIMESTAMP_COLUMNS.includes(canonical)) {
      // Try ISO, US (M/D/YYYY), European (D/M/YYYY), dot (D.M.YYYY), and Excel serial numbers
      selects.push(`COALESCE(
        TRY_CAST("${canonical}" AS DATE),
        TRY_STRPTIME(TRIM("${canonical}"::VARCHAR), '%m/%d/%Y'),
        TRY_STRPTIME(TRIM("${canonical}"::VARCHAR), '%d/%m/%Y'),
        TRY_STRPTIME(TRIM("${canonical}"::VARCHAR), '%d.%m.%Y'),
        TRY_STRPTIME(TRIM("${canonical}"::VARCHAR), '%Y/%m/%d'),
        CASE WHEN regexp_matches("${canonical}"::VARCHAR, '^\\d{4,5}$')
          THEN (DATE '1899-12-30' + CAST("${canonical}"::VARCHAR AS INTEGER) * INTERVAL '1 day')::DATE
        END
      ) AS ${canonical}`);
    } else {
      selects.push(`TRIM(CAST(COALESCE("${canonical}", '') AS VARCHAR)) AS ${canonical}`);
    }
  }

  const hasWO = !!columnMap.work_order_number;
  selects.push(
    hasWO
      ? `ROW_NUMBER() OVER (PARTITION BY work_order_number ORDER BY ROWID) AS _row_seq`
      : `ROW_NUMBER() OVER () AS _row_seq`
  );

  await _conn!.query('DROP TABLE IF EXISTS audit');
  await _conn!.query(`
    CREATE TABLE audit AS
    SELECT ${selects.join(',\n    ')}
    FROM audit_raw
  `);
}

async function _createViews(columnMap: ColumnMap): Promise<void> {
  const hasWO = !!columnMap.work_order_number;

  await _conn!.query('DROP VIEW IF EXISTS v_wo_primary');
  await _conn!.query(
    hasWO
      ? `CREATE VIEW v_wo_primary AS SELECT * FROM audit WHERE _row_seq = 1`
      : `CREATE VIEW v_wo_primary AS SELECT * FROM audit`
  );

  await _conn!.query('DROP VIEW IF EXISTS v_confirmations');
  if (columnMap.confirmation_text) {
    await _conn!.query(`
      CREATE VIEW v_confirmations AS
      SELECT * FROM audit
      WHERE confirmation_text IS NOT NULL
        AND LENGTH(TRIM(confirmation_text)) > 0
    `);
  } else {
    await _conn!.query(`CREATE VIEW v_confirmations AS SELECT * FROM audit WHERE false`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure Catalog tables + views
// ─────────────────────────────────────────────────────────────────────────────

export async function loadFailureCatalog(rows: FailureCatalogEntry[]): Promise<void> {
  if (!_conn || !_db) throw new Error('Database is not initialised.');

  const jsonBytes = new TextEncoder().encode(JSON.stringify(rows));
  await _db.registerFileBuffer('failure_catalog.json', jsonBytes);

  await _conn.query('DROP TABLE IF EXISTS failure_catalog_raw');
  await _conn.query(`
    CREATE TABLE failure_catalog_raw AS
    SELECT * FROM read_json_auto('failure_catalog.json', ignore_errors=true)
  `);

  await _conn.query('DROP TABLE IF EXISTS failure_catalog');
  await _conn.query(`
    CREATE TABLE failure_catalog AS
    SELECT DISTINCT
      TRIM(CAST(failure_catalog_desc          AS VARCHAR)) AS failure_catalog_desc,
      TRIM(CAST(object_part_code_description  AS VARCHAR)) AS object_part_code_description,
      TRIM(CAST(damage_code_description       AS VARCHAR)) AS damage_code_description,
      TRIM(CAST(cause_code_description        AS VARCHAR)) AS cause_code_description
    FROM failure_catalog_raw
    WHERE failure_catalog_desc IS NOT NULL
      AND object_part_code_description IS NOT NULL
      AND damage_code_description IS NOT NULL
      AND cause_code_description IS NOT NULL
  `);

  await _conn.query('DROP VIEW IF EXISTS v_catalog_object_parts');
  await _conn.query(`
    CREATE VIEW v_catalog_object_parts AS
    SELECT DISTINCT failure_catalog_desc, object_part_code_description
    FROM failure_catalog
  `);

  await _conn.query('DROP VIEW IF EXISTS v_catalog_damage_for_part');
  await _conn.query(`
    CREATE VIEW v_catalog_damage_for_part AS
    SELECT DISTINCT failure_catalog_desc, object_part_code_description, damage_code_description
    FROM failure_catalog
  `);

  await _conn.query('DROP VIEW IF EXISTS v_catalog_cause_for_damage');
  await _conn.query(`
    CREATE VIEW v_catalog_cause_for_damage AS
    SELECT DISTINCT failure_catalog_desc, object_part_code_description,
                    damage_code_description, cause_code_description
    FROM failure_catalog
  `);
}

export async function failureCatalogStats(): Promise<{
  total: number;
  catalogs: number;
  parts: number;
} | null> {
  if (!_conn) return null;
  try {
    const [row] = await _q(`
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT failure_catalog_desc) AS catalogs,
        COUNT(DISTINCT failure_catalog_desc || '|' || object_part_code_description) AS parts
      FROM failure_catalog
    `);
    return {
      total: Number(row?.total ?? 0),
      catalogs: Number(row?.catalogs ?? 0),
      parts: Number(row?.parts ?? 0),
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profiling
// ─────────────────────────────────────────────────────────────────────────────

export async function runProfiling(columnMap: ColumnMap): Promise<DataProfile> {
  if (!_conn) throw new Error('Database is not initialised.');

  const hasWO = !!columnMap.work_order_number;
  const hasEq = !!columnMap.equipment;
  const hasFL = !!columnMap.functional_location;
  const hasCG = !!columnMap.code_group;
  const hasFC = !!columnMap.failure_catalog_desc;

  const totalRows = Number((await _q('SELECT COUNT(*) AS cnt FROM audit'))[0]?.cnt ?? 0);

  const dRows = await _q(`
    SELECT
      ${hasWO ? 'COUNT(DISTINCT work_order_number)' : '0'} AS d_wo,
      ${hasEq ? 'COUNT(DISTINCT equipment)' : '0'} AS d_eq,
      ${hasFL ? 'COUNT(DISTINCT functional_location)' : '0'} AS d_fl
    FROM audit
  `);
  const dRow = dRows[0] ?? {};
  const distinctWOs = Number(dRow.d_wo ?? 0);
  const distinctEquipment = Number(dRow.d_eq ?? 0);
  const distinctFunctionalLocations = Number(dRow.d_fl ?? 0);

  const rowsPerWO = distinctWOs > 0 ? totalRows / distinctWOs : 1;

  let maxRowsPerWO = 1;
  if (hasWO && distinctWOs > 0) {
    const mRows = await _q(`
      SELECT MAX(cnt) AS mx FROM (
        SELECT work_order_number, COUNT(*) AS cnt FROM audit GROUP BY 1
      )
    `);
    maxRowsPerWO = Number(mRows[0]?.mx ?? 1);
  }

  let granularityLevel: GranularityLevel;
  if (rowsPerWO < GRANULARITY.WO_LEVEL_MAX) granularityLevel = 'WO_LEVEL';
  else if (rowsPerWO < GRANULARITY.MIXED_MAX) granularityLevel = 'MIXED';
  else granularityLevel = 'CONFIRMATION_LEVEL';

  let dateRange: DataProfile['dateRange'] = null;
  const dateCols = TIMESTAMP_COLUMNS.filter((c) => !!columnMap[c]);
  for (const col of dateCols) {
    try {
      const drRows = await _q(`
        SELECT MIN(${col})::VARCHAR AS mn, MAX(${col})::VARCHAR AS mx
        FROM audit WHERE ${col} IS NOT NULL
      `);
      const dr = drRows[0];
      if (dr?.mn && dr?.mx) {
        dateRange = { min: String(dr.mn), max: String(dr.mx) };
        break;
      }
    } catch { /* column may not exist */ }
  }

  const columnProfiles = await _buildColumnProfiles(columnMap);
  const dataQualityScore = _computeQualityScore(columnProfiles, granularityLevel, hasWO);

  // Failure catalog match rate (only meaningful if both audit and catalog have failure_catalog_desc)
  let failureCatalogMatchRate = 0;
  if (hasFC) {
    try {
      const [m] = await _q(`
        WITH src AS (
          SELECT DISTINCT failure_catalog_desc FROM v_wo_primary
          WHERE failure_catalog_desc IS NOT NULL AND TRIM(failure_catalog_desc) <> ''
        ),
        matched AS (
          SELECT s.failure_catalog_desc
          FROM src s
          INNER JOIN (SELECT DISTINCT failure_catalog_desc FROM failure_catalog) c
            ON s.failure_catalog_desc = c.failure_catalog_desc
        )
        SELECT
          (SELECT COUNT(*) FROM matched) AS matched,
          (SELECT COUNT(*) FROM src)     AS total
      `);
      const matched = Number(m?.matched ?? 0);
      const total = Number(m?.total ?? 0);
      failureCatalogMatchRate = total > 0 ? matched / total : 0;
    } catch {
      failureCatalogMatchRate = 0;
    }
  }

  return {
    totalRows,
    distinctWOs,
    distinctEquipment,
    distinctFunctionalLocations,
    rowsPerWO: Math.round(rowsPerWO * 10) / 10,
    maxRowsPerWO,
    granularityLevel,
    dateRange,
    columnProfiles,
    duplicateRowCount: 0,
    dataQualityScore,
    codeGroupPresent: hasCG,
    failureCatalogMatchRate: Math.round(failureCatalogMatchRate * 1000) / 1000,
  };
}

async function _buildColumnProfiles(columnMap: ColumnMap): Promise<ColumnProfile[]> {
  const canonicalByRaw: Record<string, CanonicalColumn> = {};
  for (const [canonical, raw] of Object.entries(columnMap)) {
    if (raw) canonicalByRaw[raw] = canonical as CanonicalColumn;
  }

  const profiles: ColumnProfile[] = [];
  const schemaRows = await _q('DESCRIBE audit');

  for (const schemaRow of schemaRows) {
    const colName = String((schemaRow as any).column_name ?? '');
    if (colName.startsWith('_')) continue;

    try {
      const [countRow] = await _q(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN "${colName}" IS NOT NULL AND TRIM(CAST("${colName}" AS VARCHAR)) <> '' THEN 1 END) AS non_empty,
          COUNT(DISTINCT "${colName}") AS distinct_count
        FROM audit
      `);
      const total = Number((countRow as any)?.total ?? 0);
      const nonEmpty = Number((countRow as any)?.non_empty ?? 0);
      const distinctCnt = Number((countRow as any)?.distinct_count ?? 0);
      const nullCount = total - nonEmpty;
      const nullPct = total > 0 ? Math.round((nullCount / total) * 100) : 0;

      const sampleRows = await _q(`
        SELECT DISTINCT CAST("${colName}" AS VARCHAR) AS val
        FROM audit
        WHERE "${colName}" IS NOT NULL
          AND TRIM(CAST("${colName}" AS VARCHAR)) <> ''
        LIMIT 3
      `);
      const sampleValues = sampleRows.map((r: any) => String(r.val ?? ''));

      const isTimestamp = TIMESTAMP_COLUMNS.includes(colName as CanonicalColumn);
      const isText = TEXT_COLUMNS.includes(colName as CanonicalColumn);
      const isId = IDENTIFIER_COLUMNS.includes(colName as CanonicalColumn);

      let detectedType: ColumnProfile['detectedType'];
      if (isTimestamp) detectedType = 'date';
      else if (isId) detectedType = 'id';
      else if (isText) detectedType = 'text';
      else if (sampleValues.some((v) => !isNaN(Number(v)))) detectedType = 'number';
      else detectedType = 'text';

      const mappingConfidence: ColumnProfile['mappingConfidence'] =
        colName in COLUMN_LABELS ? 'HIGH' : 'UNMAPPED';

      profiles.push({
        rawName: colName,
        canonicalName: colName as CanonicalColumn,
        detectedType,
        nullCount,
        nullPct,
        distinctCount: distinctCnt,
        sampleValues,
        mappingConfidence,
      });
    } catch {
      // skip
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

  const criticalCols = ['work_order_number', 'notification_date', 'work_order_description'];
  for (const col of criticalCols) {
    const p = profiles.find((pr) => pr.rawName === col);
    if (!p) continue;
    if (p.nullPct > 50) score -= 15;
    else if (p.nullPct > 20) score -= 7;
    else if (p.nullPct > 5) score -= 3;
  }

  if (granularity === 'CONFIRMATION_LEVEL') score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic query helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _q(sql: string): Promise<Record<string, unknown>[]> {
  if (!_conn) throw new Error('Database is not initialised.');
  const result = await _conn.query(sql);
  return result.toArray().map((row: any) =>
    typeof row?.toJSON === 'function' ? (row.toJSON() as Record<string, unknown>) : ({ ...row } as Record<string, unknown>)
  );
}

export async function query(sql: string): Promise<Record<string, unknown>[]> {
  return _q(sql);
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter options + scoping
// ─────────────────────────────────────────────────────────────────────────────

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
      return rows.map((r) => String(r.v ?? ''));
    } catch {
      return [];
    }
  };

  const equipCol = columnMap.equipment_description ? 'equipment_description' : 'equipment';

  const [workCenter, functionalLocation, failureCatalog, equipment] =
    await Promise.all([
      distinct('work_center'),
      distinct('functional_location'),
      distinct('failure_catalog_desc'),
      columnMap.equipment_description || columnMap.equipment ? distinct(equipCol) : Promise.resolve([]),
    ]);

  let dateMin: string | null = null;
  let dateMax: string | null = null;
  if (columnMap.notification_date) {
    try {
      const [row] = await _q(`
        SELECT MIN(notification_date)::VARCHAR AS mn,
               MAX(notification_date)::VARCHAR AS mx
        FROM v_wo_primary WHERE notification_date IS NOT NULL
      `);
      if (row?.mn && row?.mx) {
        dateMin = String(row.mn).slice(0, 10);
        dateMax = String(row.mx).slice(0, 10);
      }
    } catch { /* ignore */ }
  }

  return { workCenter, functionalLocation, failureCatalog, equipment, dateMin, dateMax };
}

// ─── Shared filter-condition builder ────────────────────────────────────────

type FilterDim = 'workCenter' | 'functionalLocation' | 'failureCatalog' | 'equipment' | 'date';

function _buildFilterConditions(
  filters: AnalysisFilters,
  columnMap: ColumnMap,
  project: AuditProject | null,
  excludeDim?: FilterDim,
): string[] {
  const conditions: string[] = [];
  const has = (col: string) => !!columnMap[col as keyof ColumnMap];

  if (project?.type === 'SINGLE_BANK' && project.bankPattern && has('functional_location')) {
    const pattern = project.bankPattern.replace(/\*/g, '%').replace(/'/g, "''");
    conditions.push(`functional_location LIKE '${pattern}'`);
  }

  if (excludeDim !== 'date' && has('notification_date')) {
    if (filters.dateFrom) conditions.push(`notification_date >= '${filters.dateFrom}'::DATE`);
    if (filters.dateTo)   conditions.push(`notification_date <= '${filters.dateTo}'::DATE`);
  }

  const inList = (col: string, dim: FilterDim, vals: string[]) => {
    if (dim === excludeDim || !has(col) || vals.length === 0) return;
    const escaped = vals.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
    conditions.push(`${col} IN (${escaped})`);
  };

  inList('work_center',          'workCenter',         filters.workCenter);
  inList('functional_location',  'functionalLocation', filters.functionalLocation);
  inList('failure_catalog_desc', 'failureCatalog',     filters.failureCatalog);

  if (excludeDim !== 'equipment' && filters.equipment.length > 0) {
    const equipCol = has('equipment_description') ? 'equipment_description'
      : has('equipment') ? 'equipment' : null;
    if (equipCol) {
      const escaped = filters.equipment.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
      conditions.push(`${equipCol} IN (${escaped})`);
    }
  }

  return conditions;
}

/**
 * Lightweight WO count for the current filter selection — does NOT mutate any view.
 * Use this to show a live scope count as the user changes filters.
 */
export async function getLiveScopeCount(
  filters: AnalysisFilters,
  columnMap: ColumnMap,
  project: AuditProject | null,
): Promise<number> {
  if (!_conn) return 0;
  try {
    const conds = _buildFilterConditions(filters, columnMap, project);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [row] = await _q(`SELECT COUNT(*) AS cnt FROM v_wo_primary ${where}`);
    return Number(row?.cnt ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Returns filter options where each dimension is narrowed by all OTHER active
 * filters (faceted / cascading behaviour). dateMin/dateMax come from the
 * provided `baseOptions` and are never recalculated.
 */
export async function getCascadingFilterOptions(
  filters: AnalysisFilters,
  columnMap: ColumnMap,
  project: AuditProject | null,
  baseOptions: FilterOptions,
): Promise<FilterOptions> {
  if (!_conn) return baseOptions;

  const distinctFrom = async (col: string, dim: FilterDim): Promise<string[]> => {
    if (!columnMap[col as keyof ColumnMap]) return [];
    try {
      const conds = [
        ..._buildFilterConditions(filters, columnMap, project, dim),
        `${col} IS NOT NULL`,
        `TRIM(CAST(${col} AS VARCHAR)) <> ''`,
      ];
      const rows = await _q(`
        SELECT DISTINCT CAST(${col} AS VARCHAR) AS v
        FROM v_wo_primary
        WHERE ${conds.join(' AND ')}
        ORDER BY v LIMIT 500
      `);
      return rows.map((r) => String(r.v ?? ''));
    } catch {
      return [];
    }
  };

  const equipCol = columnMap.equipment_description ? 'equipment_description' : 'equipment';

  const [workCenter, functionalLocation, failureCatalog, equipment] = await Promise.all([
    distinctFrom('work_center',          'workCenter'),
    distinctFrom('functional_location',  'functionalLocation'),
    distinctFrom('failure_catalog_desc', 'failureCatalog'),
    (columnMap.equipment_description || columnMap.equipment)
      ? distinctFrom(equipCol, 'equipment')
      : Promise.resolve([] as string[]),
  ]);

  return {
    workCenter,
    functionalLocation,
    failureCatalog,
    equipment,
    dateMin: baseOptions.dateMin,
    dateMax: baseOptions.dateMax,
  };
}

/**
 * Builds `v_analysis_scope`: filtered subset of `v_wo_primary`. Applies the
 * project's bank pattern (when `SINGLE_BANK`) plus user-selected filters.
 */
export async function createAnalysisScopeView(
  filters: AnalysisFilters,
  columnMap: ColumnMap,
  project: AuditProject | null
): Promise<number> {
  if (!_conn) throw new Error('Database is not initialised.');

  const conditions = _buildFilterConditions(filters, columnMap, project);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  await _conn.query(`
    CREATE OR REPLACE VIEW v_analysis_scope AS
    SELECT * FROM v_wo_primary ${where}
  `);

  const [row] = await _q('SELECT COUNT(*) AS cnt FROM v_analysis_scope');
  return Number(row?.cnt ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// AI flags table
// ─────────────────────────────────────────────────────────────────────────────

export async function createAIFlagsTable(): Promise<void> {
  if (!_conn) throw new Error('Database is not initialised.');
  await _conn.query(`
    CREATE OR REPLACE TABLE ai_flags (
      wo_number     VARCHAR,
      row_seq       INTEGER,
      category      VARCHAR,
      severity      VARCHAR,
      comment       VARCHAR,
      description   VARCHAR,
      codes         VARCHAR,
      closure       VARCHAR,
      equipment     VARCHAR,
      sugg_part     VARCHAR,
      sugg_damage   VARCHAR,
      sugg_cause    VARCHAR
    )
  `);
}

export async function insertAIFlagsBatch(flags: AIFlag[]): Promise<void> {
  if (!_conn || flags.length === 0) return;
  const rows = flags
    .map(
      (f) =>
        `('${esc(f.woNumber)}',${f.rowSeq ?? 'NULL'},'${esc(f.category)}','${esc(f.severity)}','${esc(f.comment)}','${esc(
          f.description ?? ''
        )}','${esc(f.codes ?? '')}','${esc(f.closure ?? '')}','${esc(f.equipment ?? '')}','${esc(
          f.suggested?.object_part ?? ''
        )}','${esc(f.suggested?.damage ?? '')}','${esc(f.suggested?.cause ?? '')}')`
    )
    .join(',\n');
  await _conn.query(`
    INSERT INTO ai_flags (wo_number, row_seq, category, severity, comment, description, codes, closure, equipment, sugg_part, sugg_damage, sugg_cause)
    VALUES ${rows}
  `);
}

export async function restoreAIFlagsFromRun(flags: AIFlag[]): Promise<void> {
  await createAIFlagsTable();
  if (flags.length > 0) await insertAIFlagsBatch(flags);
}

export async function queryAIFlags(category?: string): Promise<AIFlag[]> {
  const where = category ? `WHERE category = '${esc(category)}'` : '';
  const rows = await _q(`SELECT * FROM ai_flags ${where} ORDER BY severity DESC, wo_number, row_seq`);
  return rows.map((r) => ({
    woNumber: String(r.wo_number ?? ''),
    rowSeq: r.row_seq != null ? Number(r.row_seq) : undefined,
    category: String(r.category ?? '') as AIFlag['category'],
    severity: String(r.severity ?? '') as AIFlag['severity'],
    comment: String(r.comment ?? ''),
    description: String(r.description ?? ''),
    codes: String(r.codes ?? ''),
    closure: String(r.closure ?? ''),
    equipment: String(r.equipment ?? ''),
    suggested:
      r.sugg_part || r.sugg_damage || r.sugg_cause
        ? {
            object_part: String(r.sugg_part ?? ''),
            damage: String(r.sugg_damage ?? ''),
            cause: String(r.sugg_cause ?? ''),
          }
        : undefined,
  }));
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}
