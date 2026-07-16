# 02 — Tier 1: schema + arithmetic + completeness checks

**Owner:** methods team (this is the recommended **first contribution**). **Depends on:** `01`.
**One PR** (all Tier-1 checks bundled — they're small, share the schema validator, and have no
plots).

Tier 1 checks are **mathematically guaranteed** to hold if the partner computed their stats
correctly, so any violation is a bug → **hard FAIL**. That makes them the highest-confidence,
lowest-effort checks and the ideal way to learn the framework.

## Checks to implement

| id | check | logic | needs |
|----|-------|-------|-------|
| `fields.required` | required fields present | `AC`, `AN`, `nhomalt`, per-ancestry + per-sex strata exist | — |
| `fields.retired-terms` | no retired terminology | reject `oth`, `other`, `pop`, `population` in `freq_meta`/globals | globals |
| `fields.contigs-grch38` | GRCh38 contigs only | every `locus.contig` in the GRCh38 enum; no unexpected contigs | — |
| `arith.ac-le-an` | AC ≤ AN | flag any stratum with `AC > AN` or negative `AC`/`AN` | globals |
| `arith.af-consistent` | AF = AC/AN | `\|af - ac/an\| <= af_tolerance`; AF defined iff `AN > 0` | globals |
| `arith.subgroup-sums` | Σ subgroup = global | Σ AC over mutually-exclusive ancestry strata == global AC (same for AN) | globals |
| `arith.nhomalt-le-half-ac` | nhomalt ≤ AC/2 | flag `nhomalt > AC/2` | globals |
| `complete.chromosomes` | all chromosomes present | every autosome + X (+Y if expected) seen with a plausible count | — |
| `complete.missingness` | missingness < 50% | per field, `n_missing / n_sites <= missingness_max` | — |

(`fields.biallelic` already shipped in `01`. `complete.filter-pass-ratio` is reference-dependent
— defer to the reference-checks PR.)

> The `globals` entries in the `needs` column describe the target Hail-native
> `freq_meta`/`freq_index_dict` path. On the current sites-only fixtures, checks read the flat
> `info` fields and declare `needs: &[]`; read `AC`/`AN`/`nhomalt` via `util::count_value`. See
> `00-design-reference.md` → *Data access*.

## Reuse

- `fields.required` / `fields.contigs-grch38` should run through **`SchemaValidator`**
  (`genohype_core::validation`) — the same path `commands/validate.rs` uses. Express
  field-presence and the contig enum as a JSON-Schema validation; only the cross-field
  arithmetic checks need bespoke accumulators.
- `fields.retired-terms` mirrors `gnomad_methods` `check_globals_for_retired_terms`
  (`{pop, population, oth, other}`).
- Arithmetic thresholds: `af_tolerance`, `missingness_max` from `qc.toml` `[arithmetic]`.

## Acceptance criteria

- [ ] Each check appears in `gbl qc list` with the right tier/category/needs.
- [ ] `gbl qc run examples/federation/partner-clean.vcf.bgz --tier 1` → all PASS.
- [ ] `gbl qc run examples/federation/partner-broken.vcf.bgz --tier 1` → FAILs on exactly the
      injected defects (retired term, non-GRCh38 contig, missing `nhomalt`, `AC>AN`, wrong AF,
      subgroup-sum mismatch, `nhomalt>AC/2`, missing chrY) with correct `n_violations` and
      bounded `examples`.
- [ ] A unit-test fixture per check (a handful of synthetic rows) asserts PASS and FAIL.
- [ ] The `/qc` schema/fields step (plan 72) renders these results with real badges.

## Notes for the methods team

- This is a good PR to author with the **`qc-validity-builder`** skill: describe each check, review
  the generated `CheckState` variant + registry line + test, run `cargo test`. You don't write
  Rust from scratch — you review a diff.
- These are your grant's "genuine contributor" evidence: merged, dated, non-core-team PRs.
