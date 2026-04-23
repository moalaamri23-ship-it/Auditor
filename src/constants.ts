import type { CanonicalColumn } from './types';

// ─────────────────────────────────────────────
// SAP PM COLUMN KEYWORD MAP
// Scoring-based detection: higher-specificity keywords score higher
// ─────────────────────────────────────────────
export const SAP_COLUMN_KEYWORDS: Record<CanonicalColumn, string[]> = {
  work_order_number: [
    'aufnr', 'work_order_number', 'work order number', 'work_order', 'work order',
    'wo_number', 'wo number', 'wo_no', 'wo no', 'wo#', 'workorder',
    'maint_order', 'maintenance_order', 'order_number', 'order number', 'order_no', 'order no',
  ],
  notification_number: [
    'qmnum', 'notification_number', 'notification number', 'notification_no', 'notification no',
    'notif_number', 'notif number', 'notif_no', 'notif', 'notification', 'qmel',
    'defect_no', 'defect no',
  ],
  equipment: [
    'equnr', 'equipment_number', 'equipment number', 'equipment_no', 'equipment no',
    'equipment', 'asset_number', 'asset number', 'asset_no', 'asset no', 'asset',
    'machine_no', 'machine no', 'device_no',
  ],
  functional_location: [
    'tplnr', 'functional_location', 'functional location', 'func_location', 'func location',
    'floc', 'func_loc', 'func loc', 'fl', 'location_code', 'plant_section',
  ],
  notification_date: [
    'notification_date', 'notification date', 'qmdat', 'notif_date', 'notif date',
    'report_date', 'report date', 'reported_date', 'reported date',
    'failure_date', 'failure date', 'breakdown_date', 'breakdown date',
    'malfunction_date', 'date_reported',
  ],
  scheduled_start_date: [
    'scheduled_start', 'scheduled start', 'sched_start', 'sched start',
    'planned_start', 'planned start', 'plan_start', 'plan start',
    'gstrp', 'basic_start', 'basic start', 'target_start', 'target start',
  ],
  actual_start_date: [
    'actual_start', 'actual start', 'act_start', 'act start',
    'isdd', 'istdd', 'execution_start', 'exec_start', 'start_date', 'start date',
    'work_start', 'work start',
  ],
  actual_finish_date: [
    'actual_finish', 'actual finish', 'act_finish', 'act finish',
    'iedd', 'ietdd', 'execution_finish', 'exec_finish',
    'finish_date', 'finish date', 'end_date', 'end date',
    'completion_date', 'completion date', 'closed_date', 'closed date', 'work_end',
  ],
  confirmation_date: [
    'confirmation_date', 'confirmation date', 'conf_date', 'conf date',
    'budat', 'bldat', 'posting_date', 'posting date', 'entry_date', 'entry date',
  ],
  notification_description: [
    'notification_description', 'notification description', 'notif_description', 'notif description',
    'qmtxt', 'problem_text', 'problem text', 'fault_description', 'fault description',
    'notif_text', 'notif text', 'breakdown_description', 'breakdown description',
    'symptom', 'malfunction_description',
  ],
  work_order_description: [
    'work_order_description', 'work order description', 'wo_description', 'wo description',
    'ktext', 'order_description', 'order description', 'wo_text', 'wo text',
    'order_text', 'order text', 'work_description', 'work description',
  ],
  confirmation_text: [
    'confirmation_text', 'confirmation text', 'conf_text', 'conf text',
    'ltxa1', 'short_text_conf', 'activity_text', 'activity text',
    'work_done', 'work done', 'work_performed', 'work performed',
    'technician_remarks', 'technician_notes', 'execution_text',
  ],
  confirmation_long_text: [
    'confirmation_long_text', 'confirmation long text', 'long_text', 'long text',
    'ltxa2', 'conf_long_text', 'detailed_text', 'detailed text',
    'remarks', 'notes', 'additional_text', 'extended_description',
  ],
  reliability_code_1: [
    'reliability_code_1', 'code_group_1', 'qmcod', 'object_part', 'obj_part',
    'component_code', 'item_code', 'oteil', 'part_code', 'obj_code',
  ],
  reliability_code_2: [
    'reliability_code_2', 'code_group_2', 'damage_code', 'fecod',
    'defect_code', 'failure_code', 'symptom_code', 'damage', 'defect',
  ],
  reliability_code_3: [
    'reliability_code_3', 'code_group_3', 'cause_code', 'ursco',
    'root_cause_code', 'reason_code', 'urscd',
  ],
  failure_mode: [
    'failure_mode', 'failure mode', 'fail_mode', 'fail mode',
    'mode_of_failure', 'mode of failure', 'failure_type', 'failure type',
  ],
  cause_code: [
    'cause_code', 'cause code', 'root_cause', 'root cause',
    'cause', 'failure_cause', 'failure cause',
  ],
  notification_status: [
    'notification_status', 'notification status', 'notif_status', 'notif status',
    'qmsta', 'notif_state',
  ],
  work_order_status: [
    'work_order_status', 'work order status', 'wo_status', 'wo status',
    'order_status', 'order status', 'stat', 'status', 'order_state',
  ],
  system_status: [
    'system_status', 'system status', 'sstat', 'sys_status', 'sys status',
    'sap_status', 'internal_status',
  ],
  user_status: [
    'user_status', 'user status', 'ustat', 'usr_status', 'usr status',
    'custom_status', 'external_status',
  ],
};

