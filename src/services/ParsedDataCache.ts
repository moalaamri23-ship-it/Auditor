/**
 * In-memory cache for parsed file rows.
 *
 * DuckDB WASM is in-memory and cannot persist across page refreshes.
 * The raw rows are too large to store in Zustand/localStorage, so we
 * keep them here for the duration of the session's DuckDB load operation.
 *
 * The cache is cleared automatically after DuckDB load succeeds.
 */

interface CachedData {
  sessionId: string;
  headers: string[];
  rows: Record<string, string>[];
}

let _cache: CachedData | null = null;

export const ParsedDataCache = {
  set(sessionId: string, headers: string[], rows: Record<string, string>[]): void {
    _cache = { sessionId, headers, rows };
  },

  get(sessionId: string): CachedData | null {
    if (_cache?.sessionId !== sessionId) return null;
    return _cache;
  },

  getHeaders(sessionId: string): string[] | null {
    return ParsedDataCache.get(sessionId)?.headers ?? null;
  },

  clear(): void {
    _cache = null;
  },

  hasData(sessionId: string): boolean {
    return _cache?.sessionId === sessionId;
  },
};
