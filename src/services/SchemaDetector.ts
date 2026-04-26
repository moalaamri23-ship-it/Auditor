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
      // Penalize very short keyword that's just a prefix substring of the header
      const shorter = Math.min(norm.length, kwNorm.length);
      const longer = Math.max(norm.length, kwNorm.length);
      const ratio = shorter / longer;
      best = Math.max(best, Math.round(40 + ratio * 30));
    } else {
      const rawWords = norm.split('_').filter(Boolean);
      const kwWords = kwNorm.split('_').filter(Boolean);
      const overlap = rawWords.filter((w) => kwWords.includes(w)).length;
      if (overlap > 0) {
        const ratio = overlap / Math.max(rawWords.length, kwWords.length);
        best = Math.max(best, Math.round(ratio * 60));
      }
    }

    if (best === 100) break;
  }

  return best;
}

export function detectColumns(headers: string[]): SchemaDetectionResult {
  const columnMap: ColumnMap = {};
  const candidates: MappingCandidate[] = [];
  const usedHeaders = new Set<string>();

  // Specific (multi-word) descriptions claim headers before generic ones,
  // so e.g. "Equipment_Description" wins over "Equipment".
  const PRIORITY_ORDER: CanonicalColumn[] = [
    'work_order_number',
    'notification_date',
    'work_order_description',
    'equipment_description',
    'functional_location_description',
    'object_part_code_description',
    'damage_code_description',
    'cause_code_description',
    'failure_catalog_desc',
    'work_center',
    'operation_description',
    'confirmation_long_text',
    'confirmation_text',
    'code_group',
    'equipment',
    'functional_location',
  ];

  const entries = Object.entries(SAP_COLUMN_KEYWORDS) as [CanonicalColumn, string[]][];
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
    let bestScore = 0;

    for (const header of headers) {
      if (usedHeaders.has(header)) continue;
      const score = scoreMatch(header, keywords);
      if (score > bestScore) {
        bestScore = score;
        bestHeader = header;
      }
    }

    if (bestScore >= SCORE_THRESHOLD) {
      columnMap[canonical] = bestHeader;
      usedHeaders.add(bestHeader);
      candidates.push({
        canonicalName: canonical,
        rawName: bestHeader,
        score: bestScore,
        confidence: bestScore >= 80 ? 'HIGH' : bestScore >= 55 ? 'MEDIUM' : 'LOW',
      });
    }
  }

  const unmappedHeaders = headers.filter((h) => !usedHeaders.has(h));

  return { columnMap, candidates, unmappedHeaders };
}
