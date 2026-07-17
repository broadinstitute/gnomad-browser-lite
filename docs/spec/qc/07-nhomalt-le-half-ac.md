# 07 — `arith.nhomalt-le-half-ac`: nhomalt ≤ AC/2

> Cloned from `04-sfs.md` (the check-spec template), adapted for a Tier-1 arithmetic check.
> Sibling of `06-ac-le-an.md` — same flat-INFO, per-stratum shape. One check = one PR.

**Owner:** methods team. **Depends on:** `01` (scaffold). **Tier:** 1 (FAIL). **Needs:** —
(see §5 — reads the flat INFO strata inline; consults no globals object on the sites-VCF path).
**Plot:** none. **One PR.**

## 1. What it detects

Each homozygous-alt genotype contributes **two** alt alleles to the allele count, so the number
of homozygous-alt genotypes `nhomalt` can never exceed half the allele count:
**`2·nhomalt ≤ AC`** (equivalently `nhomalt ≤ AC/2`), and `nhomalt ≥ 0`. This holds for every
stratum and is a mathematical guarantee of a correct callstats computation. A violation is never
biological; it fingerprints a **broken callstats computation upstream**:

- **Merge/aggregation bug** → a stratum's `nhomalt` drawn from a different cohort than its `AC`.
- **Sign/sentinel corruption** → negative `nhomalt` leaking into the frequency struct.
- **Het/hom miscount** → homozygote counts double-counted or mis-derived.

Checking *every* stratum (not just the global total) catches a callstat that broke in a single
ancestry or sex subgroup while the total still looks sane.

## 2. Metric & formula

For each record, read the `info` struct and pair every `nhomalt[_<suffix>]` field with its
matching `AC[_<suffix>]` field (global stratum = bare `nhomalt`/`AC`; suffixes are `_afr`, `_XX`,
`_afr_XX`, …). A **stratum violates** when:

```
nhomalt < 0                                  (negative homozygote count)
  or  AC present and AC >= 0 and 2·nhomalt > AC   (more homozygotes than half the alt alleles)
```

The exact integer form `2·nhomalt > AC` is used rather than `nhomalt > AC/2` to avoid
integer-division ambiguity; the product is computed in `i64` so a malformed huge `nhomalt`
cannot overflow. A **record violates** if any of its strata violate; `n_violations` counts
*records* (matching `fields.biallelic` / `arith.ac-le-an`). When `AC` is absent the `2·nhomalt ≤
AC` test is skipped (missing fields are `fields.required`'s job); when `AC < 0` it is skipped too
(that is `arith.ac-le-an`'s concern) — but `nhomalt < 0` is always flagged.

## 3. Expectation (band)

Rule-based, not a numeric band — a hard arithmetic invariant, so no `qc.toml` key. Reported
verbatim in `expectation`:

```
2*nhomalt <= AC, and nhomalt >= 0, for every stratum.
```

## 4. Status logic

- No stratum violates in any record → **PASS**.
- Any violation → **FAIL** (Tier 1 hard-fails; the value is impossible, not merely unusual).
- Message: e.g. `"5 record(s) have nhomalt > AC/2 or negative nhomalt in some stratum."`
- Up to `max_examples` offending records recorded as `{ variant_id, stratum, reason, nhomalt, ac }`
  (the first offending stratum per record).

## 5. Accumulator sketch (`CheckState::NhomaltLeHalfAc`)

```rust
struct NhomaltLeHalfAcState { n_violations: u64, examples: Vec<Value>, max_examples: usize }
// process_row: get_field(row, "info"); for each field key = "nhomalt" | "nhomalt_<suffix>",
//              find sibling "AC[_<suffix>]"; if the stratum violates, count the record once
//              and record { variant_id, stratum, reason, nhomalt, ac }.
// merge:       n_violations += other.n_violations; re-push examples under the cap.
// finalize:    status = Fail iff n_violations > 0; no plot.
```

Reads counts via the shared `util::count_value`, which unwraps a `Number=A` single-element array
(`nhomalt`, `AC`) as well as a scalar — see §"Number" note below. Stratum labels via the shared
`util::stratum_label` (also used by `arith.ac-le-an`). Allocation-free hot path; `merge` is a
per-field add (associative/commutative).

**`Number=A` cardinality.** Per the VCF v4.5 reserved-key table, `AC` and `nhomalt` are
`Number=A` (one value per ALT allele → decoded as an array) while `AN` is `Number=1` (scalar). On
a biallelic-split sites file the `A`-arrays are length 1, so `count_value` reads the first
element. Reading these with a scalar-only accessor silently yields `None` → a vacuous PASS, which
is why the shared helper exists.

**Input dependency — why `needs: &[]` and not `globals`.** Identical rationale to
`06-ac-le-an.md` §5: the catalog/`02-tier1-checks.md` list `globals` for the Hail-Table `freq`-array
model, but on the sites-only VCF fixtures `ScanContext.strata` is empty and the per-stratum counts
are flat `info.nhomalt_<suffix>` / `info.AC_<suffix>` fields read directly — so `needs` is honestly
empty. Becomes `["globals"]` when a Hail-Table `freq`-array branch is added.

## 6. Plot payload

None. An arithmetic invariant has nothing to plot; the offending records in `examples` are the
evidence.

## 7. gnomad_methods reference

`check_raw_and_adj_callstats` (`gnomad/assessment/validity_checks.py`, ~line 789): the callstats
sanity block asserting `nhomalt <= AC/2`. `arith.nhomalt-le-half-ac` is that slice, plus the
non-negativity guard.

## 8. Acceptance criteria

- [ ] `arith.nhomalt-le-half-ac` appears in `gbl qc list` (tier 1, arithmetic, needs: —, no plot).
- [ ] On `partner-clean.vcf.bgz`: PASS with `n_violations == 0`.
- [ ] On `partner-broken.vcf.bgz`: FAIL with `n_violations == 5` (defect 7 — global `nhomalt` set
      equal to `AC`, so `2·nhomalt > AC`). Integration coverage is **already wired** — no
      `make_broken.py` change.
- [ ] Unit test: synthetic rows with (a) all strata valid → PASS; (b) a subgroup `2·nhomalt > AC`,
      (c) a negative `nhomalt` → FAIL, with the offending stratum in `examples`.
- [ ] The `/qc` card for `arith.nhomalt-le-half-ac` flips from "Not yet implemented" to a live
      FAIL/PASS (once `/api/qc-report` serves a real report; see `06-ac-le-an.md` §"Strayed").
