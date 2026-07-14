# 03 — The `/qc` report page (turbo-tax walking skeleton)

**Owner:** core team (frontend). **Depends on:** the report contract in `00` (not on any
particular check being done). Built as a **walking skeleton** — the whole flow visible, only
the schema step live. The executable build brief is rolling plan `72`.

## Purpose

Show the methods team the entire end-to-end validity-check flow **before** they write any
check, so their contribution target is concrete: *"your check turns grey card N green."*

## The rendering model (the important bit)

The page renders from the **union of a static catalog and the live report**:

- `frontend/src/qc/checkCatalog.ts` lists every check (id, name, tier, one-line description,
  intended plot). This drives the full flow even when a check has no result yet.
- For each catalog entry, find a matching `report.checks[].id`:
  - **found** → render real status + metric (+ plot when present),
  - **missing** → render a **"Not yet implemented"** card (grey `pending` badge) from the
    catalog description + intended plot name.

Adding a real check later is purely additive: a new `id` in `report.json` lights its card up
with **no page change**.

## Files

| File | Purpose |
|------|---------|
| `frontend/src/pages/QCReportPage.tsx` | Route `/qc`; fetch `/api/qc-report`; render stepper + sections |
| `frontend/src/components/qc/QCStepper.tsx` | Turbo-tax step rail: Tier 1 → 2 → 3 |
| `frontend/src/components/qc/QCCheckCard.tsx` | One check: badge, metric, expectation, expandable examples, or placeholder |
| `frontend/src/components/qc/StatusBadge.tsx` | pass=green / warn=amber / fail=red / pending=grey |
| `frontend/src/qc/checkCatalog.ts` | Static catalog driving placeholders |
| `frontend/src/api/types.ts` (add) | `QCReport`, `QCCheckResult`, `Plot`, `CheckStatus` |
| `frontend/src/api/client.ts` (add) | `getQCReport(): Promise<QCReport \| null>` |

Backend: `GET /api/qc-report` in `backend/src/main.rs` (beside `/api/config`, `/api/gene/...`).
Reads `[qc] report_path` from `gbl.toml`; 404 → the page shows the empty state. For the demo it
serves the checked-in sample report generated from `partner-broken.vcf.bgz`.

Reuse existing patterns: `QualityMetricsHistogram.tsx` (Visx bar), `ConstraintTable.tsx`
(table + badge), `api/client.ts` `fetchJson`, `BrandingContext.tsx`.

## Later (not this PR)

Per-check plot components (`SFSChart`, `ANByChromChart`, `AFConcordanceScatter`,
`VariantTypeBars`, `InbreedingHistogram`), a `ResponsiveChart` wrapper (port from
gnomad-bench), and PDF export (jspdf + svg2pdf.js). Each arrives with its check's spec.

## Acceptance criteria

See rolling plan `72` — the whole flow renders; the schema/fields step shows a real FAIL
against the broken fixture; every other check is a legible placeholder; adding a new result id
lights its card with no code change.
