import type { ParsedFile, ColumnMap, ValidationReport, ValidationIssue } from '../types';
import {
  REQUIRED_COLUMNS,
  REQUIRED_EITHER_TIMESTAMPS,
  REQUIRED_EITHER_TEXT,
  RECOMMENDED_FOR_CATALOG,
  COLUMN_LABELS,
} from '../constants';

export function validateStructure(
  file: ParsedFile,
  columnMap: ColumnMap
): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const infos: ValidationIssue[] = [];
  const passed: string[] = [];

  if (file.rowCount === 0) {
    errors.push({ level: 'ERROR', code: 'EMPTY_FILE', message: 'The file contains no data rows.' });
  } else {
    passed.push(`${file.rowCount.toLocaleString()} rows detected`);
  }

  if (file.headers.length < 3) {
    warnings.push({
      level: 'WARNING',
      code: 'FEW_COLUMNS',
      message: `Only ${file.headers.length} column(s) detected — this may indicate a delimiter detection issue.`,
    });
  } else {
    passed.push(`${file.headers.length} columns detected`);
  }

  for (const col of REQUIRED_COLUMNS) {
    if (!columnMap[col]) {
      errors.push({
        level: 'ERROR',
        code: 'MISSING_REQUIRED_COLUMN',
        message: `Could not detect a column for "${COLUMN_LABELS[col]}". Please map it manually on the next screen.`,
        column: col,
      });
    } else {
      passed.push(`"${COLUMN_LABELS[col]}" detected → "${columnMap[col]}"`);
    }
  }

  const hasTimestamp = REQUIRED_EITHER_TIMESTAMPS.some((col) => !!columnMap[col]);
  if (!hasTimestamp) {
    errors.push({
      level: 'ERROR',
      code: 'NO_TIMESTAMP',
      message: 'No date column was detected. A "Date" column is required for time-based analysis.',
    });
  } else {
    passed.push('Date column detected');
  }

  const hasText = REQUIRED_EITHER_TEXT.some((col) => !!columnMap[col]);
  if (!hasText) {
    warnings.push({
      level: 'WARNING',
      code: 'NO_TEXT',
      message: 'No description or confirmation column was detected. AI analysis will have limited context.',
    });
  } else {
    passed.push('Description / confirmation column(s) detected');
  }

  const missingCatalogCols = RECOMMENDED_FOR_CATALOG.filter((c) => !columnMap[c]);
  if (missingCatalogCols.length === RECOMMENDED_FOR_CATALOG.length) {
    warnings.push({
      level: 'WARNING',
      code: 'NO_CATALOG_COLUMNS',
      message: 'No failure-catalog code descriptions detected. Catalog hierarchy validation will be skipped.',
    });
  } else if (missingCatalogCols.length > 0) {
    infos.push({
      level: 'INFO',
      code: 'PARTIAL_CATALOG_COLUMNS',
      message: `${missingCatalogCols.length} catalog code description(s) not mapped: ${missingCatalogCols.map((c) => COLUMN_LABELS[c]).join(', ')}.`,
    });
  }

  if (!columnMap.code_group) {
    infos.push({
      level: 'INFO',
      code: 'NO_CODE_GROUP',
      message: 'No "Code Group" (scoping template) column detected. The "missing scoping text" rule check will be skipped.',
    });
  }

  infos.push({
    level: 'INFO',
    code: 'FILE_SUMMARY',
    message: `File: "${file.fileName}" — ${file.rowCount.toLocaleString()} rows, ${file.headers.length} columns, ${formatBytes(file.fileSize)}.`,
  });

  const canProceed = errors.length === 0;
  const dataQualityScore = computeStructuralScore(errors.length, warnings.length, columnMap);

  return { errors, warnings, infos, passed, dataQualityScore, canProceed };
}

function computeStructuralScore(
  errorCount: number,
  warningCount: number,
  columnMap: ColumnMap
): number {
  let score = 100;
  score -= errorCount * 20;
  score -= warningCount * 5;

  if (!columnMap.confirmation_text && !columnMap.confirmation_long_text) score -= 5;
  if (!columnMap.equipment && !columnMap.functional_location) score -= 5;

  const catalogMapped = RECOMMENDED_FOR_CATALOG.filter((c) => !!columnMap[c]).length;
  if (catalogMapped < 2) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
