#!/usr/bin/env node
// Regenerates src/data/failure-catalog.json from a Failure Catalog .xlsx.
//
// Usage: node scripts/build-failure-catalog.mjs <path-to-xlsx>
//
// The Excel layout is: Failure_Catalog_Desc | Object_Part_Code_Description |
// Object_Part_Code_Description (duplicate, ignored) | Damage_Code_Description |
// Cause_Code_Description.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEST = resolve(ROOT, 'src/data/failure-catalog.json');

const src = process.argv[2];
if (!src) {
  console.error('Usage: node scripts/build-failure-catalog.mjs <path-to-xlsx>');
  process.exit(1);
}

const buf = await readFile(src);
const wb = XLSX.read(buf, { type: 'buffer' });
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

const seen = new Set();
const out = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i] ?? [];
  const fc  = (r[0] ?? '').toString().trim();
  const op  = (r[1] ?? r[2] ?? '').toString().trim();
  const dam = (r[3] ?? '').toString().trim();
  const cau = (r[4] ?? '').toString().trim();
  if (!fc || !op || !dam || !cau) continue;
  const key = `${fc}|${op}|${dam}|${cau}`;
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({
    failure_catalog_desc:         fc,
    object_part_code_description: op,
    damage_code_description:      dam,
    cause_code_description:       cau,
  });
}

const sourceHash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
const payload = {
  version: 1,
  sourceHash,
  generatedAt: new Date().toISOString(),
  rows: out,
};

await writeFile(DEST, JSON.stringify(payload, null, 2));
console.log(`Wrote ${DEST} (${out.length} rows, hash ${sourceHash}).`);
