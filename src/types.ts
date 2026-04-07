// ─────────────────────────────────────────────
// CANONICAL COLUMN NAMES
// ─────────────────────────────────────────────
export type CanonicalColumn =
  | 'work_order_number'
  | 'notification_number'
  | 'equipment'
  | 'functional_location'
  | 'notification_date'
  | 'scheduled_start_date'
  | 'actual_start_date'
  | 'actual_finish_date'
  | 'confirmation_date'
  | 'notification_description'
  | 'work_order_description'
  | 'confirmation_text'
  | 'confirmation_long_text'
  | 'reliability_code_1'
  | 'reliability_code_2'
  | 'reliability_code_3'
  | 'failure_mode'
  | 'cause_code'
  | 'notification_status'
  | 'work_order_status'
  | 'system_status'
  | 'user_status';

// ─────────────────────────────────────────────
// COLUMN MAPPING
// ─────────────────────────────────────────────

/** Maps canonical column name → raw header name in the uploaded file */
export type ColumnMap = Partial<Record<CanonicalColumn, string>>;

export interface MappingCandidate {
  canonicalName: CanonicalColumn;
  rawName: string;
  score: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface SchemaDetectionResult {
  columnMap: ColumnMap;
  candidates: MappingCandidate[];
  unmappedHeaders: string[];
}

// ─────────────────────────────────────────────
// PARSED FILE (raw, before DuckDB)
// ─────────────────────────────────────────────
export interface ParsedFile {
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  fileName: string;
  fileSize: number;
}

// ─────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────
export type IssueLevel = 'ERROR' | 'WARNING' | 'INFO';

export interface ValidationIssue {
  level: IssueLevel;
  code: string;
  message: string;
  column?: string;
  affectedCount?: number;
}

export interface ValidationReport {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  infos: ValidationIssue[];
  passed: string[];
  dataQualityScore: number; // 0–100
  canProceed: boolean;
}

// ─────────────────────────────────────────────
// DATA PROFILING
// ─────────────────────────────────────────────
export type GranularityLevel =
  | 'WO_LEVEL'           // avg rows/WO < 1.2  — safe to treat rows ≈ WOs
  | 'MIXED'              // 1.2–3.0             — some confirmation expansion
  | 'CONFIRMATION_LEVEL' // > 3.0               — heavy expansion, always deduplicate
  | 'UNKNOWN';

export interface ColumnProfile {
  rawName: string;
  canonicalName: CanonicalColumn | null;
  detectedType: 'date' | 'number' | 'text' | 'id' | 'unknown';
  nullCount: number;
  nullPct: number;         // 0–100
  distinctCount: number;
  sampleValues: string[];
  mappingConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNMAPPED';
}

export interface DataProfile {
  totalRows: number;
  distinctWOs: number;
  distinctNotifications: number;
  distinctEquipment: number;
  distinctFunctionalLocations: number;
  rowsPerWO: number;
  maxRowsPerWO: number;
  granularityLevel: GranularityLevel;
  dateRange: { min: string; max: string } | null;
  columnProfiles: ColumnProfile[];
  duplicateRowCount: number;
  dataQualityScore: number; // 0–100 composite
}

// ─────────────────────────────────────────────
// SESSION
// ─────────────────────────────────────────────
export type SessionStage = 'uploaded' | 'mapped' | 'profiled' | 'analysed';

export interface AnalysisFilters {
  dateFrom:          string | null;
  dateTo:            string | null;
  equipment:         string[];
  functionalLocation: string[];
  orderType:         string[];
  systemStatus:      string[];
}

export interface FilterOptions {
  equipment:          string[];
  functionalLocation: string[];
  orderType:          string[];
  systemStatus:       string[];
  dateMin:            string | null;
  dateMax:            string | null;
}

export const EMPTY_FILTERS: AnalysisFilters = {
  dateFrom:           null,
  dateTo:             null,
  equipment:          [],
  functionalLocation: [],
  orderType:          [],
  systemStatus:       [],
};

export interface Session {
  id: string;
  name: string;
  fileName: string;
  fileSize: number;
  uploadedAt: string;          // ISO
  lastAnalysedAt: string | null;
  columnMap: ColumnMap;
  validationReport: ValidationReport | null;
  dataProfile: DataProfile | null;
  analysisResults: import('./analysis/analysisTypes').AnalysisResults | null;
  maturityScore: number | null; // 0–100 composite
  stage: SessionStage;
  hasDataInDuckDB: boolean;    // false after page refresh (DuckDB is in-memory)
  analysisFilters: AnalysisFilters;
}

// ─────────────────────────────────────────────
// AI
// ─────────────────────────────────────────────
export type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'azure' | 'openrouter';

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  modelId: string;
}

export interface AIFinding {
  moduleId: string;
  finding: string;
  confidence: number; // 0–1
  reasoning: string;
  recommendedAction: string;
  insufficientData: boolean;
  generatedAt: string; // ISO
}

// ─────────────────────────────────────────────
// APP STATE (ZUSTAND)
// ─────────────────────────────────────────────
export type Screen =
  | 'dashboard'
  | 'upload'
  | 'schema-mapper'
  | 'profiler'
  | 'analysis'
  | 'explorer'
  | 'insights'
  | 'settings';

export interface AppState {
  // Persisted
  sessions: Session[];
  activeSessionId: string | null;
  aiConfig: AIConfig;

  // Transient UI (not persisted)
  currentScreen: Screen;
  isLoading: boolean;
  loadingMessage: string;

  // Actions
  createSession: (file: ParsedFile) => string;
  updateSession: (id: string, updates: Partial<Session>) => void;
  deleteSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  setScreen: (screen: Screen) => void;
  setLoading: (loading: boolean, message?: string) => void;
  updateAIConfig: (config: Partial<AIConfig>) => void;
}
