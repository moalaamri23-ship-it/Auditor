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
| State | Zustand 5 + localStorage (key: `sap-auditor-v1`) |
| SQL engine | DuckDB WASM (in-browser, loaded via `getJsDelivrBundles()` from CDN) |
| File parsing | PapaParse (CSV) + XLSX (Excel) |
| Charts | Recharts (Phase 2+) |
| Virtualisation | `@tanstack/react-virtual` (WO Data View in IssueExplorer) |

### The Hard Rule

**DuckDB handles all calculations. AI only receives aggregated summaries.**

- Every metric (counts, rates, durations, MTBF, MTTR) comes from DuckDB SQL
- AI never sees raw rows — only `{ aggregates, anomaly_samples[], data_quality_flags }`
- If data quality score < 20 or sample count < 3 → return `INSUFFICIENT_DATA`, never call AI

### Data Flow

```
Upload → FileParser → SchemaDetector → ValidationService → Zustand session
→ ParsedDataCache (temp rows) → DuckDB load → runProfiling → DataProfiler screen
→ AnalysisEngine (DuckDB modules + AI triangle check) → AuditDashboard / AnalysisView
```

### DuckDB View Hierarchy

Three views are created after every load. All analysis queries MUST use the correct view:

| View | Logic | Use for |
|---|---|---|
| `v_wo_primary` | One row per WO (`_row_seq = 1`) | WO counts, MTBF, MTTR, failure rates |
| `v_confirmations` | Rows with non-empty `confirmation_text` | Text analysis, confirmation quality |
| `audit` | Full typed table (all rows) | Raw exploration only |
| `v_analysis_scope` | WOs with all three artefacts present | AI triangle check input |

**Never use `audit` for aggregations if the dataset is `CONFIRMATION_LEVEL` granularity.**

### Granularity Classification

Computed in `runProfiling` immediately after load:

| avg rows/WO | Classification | Action |
|---|---|---|
| < 1.2 | `WO_LEVEL` | Safe to count rows ≈ WOs |
| 1.2 – 3.0 | `MIXED` | Use `v_wo_primary` for counts |
| > 3.0 | `CONFIRMATION_LEVEL` | Always deduplicate, show banner |

### File Structure

```
src/
├── types.ts                      # All TypeScript interfaces
├── constants.ts                  # SAP_COLUMN_KEYWORDS, GRANULARITY thresholds, AI_PROVIDERS
├── store/
│   └── useStore.ts               # Zustand store (sessions, activeSessionId, aiConfig, screen)
├── services/
│   ├── FileParser.ts             # PapaParse + XLSX → ParsedFile
│   ├── SchemaDetector.ts         # Keyword-scoring column mapping → ColumnMap
│   ├── ValidationService.ts      # Structural validation → ValidationReport
│   ├── ParsedDataCache.ts        # Temp in-memory cache for raw rows (cleared after DuckDB load)
│   ├── DuckDBService.ts          # DuckDB WASM init, loadData(), runProfiling(), query(),
│   │                             #   ai_flags table management
│   └── AIService.ts              # Provider-agnostic AI calls, fetchModels(), TieredModels
├── analysis/
│   ├── analysisTypes.ts          # Shared types for analysis modules
│   ├── AnalysisEngine.ts         # Orchestrates all modules; accepts aiConfig + cancel support
│   ├── DataIntegrityModule.ts    # SQL-based data integrity checks
│   ├── ReliabilityModule.ts      # SQL-based MTBF/MTTR/availability
│   ├── ProcessModule.ts          # SQL-based process compliance
│   └── AITextModule.ts           # Triangle check: AI analysis of symptom/codes/closure
└── components/
    ├── Icon.tsx                  # Custom SVG icon system
    ├── ModelSelector.tsx         # Live model picker: search, tiers, favorites, My Models
    ├── Header.tsx                # App header with tabs + AI config panel
    ├── SessionsDashboard.tsx     # Sessions grid + new session CTA
    ├── UploadZone.tsx            # Drag-and-drop + parse + validate → SchemaMapper
    ├── SchemaMapper.tsx          # Column mapping confirmation → DuckDB load → DataProfiler
    ├── DataProfiler.tsx          # Profile results + AI analysis trigger + progress/cancel
    ├── AuditDashboard.tsx        # Summary dashboard: stat cards, AI flag summary, re-run
    ├── AnalysisView.tsx          # Per-module deep-dive + AIFlagsPanel (triangle check results)
    ├── IssueExplorer.tsx         # WO Data View (virtualised) + DuckDB Issues tabs
    ├── FilterPanel.tsx           # Shared filter controls
    ├── AIInsightsPanel.tsx       # AI insights sidebar
    └── SettingsScreen.tsx        # AI provider/model/key config with live model fetching
```

