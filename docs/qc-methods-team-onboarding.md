# gnomAD Browser Lite — QC validity checks: onboarding

How to add a federation QC validity check to `gbl qc`.

A check is authored by describing it to the `qc-validity-builder` Claude Code skill,
which generates a Rust diff (a check module, a registry entry, a unit test, and a
fixture entry where needed). You review the diff; the Rust is not written by hand.

## Prerequisites

| Tool | Used for |
|------|----------|
| Rust (stable) | builds the `gbl` backend binary |
| sccache | caches Rust build artifacts so rebuilds are fast (`cargo install sccache`) |
| DuckDB library | the binary links it at build time (`brew install duckdb`) |
| Node 20.19+ / 22.12+ and pnpm | frontend and the `/qc` page |
| `uv` | runs the fixture verifier `run_checks.py` |
| Claude Code | drives the check-authoring skill |

The default backend is the public gnomAD Hail tables on GCS, so the full gene browser
(§5) needs gcloud ADC; building checks and viewing `/qc` do not.

## 0. Clone the three sibling repos

The backend and frontend reference two sibling repos by path, so clone all three
into one parent directory:

```bash
mkdir genohype-eco && cd genohype-eco
git clone ssh://git@github.com/broadinstitute/gnomad-browser-lite.git
git clone ssh://git@github.com/broadinstitute/genohype.git
git clone ssh://git@github.com/mattsolo1/fastVEP.git
(cd fastVEP && git checkout genohype-integration)
```

Use `mattsolo1/fastVEP` on `genohype-integration`: the upstream default branch lacks
the `fastvep-loftee` crate that Cargo resolves (it is an optional dependency, resolved
even with the `vep` feature off). Resulting layout:

```
genohype-eco/
  gnomad-browser-lite/   ← build here
  genohype/              main
  fastVEP/               genohype-integration
```

`./scripts/setup.sh` verifies these are present and prints the clone commands if not.

## 1. Build the assistant-ui package

`@genohype/assistant-ui` ships source-only; build it before installing the frontend:

```bash
(cd genohype/ui && npm install && npm run build -w @genohype/assistant-ui)
cd gnomad-browser-lite && pnpm install
```

## 2. Build and test the backend

```bash
cd backend
cargo build --release
cargo test qc
```

The binary links DuckDB (a legacy backend) at build time, so a DuckDB library must be
present — `brew install duckdb`, or add `--features bundled` to compile it from source
if you have none. The build uses sccache as its committed rustc wrapper
(`backend/.cargo/config.toml`), so install it (see Prerequisites). To build without it,
prefix each cargo command with `CARGO_BUILD_RUSTC_WRAPPER=""`.

The binary is `backend/target/release/backend`, packaged as `gbl`. Alias it so the
fixture verifier (which calls `gbl`) resolves it:

```bash
alias gbl="$PWD/target/release/backend"
```

## 3. Run the checks against the fixtures

```bash
gbl qc list
gbl qc run examples/federation/partner-broken.vcf.bgz --out report.json
(cd examples/federation && uv run run_checks.py)
```

`run_checks.py` prints `SKIP (not implemented yet)` for any check a defect targets that
is not registered. Registering a check turns its line into a PASS/FAIL/WARN result.

## Data model: checks read flat sites-VCF INFO

- The fixtures are sites-only VCFs. Per-stratum counts are flat `info` fields — `AC`,
  `AN`, `nhomalt`, `AC_<suffix>`, etc. Read them with `get_field(row, "info")`; most
  checks declare `needs: &[]`.
- Read `AC`/`AN`/`nhomalt` counts with `util::count_value`, not `as_i32`. A `Number=A`
  field (`AC`) is a one-element array that `as_i32` returns `None` for, which makes a
  check pass without flagging anything.
- The `freq` / `freq_meta` / `freq_index_dict` model in the spec is the future
  Hail-native path; a check written against it finds nothing in the fixtures.

## 4. Add a check

