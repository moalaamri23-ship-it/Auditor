// ─────────────────────────────────────────────
// CANONICAL COLUMN NAMES
// ─────────────────────────────────────────────
export type CanonicalColumn =
  | 'work_order_number'
  | 'notification_date'
  | 'work_order_description'
  | 'work_center'
  | 'equipment'
  | 'equipment_description'
  | 'failure_catalog_desc'
  | 'functional_location'
  | 'functional_location_description'
  | 'object_part_code_description'
  | 'damage_code_description'
  | 'cause_code_description'
  | 'operation_description'
  | 'confirmation_text'
  | 'confirmation_long_text'
  | 'code_group';

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
// PARSED FILE (raw, before Database load)
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
  | 'WO_LEVEL'
  | 'MIXED'
  | 'CONFIRMATION_LEVEL'
  | 'UNKNOWN';

export interface ColumnProfile {
  rawName: string;
  canonicalName: CanonicalColumn | null;
  detectedType: 'date' | 'number' | 'text' | 'id' | 'unknown';
  nullCount: number;
  nullPct: number;
  distinctCount: number;
  sampleValues: string[];
  mappingConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNMAPPED';
}

export interface DataProfile {
  totalRows: number;
  distinctWOs: number;
  distinctEquipment: number;
  distinctFunctionalLocations: number;
  rowsPerWO: number;
  maxRowsPerWO: number;
  granularityLevel: GranularityLevel;
  dateRange: { min: string; max: string } | null;
  columnProfiles: ColumnProfile[];
  duplicateRowCount: number;
  dataQualityScore: number;
  codeGroupPresent: boolean;
  failureCatalogMatchRate: number; // 0–1, fraction of WOs whose failure_catalog_desc exists in the catalog
}

// ─────────────────────────────────────────────
// AUDIT PROJECT + RUN
// ─────────────────────────────────────────────
export type AuditType   = 'TOTAL' | 'SINGLE_BANK';
export type AuditPeriod = 'WEEKLY' | 'BIWEEKLY' | 'QUARTERLY' | 'YEARLY';

export interface AuditProject {
  id: string;
  name: string;
  type: AuditType;
  period: AuditPeriod;
  bankPattern?: string;        // SAP-LIKE pattern, e.g. "OS-BK053-LOT03-PWT-%"; required if type === 'SINGLE_BANK'
  createdAt: string;
  runIds: string[];            // ordered, oldest-first
}

export type RunStage =
  | 'init'         // project just created, no upload yet
  | 'uploaded'
  | 'mapped'
  | 'profiled'
  | 'pre-checked'
  | 'analysed';

export interface AnalysisFilters {
  dateFrom: string | null;
  dateTo: string | null;
  workCenter: string[];
  functionalLocation: string[];
  failureCatalog: string[];
  equipment: string[];
}

export interface FilterOptions {
  workCenter: string[];
  functionalLocation: string[];
  failureCatalog: string[];
  equipment: string[];
  dateMin: string | null;
  dateMax: string | null;
}

export const EMPTY_FILTERS: AnalysisFilters = {
  dateFrom: null,
  dateTo: null,
  workCenter: [],
  functionalLocation: [],
  failureCatalog: [],
  equipment: [],
};

// ─────────────────────────────────────────────
// CHART CACHE (persisted with the run for post-refresh display)
// ─────────────────────────────────────────────
export interface ChartCache {
  perWorkCenter: Array<{ workCenter: string; total: number; flagged: number }>;
  topEquipment: Array<{ equipment: string; count: number }>;
  codeQuality: { valid: number; notListed: number; invalidHierarchy: number; missing: number } | null;
  overallQuality: { valid: number; entryQuality: number; missingFields: number; total: number } | null;
  computedAt: string;
}

export interface AuditRun {
  id: string;
  projectId: string;
  runIndex: number;            // 1-based within project
  periodLabel: string;         // free-form, e.g. "2026-Q1", used for distinct-period validation
  name: string;
  fileName: string;
  fileSize: number;
  uploadedAt: string;
  lastAnalysedAt: string | null;
  columnMap: ColumnMap;
  validationReport: ValidationReport | null;
  dataProfile: DataProfile | null;
  ruleChecks: RuleCheckResult | null;
  aiFlags: AIFlag[];
  aiFlagSummary: AIFlagSummary | null;
  stage: RunStage;
  hasDataInDB: boolean;        // false on cold reload — Database is in-memory
  analysisFilters: AnalysisFilters;
  chartCache: ChartCache | null;
}

