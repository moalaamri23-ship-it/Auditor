import * as XLSX from 'xlsx';
import bundled from '../data/failure-catalog.json';
import type { FailureCatalog, FailureCatalogEntry } from '../types';
import { STORAGE_KEYS } from '../constants';
import { loadFailureCatalog as loadIntoDB } from './DuckDBService';

interface BundledShape {
  version: number;
  sourceHash: string;
  generatedAt: string;
  rows: FailureCatalogEntry[];
}

function getBundled(): FailureCatalog {
  const b = bundled as BundledShape;
  return {
    source: 'bundled',
    generatedAt: b.generatedAt,
    rowCount: b.rows.length,
    rows: b.rows,
  };
}

function getUserCatalog(): FailureCatalog | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.FAILURE_CATALOG_USER);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FailureCatalog;
    if (!Array.isArray(parsed?.rows) || parsed.rows.length === 0) return null;
    return { ...parsed, source: 'user' };
  } catch {
    return null;
  }
}

/** Returns the catalog that should be loaded into the DB on startup. */
export function getActiveCatalog(): FailureCatalog {
  return getUserCatalog() ?? getBundled();
}

/** Loads the active catalog into the Database. Idempotent. */
export async function ensureCatalogLoaded(): Promise<FailureCatalog> {
  const cat = getActiveCatalog();
  await loadIntoDB(cat.rows);
  return cat;
}

/** Parse a Failure Catalog xlsx the user uploaded in Settings. */
export async function parseCatalogXlsx(file: File): Promise<FailureCatalog> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });

  const seen = new Set<string>();
  const out: FailureCatalogEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const fc = String((r[0] ?? '') as unknown).trim();
    const op = String(((r[1] ?? r[2]) ?? '') as unknown).trim();
    const dam = String((r[3] ?? '') as unknown).trim();
    const cau = String((r[4] ?? '') as unknown).trim();
    if (!fc || !op || !dam || !cau) continue;
    const key = `${fc}|${op}|${dam}|${cau}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      failure_catalog_desc: fc,
      object_part_code_description: op,
      damage_code_description: dam,
      cause_code_description: cau,
    });
  }

  if (out.length === 0) {
    throw new Error(
      'No valid catalog rows found. Expected columns: Failure_Catalog_Desc, Object_Part_Code_Description, Damage_Code_Description, Cause_Code_Description.'
    );
  }

  return {
    source: 'user',
    generatedAt: new Date().toISOString(),
    rowCount: out.length,
    rows: out,
  };
}

/** Persist a user-uploaded catalog and load it into the Database. */
export async function setUserCatalog(catalog: FailureCatalog): Promise<void> {
  const stored: FailureCatalog = { ...catalog, source: 'user' };
  localStorage.setItem(STORAGE_KEYS.FAILURE_CATALOG_USER, JSON.stringify(stored));
  await loadIntoDB(stored.rows);
}

/** Reset to bundled default. */
export async function resetToBundled(): Promise<FailureCatalog> {
  localStorage.removeItem(STORAGE_KEYS.FAILURE_CATALOG_USER);
  const cat = getBundled();
  await loadIntoDB(cat.rows);
  return cat;
}