1. Read [`docs/spec/qc/README.md`](spec/qc/README.md) for the tiers (Tier 1 → FAIL,
   Tier 2 → WARN, Tier 3 → deferred) and
   [`docs/spec/qc/02-tier1-checks.md`](spec/qc/02-tier1-checks.md) for the first bundle.
   Formulas are catalogued in
   [`skills/qc-validity-builder/references/check-catalog.md`](../skills/qc-validity-builder/references/check-catalog.md).
2. Check [`examples/federation/defects.json`](../examples/federation/). If a defect
   already trips your check, reuse it; add one only if none does.
3. Invoke the `qc-validity-builder` skill and describe the check: what it detects, the
   per-row metric and how it combines, the threshold, and the upstream failure it
   fingerprints. Review the generated spec and diff — the formula and threshold need
   domain judgment.
4. Verify:
   ```bash
   cd backend
   cargo build --release
   cargo test qc
   ./target/release/backend qc list
   (cd ../examples/federation && uv run run_checks.py)
   ```

A newly registered check does not appear on `/qc`: the `/api/qc-report` endpoint is not
built, so the page renders a static sample report. Do not edit the sample report as part
of a check PR.

## 5. Open the report page

`/qc` reads `/api/qc-report` when available and otherwise a checked-in sample at
`frontend/public/sample-qc-report.json`. The endpoint is not built yet, so the page
shows the sample.

```bash
(cd frontend && pnpm dev)   # prints the URL, e.g. http://localhost:5173
```

Open the URL and select "QC Report" (route `/qc`).

For the full gene/variant browser, run `pnpm start` from the repo root. The default
backend queries public gnomAD Hail tables on GCS, so it needs gcloud ADC and binds its
port after 30 s–2 min:

```bash
gcloud auth application-default login
pnpm start   # open the VITE_PORT written to .env
```

## 6. Skills

| Skill | Function |
|-------|----------|
| [`qc-validity-builder`](../skills/qc-validity-builder/SKILL.md) | Generates a check (spec + Rust diff) from a description. |
| [`qc-validity-federation-user`](../skills/qc-validity-federation-user/SKILL.md) | Runs the checks on a submission and maps the report to a likely cause + accept/investigate/reject recommendation. |

For sites files too large for one machine, both defer the scan to the `gh-cluster` and
`pool-analyzer` skills.

## Conventions and current limits

- `report.json` and `.code_review/` are gitignored; do not commit them.
- A check PR touches only `gnomad-browser-lite`; keep sibling `Cargo.lock` changes out of it.
- One check = one PR.
- The `/api/qc-report` endpoint is not built; `/qc` renders the sample report.
- `qc.toml` threshold configuration is not implemented; thresholds are inlined as constants.
- Tier-3 cross-partner checks need ≥2 submitted reports and are deferred.
- `gbl qc` reads sites-only aggregates from flat VCF INFO; it does not read genotypes.

## Reference map

| Topic | File |
|-------|------|
| Problem statement, tiers, spec index | [`docs/spec/qc/README.md`](spec/qc/README.md) |
| Framework, report schema, check catalog | [`docs/spec/qc/00-design-reference.md`](spec/qc/00-design-reference.md) |
| Example Tier-2 check spec | [`docs/spec/qc/04-sfs.md`](spec/qc/04-sfs.md) |
| Fixtures, `defects.json`, the runner | [`docs/spec/qc/05-fixtures-and-testing.md`](spec/qc/05-fixtures-and-testing.md) |
| Shared helpers (`variant_id`, `count_value`) | [`backend/src/commands/qc/checks/util.rs`](../backend/src/commands/qc/checks/util.rs) |
| Framework: accumulator, registry, `CheckResult` | [`backend/src/commands/qc/framework.rs`](../backend/src/commands/qc/framework.rs) |
| Fixtures and defect manifest | [`examples/federation/`](../examples/federation/) |
| Report page | [`frontend/src/pages/QCReportPage.tsx`](../frontend/src/pages/QCReportPage.tsx) |
| Setup, backends, `gbl.toml`, ports | [`README.md`](../README.md), [`CLAUDE.md`](../CLAUDE.md) |