// ─────────────────────────────────────────────
// FAILURE CATALOG
// ─────────────────────────────────────────────
export interface FailureCatalogEntry {
  failure_catalog_desc: string;
  object_part_code_description: string;
  damage_code_description: string;
  cause_code_description: string;
}

export interface FailureCatalog {
  source: 'bundled' | 'user';
  generatedAt: string;
  rowCount: number;
  rows: FailureCatalogEntry[];
}

// ─────────────────────────────────────────────
// RULE-BASED PRE-CHECKS (Database tier)
// ─────────────────────────────────────────────
export type RuleCheckId =
  | 'missing_confirmation'
  | 'not_listed_codes'
  | 'missing_scoping_text'
  | 'catalog_invalid_object_part'
  | 'catalog_invalid_damage_for_part'
  | 'catalog_invalid_cause_for_damage'
  | 'catalog_missing_match';

export interface RuleCheckBucket {
  matched: number;
  sampleWOs: string[];   // up to 5
}

export interface RuleCheckResult {
  generatedAt: string;
  totalWOs: number;
  perCheck: Partial<Record<RuleCheckId, RuleCheckBucket>>;
  flaggedWOs: Array<{ wo: string; checks: RuleCheckId[] }>;
}

// ─────────────────────────────────────────────
// AI CONFIG / PROVIDERS
// ─────────────────────────────────────────────
export type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'azure' | 'openrouter' | 'copilot';

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  modelId: string;
  powerAutomateUrl?: string;
}

// ─────────────────────────────────────────────
// AI PER-RECORD FLAGS — new taxonomy
// ─────────────────────────────────────────────
export type FlagCategory =
  | 'desc_code_conflict'              // Description identifies failure clearly but codes don't match
  | 'false_not_listed'                // Codes = "Not Listed" but Description/Confirmation imply a known catalog code
  | 'desc_confirmation_mismatch'      // Description and Confirmation describe different things
  | 'desc_code_confirmation_misalign' // All three sources contradict
  | 'generic_description'             // Description doesn't define the request
  | 'generic_confirmation';           // Confirmation provides no useful information

export interface AIFlag {
  woNumber: string;
  rowSeq?: number;       // confirmation row (1-based); undefined = WO-level flag
  category: FlagCategory;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  comment: string;
  description?: string;     // WO description (snapshot)
  codes?: string;           // formatted "Part: X | Damage: Y | Cause: Z"
  closure?: string;         // confirmation short text (truncated)
  equipment?: string;
  suggested?: {
    object_part: string;
    damage: string;
    cause: string;
  };
}

export interface AIFlagSummary {
  totalFlagged: number;
  totalFlags: number;
  byCategory: Partial<Record<FlagCategory, number>>;
  generatedAt: string;
  scopeWOCount: number;
}

// ─────────────────────────────────────────────
// APP STATE (ZUSTAND)
// ─────────────────────────────────────────────
export type Screen =
  | 'projects'        // dashboard listing all audit projects
  | 'project-home'    // run list for an active project
  | 'audit-init'      // wizard: name, type, period, bank
  | 'upload'
  | 'schema-mapper'
  | 'profiler'
  | 'pre-checks'
  | 'analysis'
  | 'comparison'
  | 'explorer'
  | 'settings';

export interface AppState {
  // Persisted
  projects: AuditProject[];
  runs: AuditRun[];
  activeProjectId: string | null;
  activeRunId: string | null;
  aiConfig: AIConfig;

  // Transient UI (not persisted)
  currentScreen: Screen;
  isLoading: boolean;
  loadingMessage: string;

  // Actions — projects
  createProject: (input: {
    name: string;
    type: AuditType;
    period: AuditPeriod;
    bankPattern?: string;
  }) => string;
  updateProject: (id: string, updates: Partial<AuditProject>) => void;
  deleteProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;

  // Actions — runs
  createRun: (input: { projectId: string; periodLabel: string; file: ParsedFile }) => string;
  updateRun: (id: string, updates: Partial<AuditRun>) => void;
  deleteRun: (id: string) => void;
  setActiveRun: (id: string | null) => void;

  // Actions — UI
  setScreen: (screen: Screen) => void;
  setLoading: (loading: boolean, message?: string) => void;
  updateAIConfig: (config: Partial<AIConfig>) => void;
}
