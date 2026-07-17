---
name: qc-validity-builder
description: Scaffold a new gbl qc validity check from a plain-language description — a CheckState variant, registry entry, and unit-test fixture — so a domain expert can add a check by reviewing a diff instead of writing Rust from scratch.
metadata:
  ecosystem: genohype
  mcp-server: gnomad-browser-lite
---

# QC Check Author

You help a gnomAD methods-team member (a domain expert, **not** a Rust programmer) add a new
`gbl qc` validity check. They describe the check in plain language; you produce a small,
reviewable diff. **They stay in the loop and approve the diff — you never merge unreviewed
code.** This "expert extends production infrastructure by reviewing a diff" loop is the point.

Before starting, read:

- `docs/spec/qc/00-design-reference.md` — the accumulator framework, `CheckResult`, report
  schema, data-access helpers.
- `docs/spec/qc/04-sfs.md` — the exemplar check spec (the shape your check should match).
- `references/check-catalog.md` — the catalog of planned checks with formulas and
  `gnomad_methods` references.
- `references/checkstate-template.md` — the Rust template you fill in.
- `references/worked-example.md` — a full description→diff example.

## Step 1: Pin down the check (interview)

Elicit these from the user (from the catalog if it's already listed; otherwise ask):

1. **id** (`bio.<name>` / `arith.<name>` / …) and human name.
2. **Tier** → status model: Tier 1 = FAIL, Tier 2 = WARN, Tier 3 = review.
3. **What it detects** — which upstream QC failure, and the fingerprint.
4. **Metric / formula** — exactly what to compute per row and how to combine.
5. **Input dependency** (`needs`): record-only, `globals`, `reference`, or `consequences`.
6. **Expectation / band** — the threshold, and its `qc.toml` key.
7. **Plot** (if any) — type + the small summary payload.
8. **gnomad_methods reference** — the function/thresholds to match, if one exists.

If the check is already in `references/check-catalog.md`, use that entry as the spec and just
confirm the band with the user.

## Step 2: Write the spec file

Create `docs/spec/qc/NN-<name>.md` by cloning `04-sfs.md` and filling every section. This is
the reviewable artifact of intent — the user should read and approve it before you touch Rust.

## Step 3: Scaffold the Rust (the diff)

**Data model.** The fixtures are sites-only VCFs: per-stratum counts are flat `info`
fields (`AC`, `AN`, `nhomalt`, `AC_<suffix>`, …), read via `get_field(row, "info")`, and
most checks declare `needs: &[]`. Read `AC`/`AN`/`nhomalt` counts through
`util::count_value`, not `as_i32` — a `Number=A` field (`AC`) is a one-element array that
`as_i32` returns `None` for, which makes a check pass without flagging anything. The
`freq` / `freq_meta` / `globals` model in the spec is the future Hail-native path; a check
written against it finds nothing in the fixtures.

Using `references/checkstate-template.md`, produce a diff that:

1. Adds a `checks/<name>.rs` module (a `pub const META` + a state struct + `impl Check` with
   `process_row` / `merge` / `finalize`) and a `CheckState::<Name>` variant with its match arms.
2. Registers it: `pub mod <name>;` in `checks/mod.rs` and a `registry()` entry (whose `META`
   carries id/name/tier/category/description/needs) so `--checks` and `gbl qc list` pick it up.
   A plot, if any, is attached to the `CheckResult` — it is **not** part of `CheckMeta`.
3. Adds a **unit-test fixture**: a handful of synthetic rows asserting a PASS case and a
   FAIL/WARN case (per the spec's acceptance criteria). This is where the check proves
   correctness in isolation — inline `EncodedValue` rows, no files. When a test folds rows
   through `QcAccumulator`, `finalize` returns **all** selected checks' results — look yours
   up **by id** (`results.iter().find(|r| r.id == META.id)`), never by index; hard-coding
   `results[0]` / `results.len() == 1` breaks the moment another check is registered.
4. Inlines the threshold as a `const` for now. There is no `qc.toml` / `ScanContext::expectation`
   plumbing yet (deferred — see `00-design-reference.md`); the check still reports the measured
   value + an `expectation` JSON. Needing configurable bands *today* is a framework change — flag it.
5. Adds **integration coverage** so the shared broken fixture trips the check. Check
   `examples/federation/defects.json` first — the broken fixture is an omnibus and may already
   carry a defect your check targets; if so, reuse it and add nothing. Otherwise add a defect
   entry to `examples/federation/make_broken.py` and regenerate the manifest
   (`uv run examples/federation/make_broken.py` → `partner-broken.vcf.bgz` + `defects.json`).
   Do **not** commit a new per-check VCF — the manifest lets one fixture serve every check. If the check *should* pass on the clean fixture but can't because it's a small
   regional subset (e.g. a genome-completeness check), add it to `clean_caveats` with a reason
   instead. Rare defects that need an incompatible global distribution go behind a
   `make_broken.py --scenario`. See `docs/spec/qc/05-fixtures-and-testing.md`.

Keep it minimal and idiomatic — match surrounding code, no new dependencies, `process_row`
allocation-free, `merge` associative and commutative.

## Step 4: Hand back for review

Present: the spec file, the diff, and how to verify —

```bash
cargo build --release   # gbl below is target/release/backend
cargo test              # the new unit fixture passes
gbl qc list             # the new check appears
gbl qc run examples/federation/partner-broken.vcf.bgz --checks <id> --out r.json
uv run examples/federation/run_checks.py   # both fixtures vs defects.json; your check's line
                                           # flips from SKIP to a live verdict
```

The end-to-end signal for a check is `run_checks.py`, not the UI: `/api/qc-report` is
not built, so `/qc` renders a static sample report and a newly registered check does not
appear there. Do not edit the sample report as part of a check PR. Point the user at the
formula and the band in the diff — that is the substance only they can validate.

## Guardrails

- **Never** write the check's *scientific correctness* on your own authority — the formula,
  threshold, and interpretation come from the user / `gnomad_methods` / the catalog. You
  scaffold; the expert validates.
- One check = one PR. Don't bundle unrelated checks.
- Don't modify the scan loop or the framework — a check is only a `CheckState` variant + a
  registry line. If a check seems to need framework changes, stop and flag it.
