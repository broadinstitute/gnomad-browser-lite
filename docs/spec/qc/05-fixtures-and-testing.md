# 05 — Fixtures & testing

How `gbl qc` checks are tested, and how the test surface scales as the catalog
grows from one check to the full Tier 1/2/3 set. **Depends on:** `00`, `01`.

## Two kinds of test, two kinds of fixture

A check has two independent things to prove, and each has its own fixture:

| Level | Question | Fixture | Lives |
|-------|----------|---------|-------|
| **Unit** | Does the accumulator compute the right verdict from rows? | a handful of **synthetic `EncodedValue` rows** built inline in the test | next to the `CheckState`, in Rust |
| **Integration** | Does the check fire correctly end-to-end on a realistic file, and *only* when it should? | the shared **`examples/federation`** VCF pair + `defects.json` | one harness for all checks |

Keep these separate. The unit test is where a check proves correctness in
isolation (one defect, deterministic, no I/O). The integration layer proves the
whole `gbl qc run` path — parsing, scan, registry, report — behaves on real data.

## Why one omnibus broken fixture, not one per check

There is a **single** clean fixture and a **single** broken fixture
(`docs`: `examples/federation/README.md`):

- `partner-clean.vcf.bgz` — everything an implemented check should PASS.
- `partner-broken.vcf.bgz` — carries **all** injected defects at once.
- `defects.json` — the manifest mapping each defect → the check(s) it trips,
  the affected record count, and example variant ids.

We deliberately do **not** ship a broken VCF per check:

- **Isolation is the unit test's job**, and it does it better — inline synthetic
  rows, no real-data variance, no file to regenerate.
- **`defects.json` already lets one file serve many checks.** Per-check
  assertions read the manifest; the file itself is shared.
- **The omnibus is the honest input.** A real partner submits one file with
  several problems; the `/qc` walking skeleton (plan 03/72) lights up many cells
  from one run. N single-defect files would be N multi-MB binaries to keep in
  sync for no added coverage.

**Escape hatch — scenarios.** A few Tier-2 defects reshape a *global
distribution* in ways that can't coexist in one file (you can't have both a
normal and a contamination-shaped SFS). When a defect genuinely can't live in the
omnibus, do **not** hand-author a file: add a `--scenario <name>` selection to
`make_broken.py` that emits a defect subset into `examples/federation/scenarios/`
with its own mini-manifest. One mutator, many named scenarios, still zero
hand-maintained binaries. Reach for this only when forced.

## The clean/broken contract

- **clean** ⇒ every implemented check PASSes, *except* the ids in the manifest's
  `clean_caveats` (checks that legitimately can't pass on a small **regional**
  real-data subset — currently `complete.chromosomes` and `bio.titv`; see the
  reasons in `defects.json`). A caveat is not a bug; it is a documented limit of
  using real data carved to a few Mb.
- **broken** ⇒ every check named by a defect is in a failing state (FAIL for
  Tier 1, FAIL or WARN for Tier 2), and **no other** check fails (the
  false-positive guard).

Each arithmetic/schema defect is crafted to trip **only** its target check — e.g.
the `AC>AN` records are rewritten into an otherwise self-consistent state (AF,
subgroup sums, nhomalt all still hold), so a checker that flags them for anything
but `arith.ac-le-an` has a bug. That is what makes the false-positive guard sharp.

## Running the fixtures

Human / local (the mirror, ergonomic output):

```bash
uv run examples/federation/run_checks.py            # uses `gbl`
GBL='cargo run -q --bin backend --' \
    uv run examples/federation/run_checks.py        # before the gbl rename
uv run examples/federation/run_checks.py --strict   # false positives / stray warns -> exit 1
```

`run_checks.py` is **manifest-driven and incremental**: a check named in
`defects.json` but not yet present in the report (not implemented) is reported
`SKIP`, never a failure. So the same command is meaningful from the first check
through the full catalog — as each check lands, its line flips from `SKIP` to a
live verdict with no change to the harness.

CI gate (authoritative): a Rust integration test in the backend crate
(`backend/tests/qc_fixtures.rs`, added with `01-scaffold`) shells `gbl qc run` on
both fixtures and applies the same manifest-driven assertions, so check
regressions fail `cargo test`. The manifest is the single source of truth for
both; keep the Rust test's logic a straight port of `run_checks.py`.

## When you add a check (the loop this closes)

The `qc-validity-builder` skill scaffolds the check **and** its coverage:

1. **Unit test** — inline synthetic rows asserting PASS and FAIL/WARN (Step 3).
2. **Integration coverage** — if the check needs the broken fixture to exhibit
   its defect, add a defect entry to `make_broken.py` + regenerate `defects.json`
   (or add a `--scenario`). Do **not** commit a new VCF. Regenerate:

   ```bash
   uv run examples/federation/make_broken.py     # rewrites partner-broken.vcf.bgz + defects.json
   ```

3. The new manifest entry makes both `run_checks.py` and the Rust test cover the
   check automatically.

If a check should pass on clean but can't because the regional subset lacks the
data (e.g. a new genome-completeness check), add it to `clean_caveats` with a
reason rather than weakening the check.

## Acceptance criteria

- [ ] `uv run examples/federation/run_checks.py` reports every implemented
      manifest check as a live verdict and every unimplemented one as `SKIP`.
- [ ] `partner-clean` yields no FAIL outside `clean_caveats`.
- [ ] `partner-broken` fails exactly the manifest-named checks; the
      false-positive guard is clean (`--strict` passes).
- [ ] `backend/tests/qc_fixtures.rs` enforces the same, gating `cargo test`.
- [ ] Adding a check adds a manifest defect (or a documented caveat); no per-check
      VCF is introduced.
