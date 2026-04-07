// ─────────────────────────────────────────────────────────────────────────────
// ANALYSIS TYPES
// All analysis modules produce typed results that flow into the UI and AI layer.
// Raw rows never leave DuckDB — only aggregates and bounded samples go anywhere.
// ─────────────────────────────────────────────────────────────────────────────

export type AnomalySeverity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export type ModuleStatus = 'pass' | 'warning' | 'critical' | 'insufficient';

// ─── Individual anomaly ───────────────────────────────────────────────────────

export interface AnomalySample {
  wo?:          string;
  equipment?:   string;
  value?:       string;
  description?: string;
  flag?:        string;
}

export interface Anomaly {
  id:            string;
  moduleId:      string;
  severity:      AnomalySeverity;
  type:          string;          // e.g. 'REVERSED_TIMESTAMPS'
  label:         string;          // human-readable short label
  description:   string;          // full explanation
  sqlBasis:      string;          // the SQL logic behind this finding
  affectedCount: number;
  totalCount:    number;          // denominator for % calculations
  score:         number;          // 0–100 anomaly severity score
  samples:       AnomalySample[]; // max 5 samples; never sent to AI directly
}

// ─── Module result ────────────────────────────────────────────────────────────

export interface ModuleKeyMetric {
  label: string;
  value: string;
  unit?: string;
  note?: string; // e.g. "may be unreliable due to 34% null rate"
}

export interface ModuleResult {
  moduleId:   string;
  moduleName: string;
  status:     ModuleStatus;
  score:      number;          // 0–100 module health score
  keyMetric:  ModuleKeyMetric;
  anomalies:  Anomaly[];
  metrics:    Record<string, unknown>; // all raw computed values
  warnings:   string[];        // why results may be unreliable
  computedAt: string;          // ISO
}

// ─── Full analysis results ────────────────────────────────────────────────────

export interface AnalysisResults {
  sessionId:      string;
  maturityScore:  number;      // 0–100 composite
  maturityGrade:  string;      // A–F
  modules:        ModuleResult[];
  totalAnomalies: number;
  scopeWOCount:   number;      // WOs in scope after filters
  filters:        import('../types').AnalysisFilters;
  computedAt:     string;      // ISO
}

// ─── Maturity pillar weights ──────────────────────────────────────────────────

export const MATURITY_WEIGHTS: Record<string, number> = {
  'data-integrity': 0.40,
  'reliability':    0.25,
  'process':        0.35,
};

export function computeMaturityScore(modules: ModuleResult[]): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const mod of modules) {
    const w = MATURITY_WEIGHTS[mod.moduleId] ?? 0;
    weighted    += mod.score * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? Math.round(weighted / totalWeight) : 0;
}

export function maturityGrade(score: number): string {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}
