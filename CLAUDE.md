# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server at http://localhost:5173
npm run build    # TypeScript check + Vite production build
npm run preview  # Serve the production build locally
```

## Architecture

**AI Reliability Auditor — Single-Table Mode**

Accepts a single denormalized SAP PM export (Excel/CSV) and produces an engineer-grade reliability audit. Fully client-side — no backend, no server. Deploy target: Cloudflare Pages.

### Tech Stack

| Layer | Choice |
|---|---|
| Framework | React 19 + TypeScript 5 + Vite 6 |
| Styling | Tailwind CSS via CDN (in index.html) — no PostCSS/npm package |
| State | Zustand 5 + localStorage (key: `sap-auditor-v2`) |
| SQL engine | DuckDB WASM (in-browser, loaded via `getJsDelivrBundles()` from CDN) |
| File parsing | PapaParse (CSV) + XLSX (Excel) |
| Charts | Recharts |

### The Hard Rule

**DuckDB handles all calculations. AI only receives aggregated summaries.**

- Every metric (counts, rates, MTBF, MTTR) comes from DuckDB SQL
- AI never sees raw rows — only `{ aggregates, anomaly_samples[], data_quality_flags }`
- If data quality score < 20 or sample count < 3 → return `INSUFFICIENT_DATA`, never call AI

### Data Flow

```
Upload → FileParser → SchemaDetector → ValidationService → Zustand session
→ ParsedDataCache (temp rows) → DuckDB load → runProfiling → DataProfiler screen
→ SchemaMapper (period-based auto date filters applied here)
→ AnalysisEngine (RuleChecksModule + AITextModule) → AuditDashboard / IssueExplorer
```

### DuckDB View Hierarchy

Four views/tables are created after every load. All analysis queries MUST use the correct view:

| View | Logic | Use for |
|---|---|---|
| `v_wo_primary` | One row per WO (`_row_seq = 1`) | WO counts, MTBF, MTTR, failure rates, filter options |
| `v_confirmations` | Rows with non-empty `confirmation_text` | Text analysis, confirmation quality |
| `audit` | Full typed table (all rows) | Raw exploration (WO Data tab); AI analysis (all confirmation rows); `missing_confirmation` rule check |
| `v_analysis_scope` | Filtered subset of `v_wo_primary` | WO membership scope (rule checks + AI WO list); aggregations |
| `ai_flags` | Persisted AI flag results (includes `row_seq` for confirmation-row flags) | Dashboard charts, Issues AI tab |

**Never use `audit` for aggregations if the dataset is `CONFIRMATION_LEVEL` granularity.**

`v_analysis_scope` is rebuilt by `createAnalysisScopeView()` before every pipeline run and also called by `IssueExplorer` when the user adjusts filters on the Issues page. `getLiveScopeCount()` / `getCascadingFilterOptions()` query `v_wo_primary` directly without mutating the view. **Note:** `v_analysis_scope` is shared — navigating between Dashboard and Issues may leave it in the state set by whichever screen last called `createAnalysisScopeView()`; the pipeline always resets it before running.

### Granularity Classification

Computed in `runProfiling` immediately after load:

| avg rows/WO | Classification | Action |
|---|---|---|
| < 1.2 | `WO_LEVEL` | Safe to count rows ≈ WOs |
| 1.2 – 3.0 | `MIXED` | Use `v_wo_primary` for counts |
| > 3.0 | `CONFIRMATION_LEVEL` | Always deduplicate, show banner |

### Date Parsing

`_createTypedTable()` in `DuckDBService.ts` converts date columns using a `COALESCE` chain that handles:
- ISO `YYYY-MM-DD` (TRY_CAST)
- US short date `M/D/YYYY`
- European `D/M/YYYY`
- Dot-separated `D.M.YYYY`
- Slash `YYYY/MM/DD`
- Excel serial numbers (days since 1899-12-30)

Only columns listed in `TIMESTAMP_COLUMNS` (`src/constants.ts`) are treated as dates.

### File Structure

```
dashboard.html                    # Standalone Power Automate report attachment (see Reporting section)
src/
├── types.ts                      # All TypeScript interfaces (Screen, AuditProject, AuditRun,
│                                 #   AnalysisFilters, FilterOptions, AIFlag, etc.)
├── constants.ts                  # SAP_COLUMN_KEYWORDS, GRANULARITY thresholds, AI_PROVIDERS,
│                                 #   TIMESTAMP_COLUMNS, TEXT_COLUMNS, IDENTIFIER_COLUMNS
├── store/
│   └── useStore.ts               # Zustand store: projects[], runs[], activeProjectId,
│                                 #   activeRunId, aiConfig, currentScreen, reportingEmails
│                                 #   aiConfig shape: { provider, apiKey, modelId,
│                                 #     reportingWebhookUrl, powerAutomateUrl }
│                                 #   reportingEmails: Record<workCenter, emailAddress>
├── hooks/
│   └── useRunAutoRestore.ts      # Restores DuckDB data for a run on mount if hasDataInDB=false;
│                                 #   used by AuditReportScreen and ReportingSettingsScreen
├── services/
│   ├── FileParser.ts             # PapaParse + XLSX → ParsedFile
│   ├── SchemaDetector.ts         # Keyword-scoring column mapping → ColumnMap
│   ├── ValidationService.ts      # Structural validation → ValidationReport
│   ├── ParsedDataCache.ts        # Temp in-memory cache for raw rows (cleared after DuckDB load)
│   ├── DuckDBService.ts          # DuckDB WASM init, loadData(), runProfiling(), query(),
│   │                             #   getFilterOptions(), getCascadingFilterOptions(),
│   │                             #   getLiveScopeCount(), createAnalysisScopeView(),
│   │                             #   ai_flags table management
│   ├── AIService.ts              # Provider-agnostic AI calls, fetchModels(), TieredModels
│   ├── IndexedDBService.ts       # IndexedDB persistence layer for large run data
│   └── FailureCatalogService.ts  # Loads bundled/user failure catalog into DuckDB
├── analysis/
│   ├── AnalysisEngine.ts         # Orchestrates pipeline: createAnalysisScopeView →
│   │                             #   runRuleChecks → runAITextModule
│   ├── RuleChecksModule.ts       # SQL-based pre-checks (7 rules); not_listed_codes only
│   │                             #   fires when catalogAvailable === true
│   └── AITextModule.ts           # AI semantic audit: 6 flag categories, batched 20 WOs/call,
│                                 #   conf_long used to verify before flagging
└── components/
    ├── Icon.tsx                  # Custom SVG icon system (no third-party icon lib)
    ├── ModelSelector.tsx         # Live model picker: search, tiers, favorites, My Models
    ├── Header.tsx                # App header with tabs + run selector + run delete
    ├── SessionsDashboard.tsx     # Project grid + new project CTA
    ├── ProjectHomeView.tsx       # Run list for the active project (View / Delete per run)
    ├── AuditInitWizard.tsx       # New project wizard: name, type, period, bank pattern
    ├── UploadZone.tsx            # Drag-and-drop + parse + validate → SchemaMapper
    ├── SchemaMapper.tsx          # Column mapping → DuckDB load → runProfiling →
    │                             #   auto date filter computation → DataProfiler
    ├── DataProfiler.tsx          # Profile results, auto-filter banner, live scope count,
    │                             #   cascading filter options, Run Pre-Checks trigger
    ├── DataViewScreen.tsx        # Raw WO data table view (scope-filtered)
    ├── PreChecksView.tsx         # Rule check results before AI analysis
    ├── AuditDashboard.tsx        # Summary dashboard: stat cards, charts, re-run,
    │                             #   live scope count + cascading filters,
    │                             #   Power BI-style cross-filter visual selection
    │                             #   (click any chart item to filter all other charts);
    │                             #   Top Equipment counts AI+Rule flags combined;
    │                             #   Layout: Error Distribution full-width, then Code Quality
    │                             #   and Overall Quality rings side-by-side below;
    │                             #   Clean WOs = totalWOs − |aiSet ∪ ruleSet| (matches Valid ring);
    │                             #   chartCache persists chart data for post-refresh display
    ├── ComparisonView.tsx        # Multi-run comparison charts
    ├── IssueExplorer.tsx         # Audit Scope filter panel (same as Dashboard) +
    │                             #   WO Data tab (full raw table, scope-filtered) +
    │                             #   Rule Flags tab (expandable rows, copyable WO IDs) +
    │                             #   AI Flags tab (one card per WO; WO-level fields shown once
    │                             #     at top of expanded group; per-flag rows show only comment,
    │                             #     operation desc, confirmation; "Row N" label per row flag)
    ├── FilterPanel.tsx           # Audit Scope filter controls:
    │                             #   Date / Work Center / Catalog / Func. Location / Equipment
    ├── AuditReportScreen.tsx     # Power Automate report distribution (see Reporting section)
    ├── ReportingSettingsScreen.tsx # Per-work-center email address assignment; queries
    │                             #   v_wo_primary for WC list, stores in reportingEmails
    └── SettingsScreen.tsx        # AI provider/model/key config + reportingWebhookUrl +
                                  #   powerAutomateUrl (Copilot) with live model fetching
