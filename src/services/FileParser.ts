import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { ParsedFile } from '../types';

export async function parseFile(file: File): Promise<ParsedFile> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'csv') return parseCsv(file);
  if (ext === 'xlsx' || ext === 'xls') return parseExcel(file);

  throw new Error(
    `Unsupported file type: .${ext}. Please upload a CSV or Excel (.xlsx / .xls) file.`
  );
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

function parseCsv(file: File): Promise<ParsedFile> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
      complete: (results) => {
        const headers = results.meta.fields ?? [];
        const rows = results.data;

        if (rows.length === 0) {
          reject(new Error('The CSV file contains no data rows.'));
          return;
        }

        resolve({
          headers,
          rows,
          rowCount: rows.length,
          fileName: file.name,
          fileSize: file.size,
        });
      },
      error: (err) => reject(new Error(`CSV parsing failed: ${err.message}`)),
    });
  });
}

// ─── Excel ───────────────────────────────────────────────────────────────────

async function parseExcel(file: File): Promise<ParsedFile> {
  const buffer = await file.arrayBuffer();

  const workbook = XLSX.read(buffer, {
    type: 'array',
    cellDates: false,       // keep dates as formatted strings
    cellNF: false,
    raw: false,
  });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('The Excel file contains no sheets.');

  const worksheet = workbook.Sheets[sheetName];

  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    raw: false,
    dateNF: 'YYYY-MM-DD',
    defval: '',
  });

  if (rawRows.length === 0) {
    throw new Error('The Excel sheet appears to be empty.');
  }

  // Normalize: all keys trimmed, all values as strings
  const headers = Object.keys(rawRows[0]).map((h) => h.trim());

  const rows: Record<string, string>[] = rawRows.map((rawRow) => {
    const normalized: Record<string, string> = {};
    for (const key of Object.keys(rawRow)) {
      const trimmedKey = key.trim();
      const val = rawRow[key];
      normalized[trimmedKey] =
        val == null ? '' : String(val).trim();
    }
    return normalized;
  });

  return {
    headers,
    rows,
    rowCount: rows.length,
    fileName: file.name,
    fileSize: file.size,
  };
}
