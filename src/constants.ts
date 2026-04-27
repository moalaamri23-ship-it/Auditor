import type { CanonicalColumn } from './types';

// ─────────────────────────────────────────────
// SAP PM COLUMN KEYWORD MAP
// Scoring-based detection: higher-specificity keywords score higher
// ─────────────────────────────────────────────
export const SAP_COLUMN_KEYWORDS: Record<CanonicalColumn, string[]> = {
  work_order_number: [
    'wo_number', 'wo number', 'wo_no', 'wo no', 'wo#', 'wo',
    'work_order_number', 'work order number', 'work_order', 'work order',
    'workorder', 'aufnr',
    'maint_order', 'maintenance_order', 'order_number', 'order number',
    'order_no', 'order no',
  ],
  notification_date: [
    'date', 'notification_date', 'notification date', 'notif_date', 'notif date',
    'qmdat', 'report_date', 'report date', 'reported_date',
    'failure_date', 'failure date', 'breakdown_date', 'breakdown date',
    'malfunction_date', 'date_reported',
  ],
  work_order_description: [
    'description', 'wo_description', 'wo description',
    'work_order_description', 'work order description',
    'ktext', 'order_description', 'order description', 'wo_text', 'wo text',
    'order_text', 'order text', 'work_description', 'work description',
    'short_text', 'short text',
  ],
  work_center: [
    'work_center', 'work center', 'workcenter', 'arbpl', 'arbeitsplatz',
    'maint_work_center', 'planner_group', 'planner group',
  ],
  work_center_description: [
    'work_center_description', 'work center description', 'workcenter_description',
    'workcenter description', 'arbpl_text',
  ],
  equipment: [
    'equipment', 'equnr', 'equipment_number', 'equipment number',
    'equipment_no', 'equipment no', 'asset_number', 'asset number',
    'asset_no', 'asset', 'machine_no', 'machine no', 'device_no',
  ],
  equipment_description: [
    'equipment_description', 'equipment description', 'equipment_desc',
    'equipment desc', 'equipment_text', 'equipment text',
    'eqktx', 'asset_description', 'asset description',
    'machine_description', 'machine description',
  ],
  failure_catalog_desc: [
    'failure_catalog_desc', 'failure catalog desc', 'failure_catalog',
    'failure catalog', 'catalog', 'catalog_desc',
    'object_class', 'object class', 'class', 'eqart', 'object_type',
  ],
  functional_location: [
    'functional_location', 'functional location', 'tplnr', 'func_location',
    'func location', 'floc', 'func_loc', 'fl', 'location_code',
    'plant_section',
  ],
  functional_location_description: [
    'functional_location_description', 'functional location description',
    'fl_description', 'fl description', 'floc_description', 'floc description',
    'tplnr_text', 'pltxt', 'location_description', 'location description',
  ],
  object_part_code_description: [
    'object_part_code_description', 'object part code description',
    'object_part', 'object part', 'object_part_desc', 'object part desc',
    'oteil', 'oteil_text', 'part_description', 'component', 'component_description',
  ],
  damage_code_description: [
    'damage_code_description', 'damage code description',
    'damage_code', 'damage code', 'damage', 'damage_desc',
    'fecod', 'fecod_text', 'defect_description', 'defect description',
    'failure_description',
  ],
  cause_code_description: [
    'cause_code_description', 'cause code description', 'cause_code',
    'cause code', 'cause', 'cause_desc', 'ursco', 'ursco_text',
    'root_cause', 'root cause', 'reason', 'reason_description',
  ],
  operation_description: [
    'operation_description', 'operation description', 'operation',
    'operation_text', 'operation text', 'ltxa1', 'activity',
    'activity_description', 'task_description', 'op_description',
  ],
  confirmation_text: [
    'confirmation_text', 'confirmation text', 'conf_text', 'conf text',
    'short_text_conf', 'work_done', 'work done', 'work_performed',
    'technician_remarks', 'technician_notes', 'execution_text',
  ],
  confirmation_long_text: [
    'confirmation_long_text', 'confirmation long text', 'long_text',
    'long text', 'ltxa2', 'conf_long_text', 'detailed_text',
    'detailed text', 'remarks', 'notes', 'additional_text',
    'extended_description',
  ],
  code_group: [
    'code_group', 'code group', 'codegruppe', 'qpgr', 'qpcd',
    'scoping_text', 'scoping text', 'scoping_template', 'scoping',
    'scope_text', 'scope template', 'description_template',
  ],
};

