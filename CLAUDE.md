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
| SQL engine | DuckDB WASM (in-browser, CDN bundles via `getJsDelivrBundles()`) |
| File parsing | PapaParse (CSV) + XLSX (Excel) |
| Charts | Recharts (Phase 2+) |

### The Hard Rule

**DuckDB handles all calculations. AI only receives aggregated summaries.**

- Every metric (counts, rates, durations, MTBF, MTTR) comes from DuckDB SQL
- AI never sees raw rows — only `{ aggregates, anomaly_samples[], data_quality_flags }`
- If data quality score < 20 or sample count < 3 → return `INSUFFICIENT_DATA`, never call AI

### Data Flow

```
Upload → FileParser → SchemaDetector → ValidationService → Zustand session
→ ParsedDataCache (temp rows) → DuckDB load → runProfiling → DataProfiler screen
```

### DuckDB View Hierarchy

Three views are created after every load. All analysis queries MUST use the correct view:

| View | Logic | Use for |
|---|---|---|
| `v_wo_primary` | One row per WO (`_row_seq = 1`) | WO counts, MTBF, MTTR, failure rates |
| `v_confirmations` | Rows with non-empty `confirmation_text` | Text analysis, confirmation quality |
| `audit` | Full typed table (all rows) | Raw exploration only |

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
├── types.ts                    # All TypeScript interfaces (CanonicalColumn, Session, DataProfile…)
├── constants.ts                # SAP_COLUMN_KEYWORDS, GRANULARITY thresholds, AI_PROVIDERS
├── store/useStore.ts           # Zustand store (sessions, activeSessionId, aiConfig, screen)
├── services/
│   ├── FileParser.ts           # PapaParse + XLSX → ParsedFile
│   ├── SchemaDetector.ts       # Keyword-scoring column mapping → ColumnMap
│   ├── ValidationService.ts    # Structural validation → ValidationReport
│   ├── ParsedDataCache.ts      # Temp in-memory cache for raw rows (cleared after DuckDB load)
│   └── DuckDBService.ts        # DuckDB WASM init, loadData(), runProfiling(), query()
└── components/
    ├── Icon.tsx                # Custom SVG icon system (canonical from reliability_app_UI)
    ├── Header.tsx              # App header with tabs + AI config panel
    ├── SessionsDashboard.tsx   # Sessions grid + new session CTA
    ├── UploadZone.tsx          # Drag-and-drop + parse + validate + navigate to SchemaMapper
    ├── SchemaMapper.tsx        # Column mapping confirmation → DuckDB load → navigate to profiler
    └── DataProfiler.tsx        # Profile results: stat cards, column health table, validation accordion
```

### Session Lifecycle

```
Session.stage: 'uploaded' → 'mapped' → 'profiled' → 'analysed'
Session.hasDataInDuckDB: false (reset on page refresh — DuckDB is in-memory)
```

If `hasDataInDuckDB = false` on an existing session, the user must re-upload the file (ParsedDataCache is also cleared). The session metadata (column map, profile, validation) is preserved in localStorage.

### Column Mapping

`SchemaDetector.ts` scores each raw header against `SAP_COLUMN_KEYWORDS` (keyword lists per canonical column). Score ≥ 40 → mapped; score ≥ 80 → HIGH confidence. Priority columns claim headers first (work_order_number, equipment, timestamps).

### UI Design System

Follows `reliability_app_UI.md` exactly:
- `slate-900` header, `slate-50` body, `brand-500/600` accent
- Inter (sans) + JetBrains Mono (mono) fonts
- Custom `<Icon>` component — no third-party icon lib
- `merged-table`, `animate-enter`, `scroll-thin` CSS classes in index.html
- Floating chatbot (right half-circle) — Phase 3

### Analysis Modules (Phase 2+)

9 planned modules, all SQL-first:
1. Data Integrity Audit
2. Reliability Analysis (MTBF/MTTR — demoted to supporting signal, explains why it may be unreliable)
3. Process Compliance
4. Failure Pattern Detection
5. Repetitive Failure Analysis
6. Hidden Downtime Detection
7. Confirmation Quality Scoring
8. Reliability Maturity Scoring
9. Anomaly Ranking

The report does not just present metrics — it **audits the conditions** required for each metric to be valid and explains why MTBF/MTTR may be unreliable based on the actual data quality findings.

### Template System (Phase 2+)

Named templates store: column mapping + filters + modules to run + report structure. User selects template → drops new export → hits Run → full analysis executes automatically.

### Real Data File

When the user provides an actual SAP PM export, use it to:
1. Adjust `SAP_COLUMN_KEYWORDS` in `constants.ts` to match real column names
2. Verify granularity assumptions
3. Identify real data patterns (date formats, status codes, reliability code usage)
