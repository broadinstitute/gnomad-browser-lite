# gnomAD Browser Lite — QC validity checks: onboarding

Setup instructions for adding federation QC validity checks to `gbl qc`.

A check is authored by describing it in plain language to a Claude Code skill,
which generates a Rust diff (a check module, a registry entry, a unit test, and,
where needed, a fixture entry). The author reviews the diff before it is merged;
the Rust is not written by hand. This document covers cloning, building, running
the existing check against the test fixtures, opening the report page, and the
steps to add a check.

## Prerequisites

| Tool | Used for | Install |
|------|----------|---------|
| Rust (stable) | builds the `gbl` backend binary | https://rustup.rs |
| DuckDB system library | the binary links `libduckdb` | macOS: `brew install duckdb`; Linux: system package |
| Node 20.19+ / 22.12+ and pnpm | frontend and the `/qc` page | https://pnpm.io/installation |
| `uv` | runs the fixture verifier `run_checks.py` | https://docs.astral.sh/uv/ |
| Claude Code | drives the check-authoring skill | existing setup |
| gcloud ADC | only the full gene/variant browser (see §5) | `gcloud auth application-default login` |

Building checks and viewing the `/qc` page do not require gcloud or GCS access.
Only the full gene browser queries GCS.

## 1. Clone

```bash
git clone ssh://git@github.com/broadinstitute/gnomad-browser-lite.git
cd gnomad-browser-lite
pnpm install
```

## 2. Build and test the backend

`backend/.cargo/config.toml` sets `rustc-wrapper = "sccache"`. If sccache is not
installed, either install it (`cargo install sccache`) or unset the wrapper for
the build with the environment variable below.

```bash
cd backend
CARGO_BUILD_RUSTC_WRAPPER="" cargo build --release
CARGO_BUILD_RUSTC_WRAPPER="" cargo test qc
```

The binary is `backend/target/release/backend` (packaged as `gbl`; the skill and
the commands below refer to it as `gbl`). Optionally alias it:

```bash
alias gbl="$PWD/target/release/backend"
```

## 3. Run the existing check against the fixtures

From the repository root:

```bash
# Print the checks registered in the backend:
./backend/target/release/backend qc list

# Run the registered checks over the broken federation fixture:
./backend/target/release/backend qc run examples/federation/partner-broken.vcf.bgz --out report.json

# Compare both fixtures against the defect manifest:
cd examples/federation
GBL="../../backend/target/release/backend" uv run run_checks.py
```

Current state: one check, `fields.biallelic`, is implemented in the backend. The
frontend catalog lists 25 checks; the remaining 24 are unimplemented. `qc run`
therefore reports mostly PASS on the broken fixture, and `run_checks.py` prints
`SKIP (not implemented yet)` for the checks a defect targets but that do not yet
exist. Adding a check changes its `SKIP` line to a PASS/FAIL/WARN result and its
`/qc` card from "Not yet implemented" to a status badge.

## 4. Add a check

1. Read [`docs/spec/qc/README.md`](spec/qc/README.md) for the problem→fingerprint
   model and the three tiers (Tier 1: arithmetic/schema, reported as FAIL; Tier 2:
   population-genetics bands, reported as WARN; Tier 3: cross-partner, deferred).
2. Choose a check. The Tier-1 bundle is the first planned PR:
   [`docs/spec/qc/02-tier1-checks.md`](spec/qc/02-tier1-checks.md). Formulas and
   `gnomad_methods` references are catalogued in
   [`skills/qc-validity-builder/references/check-catalog.md`](../skills/qc-validity-builder/references/check-catalog.md).
3. In Claude Code, invoke the `qc-validity-builder` skill and describe the check:
   what it detects, the per-row metric and how it combines, the threshold, and the
   upstream QC failure it fingerprints. The skill writes a spec file and a Rust
   diff (a `CheckState` variant, a `registry()` entry, a unit-test fixture, and a
   defect entry in the broken fixture if the check needs one). Review the diff —
   the formula and threshold are the parts that require domain judgment.
4. Verify:
   ```bash
   cd backend && CARGO_BUILD_RUSTC_WRAPPER="" cargo test qc
   ./target/release/backend qc list
   cd ../examples/federation && GBL="../../backend/target/release/backend" uv run run_checks.py
   ```
   Refresh `/qc`; the check's card shows a status badge.

## 5. Open the report page

The `/qc` page reads a report from the backend endpoint `/api/qc-report` and
falls back to a checked-in sample report at `frontend/public/sample-qc-report.json`.
The frontend alone is enough to view it:

```bash
cd frontend
pnpm dev        # prints the URL, e.g. http://localhost:5173
```

Open the URL and select "QC Report" (route `/qc`). The page shows a stepper over
all 25 catalogued checks; implemented checks show a status badge, the rest show
"Not yet implemented".

To also run the gene/variant browser, use `pnpm start` from the repository root.
The default backend queries public gnomAD Hail tables on GCS, so it requires
gcloud ADC and binds its port after 30 s–2 min:

```bash
gcloud auth application-default login
pnpm start
# open the VITE_PORT printed in .env
```

Ports are written to `.env` on first run; run `cat .env` to confirm them.

## 6. Skills

| Skill | Function |
|-------|----------|
| [`qc-validity-builder`](../skills/qc-validity-builder/SKILL.md) | Generates a check (spec + Rust diff) from a plain-language description. |
| [`qc-validity-federation-user`](../skills/qc-validity-federation-user/SKILL.md) | Runs the checks on a sites-only submission and maps the report to a likely upstream cause and an accept/investigate/reject recommendation. |

For sites files too large for one machine, both skills defer the scan to the
`gh-cluster` and `pool-analyzer` skills.

## Limitations

- 24 of the 25 catalogued checks are unimplemented. The command, framework, one
  check, the report page, and the test fixtures exist; the check set does not.
- Threshold configuration (`qc.toml` / per-run bands) is not implemented.
  Thresholds are inlined as constants in each check.
- Tier-3 cross-partner checks require at least two submitted reports and are
  deferred; the UI lists them but the backend does not compute them.
- `gbl qc` reads sites-only aggregates (`AC`, `AN`, `nhomalt` by group and sex).
  It does not read genotypes and cannot re-run genotype-level QC.

## Reference map

| Topic | File |
|-------|------|
| Problem statement, tiers, spec index | [`docs/spec/qc/README.md`](spec/qc/README.md) |
| Architecture: framework, report schema, check catalog | [`docs/spec/qc/00-design-reference.md`](spec/qc/00-design-reference.md) |
| Example Tier-2 check spec | [`docs/spec/qc/04-sfs.md`](spec/qc/04-sfs.md) |
| Fixtures, `defects.json`, the runner | [`docs/spec/qc/05-fixtures-and-testing.md`](spec/qc/05-fixtures-and-testing.md) |
| The implemented check | [`backend/src/commands/qc/checks/biallelic.rs`](../backend/src/commands/qc/checks/biallelic.rs) |
| Framework: accumulator, registry, `CheckResult` | [`backend/src/commands/qc/framework.rs`](../backend/src/commands/qc/framework.rs) |
| Fixtures and defect manifest | [`examples/federation/`](../examples/federation/) |
| Report page | [`frontend/src/pages/QCReportPage.tsx`](../frontend/src/pages/QCReportPage.tsx) |
| Skills catalog | [`skills/README.md`](../skills/README.md) |
| Setup, backends, `gbl.toml`, ports | [`README.md`](../README.md), [`CLAUDE.md`](../CLAUDE.md) |