// ─────────────────────────────────────────────
// COLUMN CATEGORIES
// ─────────────────────────────────────────────
export const IDENTIFIER_COLUMNS: CanonicalColumn[] = [
  'work_order_number',
  'equipment',
  'functional_location',
];

export const TIMESTAMP_COLUMNS: CanonicalColumn[] = [
  'notification_date',
];

export const TEXT_COLUMNS: CanonicalColumn[] = [
  'work_order_description',
  'equipment_description',
  'failure_catalog_desc',
  'functional_location_description',
  'object_part_code_description',
  'damage_code_description',
  'cause_code_description',
  'operation_description',
  'confirmation_text',
  'confirmation_long_text',
  'code_group',
];

/** Description-form code columns used for catalog validation and triangle checks. */
export const CODE_DESCRIPTION_COLUMNS: CanonicalColumn[] = [
  'failure_catalog_desc',
  'object_part_code_description',
  'damage_code_description',
  'cause_code_description',
];

// ─────────────────────────────────────────────
// VALIDATION REQUIREMENTS
// ─────────────────────────────────────────────
export const REQUIRED_COLUMNS: CanonicalColumn[] = [
  'work_order_number',
  'work_order_description',
];

/** At least one of these timestamps must be mapped (currently only one). */
export const REQUIRED_EITHER_TIMESTAMPS: CanonicalColumn[] = [
  'notification_date',
];

/** At least one of these text fields must be mapped for AI triangle checks. */
export const REQUIRED_EITHER_TEXT: CanonicalColumn[] = [
  'work_order_description',
  'confirmation_text',
];

/** Non-required but strongly recommended for catalog validation. */
export const RECOMMENDED_FOR_CATALOG: CanonicalColumn[] = [
  'failure_catalog_desc',
  'object_part_code_description',
  'damage_code_description',
  'cause_code_description',
];

// ─────────────────────────────────────────────
// GRANULARITY THRESHOLDS
// ─────────────────────────────────────────────
export const GRANULARITY = {
  WO_LEVEL_MAX: 1.2,
  MIXED_MAX: 3.0,
} as const;

// ─────────────────────────────────────────────
// AI PROVIDERS
// ─────────────────────────────────────────────
export const AI_PROVIDERS = {
  gemini:     { name: 'Google Gemini',     defaultModel: 'gemini-2.0-flash' },
  openai:     { name: 'OpenAI',            defaultModel: 'gpt-4o-mini' },
  anthropic:  { name: 'Anthropic Claude',  defaultModel: 'claude-sonnet-4-6' },
  azure:      { name: 'Azure OpenAI',      defaultModel: '' },
  openrouter: { name: 'OpenRouter',        defaultModel: '' },
  copilot:    { name: 'Microsoft Copilot', defaultModel: '' },
} as const;

// ─────────────────────────────────────────────
// CANONICAL COLUMN DISPLAY LABELS
// ─────────────────────────────────────────────
export const COLUMN_LABELS: Record<CanonicalColumn, string> = {
  work_order_number:               'Work Order Number',
  notification_date:               'Date',
  work_order_description:          'Description',
  work_center:                     'Work Center',
  work_center_description:         'Work Center Description',
  equipment:                       'Equipment',
  equipment_description:           'Equipment Description',
  failure_catalog_desc:            'Failure Catalog',
  functional_location:             'Functional Location',
  functional_location_description: 'Functional Location Description',
  object_part_code_description:    'Object Part',
  damage_code_description:         'Damage Code',
  cause_code_description:          'Cause Code',
  operation_description:           'Operation Description',
  confirmation_text:               'Confirmation Text',
  confirmation_long_text:          'Confirmation Long Text',
  code_group:                      'Code Group (Scoping Template)',
};

// ─────────────────────────────────────────────
// FAILURE CATALOG STORAGE KEYS
// ─────────────────────────────────────────────
export const STORAGE_KEYS = {
  STORE: 'sap-auditor-v2',
  LEGACY_STORE: 'sap-auditor-v1',
  FAILURE_CATALOG_USER: 'auditor_failure_catalog_active',
} as const;