// ─────────────────────────────────────────────
// COLUMN CATEGORIES
// ─────────────────────────────────────────────
export const IDENTIFIER_COLUMNS: CanonicalColumn[] = [
  'work_order_number',
  'notification_number',
  'equipment',
  'functional_location',
];

export const TIMESTAMP_COLUMNS: CanonicalColumn[] = [
  'notification_date',
  'scheduled_start_date',
  'actual_start_date',
  'actual_finish_date',
  'confirmation_date',
];

export const TEXT_COLUMNS: CanonicalColumn[] = [
  'notification_description',
  'work_order_description',
  'confirmation_text',
  'confirmation_long_text',
];

export const RELIABILITY_CODE_COLUMNS: CanonicalColumn[] = [
  'reliability_code_1',
  'reliability_code_2',
  'reliability_code_3',
  'failure_mode',
  'cause_code',
];

export const STATUS_COLUMNS: CanonicalColumn[] = [
  'notification_status',
  'work_order_status',
  'system_status',
  'user_status',
];

// ─────────────────────────────────────────────
// VALIDATION REQUIREMENTS
// ─────────────────────────────────────────────
export const REQUIRED_COLUMNS: CanonicalColumn[] = ['work_order_number'];

export const REQUIRED_EITHER_TIMESTAMPS: CanonicalColumn[] = [
  'notification_date',
  'scheduled_start_date',
  'actual_start_date',
  'actual_finish_date',
  'confirmation_date',
];

export const REQUIRED_EITHER_TEXT: CanonicalColumn[] = [
  'notification_description',
  'work_order_description',
  'confirmation_text',
];

// ─────────────────────────────────────────────
// GRANULARITY THRESHOLDS
// ─────────────────────────────────────────────
export const GRANULARITY = {
  WO_LEVEL_MAX: 1.2,   // below this: rows ≈ WOs
  MIXED_MAX: 3.0,      // below this: mild confirmation expansion
  // above 3.0: heavy expansion — always use v_wo_primary for counts
} as const;

// ─────────────────────────────────────────────
// AI PROVIDERS
// ─────────────────────────────────────────────
export const AI_PROVIDERS = {
  gemini:     { name: 'Google Gemini',    defaultModel: 'gemini-2.0-flash' },
  openai:     { name: 'OpenAI',           defaultModel: 'gpt-4o-mini' },
  anthropic:  { name: 'Anthropic Claude', defaultModel: 'claude-sonnet-4-6' },
  azure:      { name: 'Azure OpenAI',     defaultModel: '' },
  openrouter: { name: 'OpenRouter',       defaultModel: '' },
  copilot:    { name: 'Microsoft Copilot', defaultModel: '' },
} as const;

// ─────────────────────────────────────────────
// CANONICAL COLUMN DISPLAY LABELS
// ─────────────────────────────────────────────
export const COLUMN_LABELS: Record<CanonicalColumn, string> = {
  work_order_number:         'Work Order Number',
  notification_number:       'Notification Number',
  equipment:                 'Equipment',
  functional_location:       'Functional Location',
  notification_date:         'Notification Date',
  scheduled_start_date:      'Scheduled Start Date',
  actual_start_date:         'Actual Start Date',
  actual_finish_date:        'Actual Finish Date',
  confirmation_date:         'Confirmation Date',
  notification_description:  'Notification Description',
  work_order_description:    'Work Order Description',
  confirmation_text:         'Confirmation Text',
  confirmation_long_text:    'Confirmation Long Text',
  reliability_code_1:        'Reliability Code 1',
  reliability_code_2:        'Reliability Code 2',
  reliability_code_3:        'Reliability Code 3',
  failure_mode:              'Failure Mode',
  cause_code:                'Cause Code',
  notification_status:       'Notification Status',
  work_order_status:         'Work Order Status',
  system_status:             'System Status',
  user_status:               'User Status',
};