```

### Project & Run Lifecycle

```
AuditProject  (persisted, 1:N → AuditRun)
  id, name, type (TOTAL | SINGLE_BANK), period (WEEKLY | BIWEEKLY | QUARTERLY | YEARLY)
  bankPattern (optional SAP LIKE pattern)

AuditRun.stage: 'init' → 'uploaded' → 'mapped' → 'profiled' → 'pre-checked' → 'analysed'
AuditRun.hasDataInDB: false on cold reload — DuckDB is in-memory, requires re-upload
```

Navigation: clicking a project card → `project-home` screen (run list) if runs exist, else `upload`. Project tabs (Data / Pre-Checks / Audit / Comparison / Issues) are visible when `run.stage` is `profiled`, `pre-checked`, or `analysed` — not gated on `hasDataInDB`, so stored results are viewable after refresh.

### Audit Scope Filters

`AnalysisFilters` shape (stored on each `AuditRun`):
```typescript
{ dateFrom, dateTo, workCenter[], functionalLocation[], failureCatalog[], equipment[] }
```

- Filters are applied by `createAnalysisScopeView()` to produce `v_analysis_scope`
- `getLiveScopeCount()` returns a live WO count for the current filter selection without mutating the view
- `getCascadingFilterOptions()` re-fetches each option list with all *other* active filters applied (faceted navigation); each component debounces filter changes at 250 ms
- On new run creation, `SchemaMapper` auto-computes `dateFrom` = previous run's `dateMax + 1 day`; falls back to last `<period>` of new data if no records exist beyond that date
- **IssueExplorer** maintains its own local filter state (initialized from `run.analysisFilters`). On change it calls `createAnalysisScopeView()` then builds a `scopeWoSet` (`Set<string>`) used to client-side-filter the WO Data rows, Rule Flags list, and AI Flags list. Filters on the Issues page are transient — they do not update `run.analysisFilters` in the store.

### AI Text Module

`AITextModule.ts` evaluates ALL WOs in scope in batches of 20. It queries the `audit` table (all rows) for WOs in `v_analysis_scope` and groups confirmation rows per WO. Each `WORecord` sent to AI has:

| Field | SAP column |
|---|---|
| `description` | `work_order_description` |
| `part / damage / cause` | `object_part_code_description`, `damage_code_description`, `cause_code_description` |
| `confirmations[]` | array of `{ row, conf, conf_long, operationDesc }` — one entry per confirmation row, ordered by `_row_seq` |
| `catalog_hint` | up to 40 valid tuples from `failure_catalog` for that WO's catalog |

The AI returns an optional `"row"` field in its response to identify which confirmation row has the issue. This is stored as `AIFlag.rowSeq` and displayed as "Row N" in the Issues AI Flags tab. `AIFlag.operationDesc` captures the `operation_description` for the flagged row and is stored in the `ai_flags` table (`operation_desc` column).

Six flag categories:

| Category | Row field | Notes |
|---|---|---|
| `desc_code_conflict` | omit | Description vs codes mismatch |
| `false_not_listed` | omit | "Not Listed" codes when catalog has a better match — only fires when `catalog_hint` is non-empty AND description implies a specific catalog entry |
| `desc_confirmation_mismatch` | include | Description vs one confirmation row mismatch; skipped if that row is blank |
| `desc_code_confirmation_misalign` | include | All three artefacts contradict for one confirmation row; skipped if that row is blank |
| `generic_description` | omit | Description is PRESENT but too vague — does NOT fire for empty/blank descriptions |
| `generic_confirmation` | include | One confirmation row is PRESENT but uninformative — only fires when BOTH `conf` and `conf_long` of that row are vague |

**AI prompt rule:** The AI must not flag empty fields or bare "Not Listed" codes — those are handled by `RuleChecksModule`. AI flags only populated fields that are misleading, vague, or inconsistent.

### Rule Checks (Pre-AI)

Run by `RuleChecksModule.ts` against `v_analysis_scope`:

| Rule | Condition |
|---|---|
| `missing_confirmation` | WO has ANY row in `audit` where both `confirmation_text` and `confirmation_long_text` are blank |
| `not_listed_codes` | Any code field starts with "Not Listed" — **skipped if `catalogAvailable === false`** |
| `missing_scoping_text` | `code_group` blank |
| `catalog_invalid_object_part` | Object part not in catalog for that failure_catalog_desc |
| `catalog_invalid_damage_for_part` | Damage not valid under that object part |
| `catalog_invalid_cause_for_damage` | Cause not valid under that damage |
| `catalog_missing_match` | Any of the four catalog fields blank |

Catalog checks (last 4) only run when `catalogAvailable === true`.

### Dashboard Cross-Filter (Visual Selection)

`AuditDashboard.tsx` holds a `visualSelection: { type, value } | null` state. Clicking any chart item sets it; clicking the same item again clears it. A "Clear visual filter" button in the header also resets it.

**Selection types and their effect on other charts:**

| Source chart | `type` | Target charts re-query via |
|---|---|---|
| Per Work Center bar | `workCenter` | `WHERE work_center = '${value}'` on `v_analysis_scope` |
| Top Equipment row | `equipment` | `WHERE equipment_description = '${value}'` on `v_analysis_scope` |
| Error Distribution bar | `flagCategory` | AI: `wo_number IN (SELECT … FROM ai_flags WHERE category = '${value}')` / Rule: in-memory WO list |
| Code Quality donut slice | `codeQualitySegment` | SQL condition matching the quality bucket (Valid / Not Listed / Missing / Invalid Hierarchy) |
| Overall Quality ring slice | `overallQualitySegment` | WO IN list derived from `run.aiFlags` and `run.ruleChecks.flaggedWOs` (no DB needed for the list itself) |

Source charts do not re-query — they show all their items with the selected one at full opacity and the rest dimmed to 25% (`fillOpacity` on Recharts `<Cell>`, `opacity` style on table rows). Target charts re-query in the same `useEffect` that watches `[run?.id, run?.hasDataInDB, run?.lastAnalysedAt, visualSelection]`.

**Error Distribution cross-filter:** When `visualSelection` is any type other than `flagCategory`, a separate `useEffect` queries `v_analysis_scope` for the matching WO set, then filters `run.aiFlags` and `run.ruleChecks.flaggedWOs` in-memory to recount per-category values shown in the chart.

The helper `buildVisualScopeWhere(sel, ruleChecks)` (module-level in `AuditDashboard.tsx`) returns the SQL WHERE string. For `overallQualitySegment`, the WHERE clause is computed inline in the `useEffect` from in-memory flag lists (not via the helper).

### Overall Quality Ring Chart

Displayed beside Code Quality Breakdown (both in a `lg:grid-cols-2` row below the full-width Error Distribution chart). Three mutually exclusive segments that sum to `ruleChecks.totalWOs`:

| Segment | Definition | Color |
|---|---|---|
| Valid | WOs with zero flags (no AI, no rule flags) | Green |
| Entry Quality | WOs with ≥1 AI flag (text/semantic quality issues) | Indigo |
| Missing Fields | WOs with rule flags only (no AI flags) | Amber |

Computed purely from `run.aiFlags` and `run.ruleChecks.flaggedWOs` — no DB query needed. Recomputed when `visualSelection` changes via the `filteredErrorDist` effect.

**Valid = Clean WOs invariant:** The "Valid" count in this ring equals the "Clean WOs" stat card. Both use `totalWOs − |aiSet ∪ ruleSet|` (true union, not max). `SummaryRow` receives `aiFlags: AIFlag[]` to compute the union correctly.

### Chart Cache (Post-Refresh Display)

`AuditRun.chartCache: ChartCache | null` (persisted to localStorage) stores precomputed chart data after each analysis run:

```typescript
interface ChartCache {
  perWorkCenter: Array<{ workCenter: string; total: number; flagged: number }>;
  topEquipment: Array<{ equipment: string; count: number }>;
  codeQuality: { valid: number; notListed: number; invalidHierarchy: number; missing: number } | null;
  overallQuality: { valid: number; entryQuality: number; missingFields: number; total: number } | null;
  computedAt: string;
}
```

When `run.hasDataInDB` is false (cold reload), `AuditDashboard` restores charts from `run.chartCache` instead of querying DuckDB. A banner informs the user that cross-filtering requires re-uploading the file. Cross-filtering is disabled when DB is not loaded. `_computeChartCache()` is called inside `rerun()` after analysis completes.

### AI Settings (ModelSelector)

`ModelSelector.tsx` implements the full skill spec:
- **Live model fetching** — calls provider APIs on key entry, 24h TTL cache in localStorage
- **Tiers** — Pro (purple) / Balanced (brand) / Efficient (green), auto-classified by model ID keywords
- **Favorites** — up to 4 per provider, amber tier, persisted as `auditor_fav_${provider}`
- **My Models** — persistent list for OpenRouter (`allowCustomList={true}`), violet tier, persisted as `auditor_user_models_${provider}`
- **Fallback** — static list shown when live fetch hasn't run or fails

### Column Mapping

`SchemaDetector.ts` scores each raw header against `SAP_COLUMN_KEYWORDS` (keyword lists per canonical column). Score ≥ 40 → mapped; score ≥ 80 → HIGH confidence. Priority columns claim headers first (`work_order_number`, `equipment`, timestamps).

### UI Design System

- `slate-900` header, `slate-50` body, `brand-500/600` accent
- Inter (sans) + JetBrains Mono (mono) fonts
- Custom `<Icon>` component — no third-party icon lib; available icons listed in `IconName` type in `Icon.tsx` (includes `copy`, `check`, `chevronDown/Up/Right/Left`, etc.)
- `animate-enter`, `scroll-thin` CSS classes defined in `index.html`

### Power Automate Reporting

`AuditReportScreen.tsx` drives a one-click email distribution flow per work center. It queries DuckDB for the WC list (with WO numbers via `STRING_AGG`), cross-references in-memory `run.aiFlags` and `run.ruleChecks.flaggedWOs` to compute per-WC flag distributions, then fires an HTTP POST to the configured Power Automate webhook URL.

**HTTP payload** (single JSON body, all values are strings):
```json
{
  "emailTo": "owner@example.com",
  "subject": "Reliability Audit Report — {Work Center Description}",
  "emailBody": "<pre style=\"white-space:pre-wrap;font-family:monospace;...\">...plain text...</pre>",
  "dashboardJson": "{...stringified dashboard payload...}"
}
```

`emailBody` is plain text wrapped in a `<pre>` tag so newlines survive HTML email rendering. `dashboardJson` is the stringified dashboard payload (see below).

**Power Automate side:** A "Send an email" action uses `triggerBody()?['emailBody']` as the HTML body. The `dashboard.html` attachment is built with:
```
replace(html_template_string, '##AUDIT_DATA##', triggerBody()?['dashboardJson'])
```

**`dashboard.html` injection point** — the entire JSON payload is injected between script tags:
```html
<script id="audit-data" type="application/json">##AUDIT_DATA##</script>
```
`DOMContentLoaded` parses this block and renders all charts (pure SVG, zero external deps).

**`buildDashboardPayload(wc: WorkCenterAuditData)`** returns:
```typescript
{
  project: { name, type, period },
  run: { periodLabel, fileName, lastAnalysedAt, analysisFilters },
  kpi: { totalWOs, ruleFlaggedWOs, aiFlaggedWOs, totalAIFlags, cleanWOs },
  errorDistribution: [{ key, label, value, type: 'Rule' | 'AI' }],
  codeQuality: null,           // pending: requires per-WC DuckDB query
  overallQuality: { valid, entryQuality, missingFields, total },
  perWorkCenter: [],           // empty for single-WC report
  topEquipment: [{ equipment, count }],  // derived from aiFlags for this WC's WOs
  issues: [{ woNumber, equipment, workCenter, description, codes, ruleFlags, aiFlags }]
}
```

**`WorkCenterAuditData` interface:**
```typescript
interface WorkCenterAuditData {
  workCenter: string;
  description: string;
  totalWOs: number;
  ruleFlagsCount: number;
  aiFlagsCount: number;
  ruleDistribution: Record<string, number>;   // ruleId → count
  aiDistribution: Record<string, number>;     // category → count
  woNumbers: string[];                        // from STRING_AGG in loadWorkCenters()
}
```

**`dashboard.html` charts** (all pure SVG, no libraries):
- Error Distribution: horizontal `<rect>` bars; amber `#f59e0b` for Rule, indigo `#6366f1` for AI
- Code Quality donut: `stroke-dasharray`/`stroke-dashoffset` circles, `<g transform="rotate(-90 cx cy)">` for 12 o'clock start, 3 px gap between segments
- Overall Quality donut: same technique; green/indigo/amber
- Per Work Center grouped bar: `<svg viewBox="0 0 W H" width="100%" height="${H}">` — explicit height prevents proportional scaling bug when SVG is stretched horizontally
- Top Equipment: flex rows with inline `<div style="width:X%">` bars

**Pending:** `codeQuality` per work center requires a dedicated DuckDB query (schema TBD by user).
