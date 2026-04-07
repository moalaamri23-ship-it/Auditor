import type { ParsedFile, ColumnMap, ValidationReport, ValidationIssue } from '../types';
import {
  REQUIRED_COLUMNS,
  REQUIRED_EITHER_TIMESTAMPS,
  REQUIRED_EITHER_TEXT,
} from '../constants';

export function validateStructure(
  file: ParsedFile,
  columnMap: ColumnMap
): ValidationReport {
  const errors:   ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const infos:    ValidationIssue[] = [];
  const passed:   string[] = [];

  // ── Non-empty file ───────────────────────────────────────────────────────
  if (file.rowCount === 0) {
    errors.push({
      level: 'ERROR',
      code: 'EMPTY_FILE',
      message: 'The file contains no data rows.',
    });
  } else {
    passed.push(`${file.rowCount.toLocaleString()} rows detected`);
  }

  // ── Minimum column count ─────────────────────────────────────────────────
  if (file.headers.length < 3) {
    warnings.push({
      level: 'WARNING',
      code: 'FEW_COLUMNS',
      message: `Only ${file.headers.length} column(s) detected — this may indicate a delimiter detection issue.`,
    });
  } else {
    passed.push(`${file.headers.length} columns detected`);
  }

  // ── Required columns ─────────────────────────────────────────────────────
  for (const col of REQUIRED_COLUMNS) {
    if (!columnMap[col]) {
      errors.push({
        level: 'ERROR',
        code: 'MISSING_REQUIRED_COLUMN',
        message: `Could not detect a column for "${col}". Please map it manually on the next screen.`,
        column: col,
      });
    } else {
      passed.push(`"${col}" detected → "${columnMap[col]}"`);
    }
  }

  // ── At least one timestamp ───────────────────────────────────────────────
  const hasTimestamp = REQUIRED_EITHER_TIMESTAMPS.some((col) => !!columnMap[col]);
  if (!hasTimestamp) {
    errors.push({
      level: 'ERROR',
      code: 'NO_TIMESTAMP',
      message:
        'No date or timestamp column was detected. At least one is required for time-based analysis.',
    });
  } else {
    const found = REQUIRED_EITHER_TIMESTAMPS.filter((c) => !!columnMap[c]);
    passed.push(`${found.length} timestamp column(s) detected`);
  }

  // ── At least one text field ──────────────────────────────────────────────
  const hasText = REQUIRED_EITHER_TEXT.some((col) => !!columnMap[col]);
  if (!hasText) {
    warnings.push({
      level: 'WARNING',
      code: 'NO_TEXT',
      message:
        'No text description column was detected. AI analysis modules will have limited context.',
    });
  } else {
    passed.push('Text description column(s) detected');
  }

  // ── No reliability codes ─────────────────────────────────────────────────
  const hasReliabilityCodes = !!(
    columnMap.reliability_code_1 ||
    columnMap.reliability_code_2 ||
    columnMap.reliability_code_3
  );
  if (!hasReliabilityCodes) {
    infos.push({
      level: 'INFO',
      code: 'NO_RELIABILITY_CODES',
      message:
        'No reliability code columns detected. Code-vs-description mismatch analysis will be skipped.',
    });
  }

  // ── Info: file summary ───────────────────────────────────────────────────
  infos.push({
    level: 'INFO',
    code: 'FILE_SUMMARY',
    message: `File: "${file.fileName}" — ${file.rowCount.toLocaleString()} rows, ${file.headers.length} columns, ${formatBytes(file.fileSize)}.`,
  });

  const canProceed = errors.length === 0;
  const dataQualityScore = computeStructuralScore(errors.length, warnings.length, file, columnMap);

  return { errors, warnings, infos, passed, dataQualityScore, canProceed };
}

function computeStructuralScore(
  errorCount: number,
  warningCount: number,
  file: ParsedFile,
  columnMap: ColumnMap
): number {
  let score = 100;
  score -= errorCount * 20;
  score -= warningCount * 5;

  // Bonus: has confirmation text (most valuable text field for audit)
  if (!columnMap.confirmation_text) score -= 5;

  // Bonus: has equipment or FL (enables equipment-level analysis)
  if (!columnMap.equipment && !columnMap.functional_location) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