### Session Lifecycle

```
Session.stage: 'uploaded' → 'mapped' → 'profiled' → 'analysed'
Session.hasDataInDuckDB: false (reset on page refresh — DuckDB is in-memory)
```

If `hasDataInDuckDB = false` on an existing session, the user must re-upload the file. Session metadata (column map, profile, validation, aiFlags) is preserved in localStorage.

### AI Triangle Check

`AITextModule.ts` evaluates every WO against three SAP PM artefacts:

| Artefact | SAP field |
|---|---|
| Symptom | `notification_description` / `work_order_description` |
| Classification | `reliability_code_1/2/3`, `failure_mode`, `cause_code` |
| Closure | `confirmation_text` / `confirmation_long_text` |

Six flag categories — 3 clash checks + 3 quality checks:

| Category | Type |
|---|---|
| `symptom_code_conflict` | Clash |
| `symptom_closure_conflict` | Clash |
| `code_closure_conflict` | Clash |
| `incomplete_classification` | Quality |
| `poor_closure` | Quality |
| `generic_symptom` | Quality |

Flags are persisted in `session.aiFlags[]` (localStorage) and in the DuckDB `ai_flags` table. Batched 20 WOs/call with cancel support. Restored from session on re-upload via `restoreAIFlagsFromSession()`.

### AI Settings (ModelSelector)

`ModelSelector.tsx` implements the full skill spec:
- **Live model fetching** — calls provider APIs on key entry, 24h TTL cache in localStorage
- **Tiers** — Pro (purple) / Balanced (brand) / Efficient (green), auto-classified by model ID keywords
- **Favorites** — up to 4 per provider, amber tier, persisted as `auditor_fav_${provider}`
- **My Models** — persistent list for OpenRouter (`allowCustomList={true}`), violet tier, persisted as `auditor_user_models_${provider}`
- **Fallback** — static list shown when live fetch hasn't run or fails

### Column Mapping

`SchemaDetector.ts` scores each raw header against `SAP_COLUMN_KEYWORDS` (keyword lists per canonical column). Score ≥ 40 → mapped; score ≥ 80 → HIGH confidence. Priority columns claim headers first (work_order_number, equipment, timestamps).

### UI Design System

Follows `reliability_app_UI` skill exactly:
- `slate-900` header, `slate-50` body, `brand-500/600` accent
- Inter (sans) + JetBrains Mono (mono) fonts
- Custom `<Icon>` component — no third-party icon lib
- `merged-table`, `animate-enter`, `scroll-thin` CSS classes in index.html
- Floating chatbot (right half-circle) — Phase 3

### Analysis Modules

All SQL-first via `AnalysisEngine.ts`:
1. Data Integrity Audit
2. Reliability Analysis (MTBF/MTTR — with validity caveats based on data quality)
3. Process Compliance
4. Failure Pattern Detection
5. Repetitive Failure Analysis
6. Hidden Downtime Detection
7. Confirmation Quality Scoring
8. Reliability Maturity Scoring
9. Anomaly Ranking
10. AI Triangle Check (text-based, runs after DuckDB modules if API key present)

The report audits the **conditions** required for each metric to be valid — it does not just present numbers.
