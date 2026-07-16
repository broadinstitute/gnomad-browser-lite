# 06 — `arith.ac-le-an`: AC ≤ AN

> Cloned from `04-sfs.md` (the Tier-2 template) and adapted for a Tier-1 arithmetic
> check. One check = one PR. The `qc-validity-builder` skill read this spec and scaffolded
> the Rust.

**Owner:** methods team. **Depends on:** `01` (scaffold). **Tier:** 1 (FAIL). **Needs:** —
(see §5 — reads the flat INFO strata inline in each record; consults no globals object on the
sites-VCF path). **Plot:** none. **One PR.**

## 1. What it detects

For every allele-count stratum, the allele count `AC` counts alternate alleles observed and the
allele number `AN` counts total called alleles, so **`0 ≤ AC ≤ AN` is a mathematical
guarantee** — there cannot be more alternate alleles than total alleles, and neither can be
negative. A violation is never biological; it is a **broken callstats computation upstream**:

- **Merge/aggregation bug** → per-stratum AC and AN drawn from mismatched cohorts, so a stratum's
  AC exceeds its AN.
- **Sign/overflow or sentinel corruption** → negative AC or AN leaking into the frequency struct.
- **Copy/relabel error** → a stratum's AC paired with the wrong stratum's AN.

Because it holds for *every* stratum, checking all of them (not just the global total) catches a
callstat that broke in a single ancestry or sex subgroup while the total still looks sane.

## 2. Metric & formula

For each record, read the `info` struct and pair every `AC[_<suffix>]` field with its matching
`AN[_<suffix>]` field (global stratum = bare `AC`/`AN`; suffixes are `_afr`, `_XX`,
`_afr_XX`, …). A **stratum violates** when:

```
AC < 0                       (negative allele count)
  or  AN present and AN < 0  (negative allele number)
  or  AN present and AC > AN (more alt alleles than total)
```

A **record violates** if any of its strata violate. `n_violations` counts *records*, matching
the per-variant counting of `fields.biallelic`. When `AN` is absent the `AC ≤ AN` and negative-AN
tests are skipped (missing fields are `fields.required` / `complete.missingness`'s job), but
`AC < 0` is still flagged.

## 3. Expectation (band)

Rule-based, not a numeric band — this is a hard arithmetic invariant, so there is no `qc.toml`
key. Reported verbatim in `expectation`:

```
AC <= AN, and AC >= 0 and AN >= 0, for every stratum.
```

## 4. Status logic

- No stratum violates in any record → **PASS**.
- Any violation → **FAIL** (Tier 1 hard-fails; the value is impossible, not merely unusual).
- Message: e.g. `"5 record(s) have AC > AN or negative AC/AN in some stratum."`
- Up to `max_examples` offending records recorded as
  `{ variant_id, stratum, ac, an }` (the first offending stratum per record).

## 5. Accumulator sketch (`CheckState::AcLeAn`)

```rust
struct AcLeAnState { n_violations: u64, examples: Vec<Value>, max_examples: usize }
// process_row: get_field(row, "info"); for each field key = "AC" | "AC_<suffix>",
//              find sibling "AN[_<suffix>]"; if the stratum violates, count the record
//              once and record { variant_id, stratum, ac, an }.
// merge:       n_violations += other.n_violations; re-push examples under the cap.
// finalize:    status = Fail iff n_violations > 0; no plot.
```

Allocation-free: `process_row` matches AC keys by `strip_prefix("AC")` and finds the matching AN
by comparing `strip_prefix("AN")` — no per-key `format!`. `merge` is a per-field add
(associative/commutative).

**Input dependency — why `needs: &[]` and not `globals`.** The catalog and `02-tier1-checks.md`
list this check under `needs: globals`, reflecting the Hail-Table model where per-stratum AC/AN
live in a `freq: Array<Struct{ac, an, …}>` located via `freq_meta`/`freq_index_dict` globals. The
federation fixtures — and everything the landed scan exercises — are **sites-only VCFs**, where
`engine.globals()` is empty (`ScanContext.strata` is empty) and each stratum's AC/AN are flat
`info.AC_<suffix>` fields inline in the record. This implementation reads those directly, so it
consults no globals object and `needs` is honestly empty. When a Hail-Table `freq`-array branch
is added (reading `ctx.strata`), `needs` becomes `["globals"]`. Flagged for reviewer awareness;
it does not affect `--checks`/default selection (globals-dependent checks are selected by default
anyway).

## 6. Plot payload

None. An arithmetic invariant has nothing to plot; the offending records in `examples` are the
evidence.

## 7. gnomad_methods reference

`check_raw_and_adj_callstats` (`gnomad/assessment/validity_checks.py`, the callstats sanity
block ~lines 789–825): the same family of guards that AC/AN/nhomalt/AF are internally consistent.
`arith.ac-le-an` is the `AC ≤ AN` (and non-negativity) slice of that block.

## 8. Acceptance criteria

- [ ] `arith.ac-le-an` appears in `gbl qc list` (tier 1, arithmetic, needs: —, no plot).
- [ ] On `partner-clean.vcf.bgz`: PASS with `n_violations == 0`.
- [ ] On `partner-broken.vcf.bgz`: FAIL with `n_violations == 5` (defect 4 — records rewritten to
      `AC=51, AN=40` across all strata; AF/subgroup-sums/nhomalt left self-consistent so only this
      check trips). Integration coverage is **already wired** — no `make_broken.py` change.
- [ ] Unit test: synthetic rows with (a) all strata valid → PASS; (b) a subgroup `AC > AN`,
      (c) a negative AC → FAIL, with the offending stratum in `examples`.
- [ ] The `/qc` card for `arith.ac-le-an` flips from "Not yet implemented" to a live FAIL/PASS.
