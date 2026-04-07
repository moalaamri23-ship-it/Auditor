import type { CanonicalColumn, ColumnMap, MappingCandidate, SchemaDetectionResult } from '../types';
import { SAP_COLUMN_KEYWORDS } from '../constants';

// ─────────────────────────────────────────────────────────────────────────────
// Scoring-based column detection
// Exact match = 100, contained match = 70, word overlap = 0–60
// Minimum threshold to accept a mapping: 40
// ─────────────────────────────────────────────────────────────────────────────

const SCORE_THRESHOLD = 40;

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\-./\\()[\]]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function scoreMatch(rawHeader: string, keywords: string[]): number {
  const norm = normalise(rawHeader);
  let best = 0;

  for (const kw of keywords) {
    const kwNorm = normalise(kw);

    if (norm === kwNorm) {
      best = Math.max(best, 100);
    } else if (norm.includes(kwNorm) || kwNorm.includes(norm)) {
      best = Math.max(best, 70);
    } else {
      // Word-level overlap
      const rawWords = norm.split('_').filter(Boolean);
      const kwWords  = kwNorm.split('_').filter(Boolean);
      const overlap  = rawWords.filter((w) => kwWords.includes(w)).length;
      if (overlap > 0) {
        const ratio = overlap / Math.max(rawWords.length, kwWords.length);
        best = Math.max(best, Math.round(ratio * 60));
      }
    }

    if (best === 100) break; // can't do better
  }

  return best;
}

export function detectColumns(headers: string[]): SchemaDetectionResult {
  const columnMap: ColumnMap = {};
  const candidates: MappingCandidate[] = [];
  const usedHeaders = new Set<string>();

  // Score every canonical column against every header, pick best unused match
  const entries = Object.entries(SAP_COLUMN_KEYWORDS) as [CanonicalColumn, string[]][];

  // Sort: put higher-priority (required) columns first so they claim headers first
  const PRIORITY_ORDER: CanonicalColumn[] = [
    'work_order_number',
    'notification_number',
    'equipment',
    'functional_location',
    'actual_start_date',
    'actual_finish_date',
    'notification_date',
    'confirmation_text',
    'work_order_description',
  ];

  const sortedEntries = [...entries].sort(([a], [b]) => {
    const ai = PRIORITY_ORDER.indexOf(a);
    const bi = PRIORITY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  for (const [canonical, keywords] of sortedEntries) {
    let bestHeader = '';
    let bestScore  = 0;

    for (const header of headers) {
      if (usedHeaders.has(header)) continue;
      const score = scoreMatch(header, keywords);
      if (score > bestScore) {
        bestScore  = score;
        bestHeader = header;
      }
    }

    if (bestScore >= SCORE_THRESHOLD) {
      columnMap[canonical] = bestHeader;
      usedHeaders.add(bestHeader);
      candidates.push({
        canonicalName: canonical,
        rawName:       bestHeader,
        score:         bestScore,
        confidence:    bestScore >= 80 ? 'HIGH' : bestScore >= 55 ? 'MEDIUM' : 'LOW',
      });
    }
  }

  const unmappedHeaders = headers.filter((h) => !usedHeaders.has(h));

  return { columnMap, candidates, unmappedHeaders };
}
