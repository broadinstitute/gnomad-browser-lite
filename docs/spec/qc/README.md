# `gbl qc` — Federation validity checks

This directory is the **methods-team-facing** spec set for the `gbl qc` command and the `/qc`
report page: how a federation partner's sites-only submission is verified, and how to add a new
check **by describing it and reviewing a diff** rather than writing Rust from scratch.

## What problem this solves

Partners submit **sites-only** data — per-variant `AC`, `AN`, `nhomalt`, stratified by
genetic-ancestry group and sex karyotype. We never see individual genotypes. So we can't re-run
their QC; we can only inspect the aggregate statistics and ask *"does this look like the output
of a properly-QC'd cohort?"*

Every check reads either one variant record at a time or an aggregate accumulated over one
streaming pass — the same access pattern genohype already uses for `summary` and
`schema validate`. **No Hail required.**

## The mental model: problem → fingerprint

Each way an upstream pipeline goes wrong leaves a characteristic distortion in the aggregate
numbers. You detect the distortion and infer the cause:

| Upstream QC problem | Aggregate fingerprint (how we detect it) |
|---|---|
| No variant filtering | Low Ti/Tv, low known-variant %, inflated variant count |
| Sample contamination | Excess heterozygosity (inbreeding F ≪ 0), distorted SFS, elevated singletons |
| Relatives not removed | SFS distortion, excess doubletons, excess common variants |
| Ancestry mislabeling | AF concordance failure vs gnomAD |
| Sex misassignment | chrX/Y anomalies (e.g. homozygous-alt calls on chrY) |
| Coverage problems | Non-uniform AN, missing chromosomes |
| Pipeline misconfiguration | Wrong counts, unexpected contigs, missing fields |

## The three tiers

- **Tier 1 — Technical validity.** Things that are *mathematically guaranteed* if computed
  correctly (`AC ≤ AN`, `AF = AC/AN`, subgroups sum to global, `nhomalt ≤ AC/2`) plus schema
  (required fields, no retired terms, GRCh38 biallelic). A violation is a bug, not biology →
  **hard FAIL**.
- **Tier 2 — Biological plausibility.** Soft population-genetics expectations (Ti/Tv, SFS,
  inbreeding F, AN uniformity, AF concordance, chrX/Y). Depend on N and ancestry mix →
  **WARN**, with bands the methods team owns via `qc.toml`.
- **Tier 3 — Cross-partner.** Only once ≥2 nodes contribute (AF correlation, burden outliers,
  CMH batch-effect test). **Deferred** for now (sketched in the UI, not implemented).

## Spec index

| Spec | What | Who implements |
|------|------|----------------|
| [`00-design-reference.md`](00-design-reference.md) | North-star architecture: CLI, execution model, report schema, full check catalog | reference only |
| [`01-scaffold.md`](01-scaffold.md) | `gbl qc` command, accumulator framework, `report.json`, `gbl qc list`, one trivial check | core team (Rust) |
| [`02-tier1-checks.md`](02-tier1-checks.md) | All Tier-1 schema + arithmetic checks (bundled) | **methods team — first PR** |
| [`03-report-page.md`](03-report-page.md) | The `/qc` turbo-tax report page (walking skeleton) | core team (frontend) |
| [`04-sfs.md`](04-sfs.md) | **Exemplar Tier-2 check spec** — the template every new check follows | methods team (one PR each) |
| [`05-fixtures-and-testing.md`](05-fixtures-and-testing.md) | How checks are tested: the clean/broken fixtures, `defects.json`, the fixture runner, and how the test surface scales | reference + methods team |

Each Tier-2 check gets its **own** PR-sized spec modeled on `04-sfs.md`. Tier-1 checks are
bundled into one PR because they're tiny and share the schema validator.

## Add a check in ~30 minutes (onboarding)

1. **Set up** (see repo `README.md` / `CLAUDE.md`): `./scripts/setup.sh`, then `pnpm start`.
2. **See it work**: `gbl qc run examples/federation/partner-broken.vcf.bgz --out report.json`,
   open `/qc` — the broken fixture shows red/amber cells. The fixtures + the
   `examples/federation/defects.json` manifest (which defect trips which check) are described in
   [`05-fixtures-and-testing.md`](05-fixtures-and-testing.md).
3. **Add your check**: invoke the **`qc-validity-builder`** skill and describe the check in plain
   language (formula, threshold, which upstream failure it detects, plot type). It scaffolds a
   `CheckState` variant + registry entry + a unit-test fixture, and — if the check needs the
   broken fixture to exhibit its defect — a defect entry in `make_broken.py` + `defects.json`.
   You **review the diff**.
4. **Verify**: `cargo test`, then `uv run examples/federation/run_checks.py` (runs both fixtures
   and checks the result against the manifest), and refresh `/qc` — your check's card lights up.

The skills that drive this:
- **`qc-validity-federation-user`** — run the checks on a sites file and interpret the report.
- **`qc-validity-builder`** — scaffold a new check from a description.

See the [skills catalog](../../../skills/README.md) for the full "skill per pipeline step" map.

## Provenance

Derived from the methods-team QC document (the Tier 1/2/3 checks and the problem→detection
table). Thresholds trace to `gnomad_methods` (`assessment/validity_checks.py`,
`utils/annotations.py`, `assessment/summary_stats.py`).
