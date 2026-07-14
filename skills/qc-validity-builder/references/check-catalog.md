# Check catalog

The planned `gbl qc` checks with formulas, expectations, and `gnomad_methods` references. Use
an entry here as the spec for a new check; confirm the band with the user before scaffolding.
Full derivation: `docs/spec/qc/00-design-reference.md`.

## Tier 1 — technical validity (FAIL on violation)

| id | logic | needs | gnomad_methods |
|----|-------|-------|----------------|
| `fields.required` | AC, AN, nhomalt, per-ancestry + per-sex strata present | — | SchemaValidator |
| `fields.retired-terms` | reject `oth`,`other`,`pop`,`population` in freq_meta/globals | globals | `check_globals_for_retired_terms` |
| `fields.contigs-grch38` | every `locus.contig` in GRCh38 enum | — | schema enum |
| `fields.biallelic` | `len(alleles)==2` (shipped in scaffold) | — | — |
| `arith.ac-le-an` | flag `AC>AN` or negative AC/AN per stratum | globals | callstats checks |
| `arith.af-consistent` | `\|af - ac/an\| <= tol`; AF defined iff AN>0 | globals | `check_raw_and_adj_callstats:805-825` |
| `arith.subgroup-sums` | Σ mutually-exclusive ancestry AC == global AC (and AN) | globals | `make_group_sum_expr_dict:264-373` |
| `arith.nhomalt-le-half-ac` | flag `nhomalt > AC/2` | globals | `check_raw_and_adj_callstats:789` |
| `complete.chromosomes` | all autosomes + X (+Y if expected), plausible counts | — | — |
| `complete.missingness` | per field `n_missing/n_sites <= 0.5` | — | `compute_missingness:1012-1063` |
| `complete.filter-pass-ratio` | PASS/total vs reference expectation | reference | `summarize_variant_filters:390-517` |

## Tier 2 — biological plausibility (WARN out of band)

| id | metric | expectation (TBD = calibrate) | needs | plot | gnomad_methods |
|----|--------|-------------------------------|-------|------|----------------|
| `bio.titv` | transitions / transversions over biallelic SNVs | WGS 2.0–2.1; exome 2.8–3.2 | — | bar | `is_transition/transversion`; `r_ti_tv` |
| `bio.snv-indel-ratio` | counts by allele-length class | ≈ 7:1 | — | bar | `add_variant_type` |
| `bio.variant-counts-by-chrom` | per-contig count vs chr length | proportional to length | — | bar | — |
| `bio.sfs` | AC/AF bins; singleton fraction | L-shape; singletons 40–55% (WGS) | — | bar (log y) | `freq_bin_expr:24-89` |
| `bio.inbreeding-f` | per-site F = 1 − (AC − 2·nhomalt)/(2·p·q·n), n=AN/2, q=AC/AN, p=1−q; median F + fraction F<−0.3 | median F ≈ 0; flag tail | globals | histogram | `bi_allelic_site_inbreeding_expr:1012-1069`; cutoff −0.3 |
| `bio.an-uniformity` | mean AN per autosome; CV across autosomes; chrX ~0.75×, chrY low | CV small | globals | bar + line | — |
| `bio.af-concordance` | Pearson r on AF of shared variants per ancestry | r > 0.95 | reference | scatter | new (not in gnomad_methods) |
| `bio.known-variant-fraction` | fraction of partner variants present in reference | WGS/exome bands | reference | — | new |
| `bio.variant-type-dist` | consequence mix | SNV 85–90%; syn:mis ≈ 1:1.5; pLoF <1% | consequences | bar | `annotate_allele_info`; VEP |
| `bio.chrxy` | no nhomalt on chrY; chrX nonPAR global nhomalt == nhomalt_XX | — | globals | — | `check_sex_chr_metrics:892-1009` |

`bio.variant-type-dist` needs per-variant consequence; if the partner file lacks it, run
in-process fastVEP during the same scan (needs a GFF3+FASTA reference).

## Tier 3 — cross-partner (deferred; run centrally via `gbl qc cross`)

| id | logic | notes |
|----|-------|-------|
| `cross.af-correlation` | Pearson r on common-variant AF per matched ancestry | new |
| `cross.variant-burden` | count partner-unique variants; flag outliers | new |
| `cross.cmh-batch` | Cochran–Mantel–Haenszel on (alt,ref)×partner, stratified by ancestry | new Rust impl (gnomad_methods has only VCF header text) |
| `cross.ancestry-composition` | per-partner ancestry shares vs expectation | — |

## `qc.toml` band keys

```toml
[expectations.wgs]
titv = { min = 2.0, max = 2.1 }
singleton_fraction = { min = 0.40, max = 0.55 }
snv_indel_ratio = { min = 6.0, max = 8.0 }
inbreeding_f_median = { min = -0.05, max = 0.05 }
af_concordance_r = { min = 0.95 }

[expectations.exome]
titv = { min = 2.8, max = 3.2 }

[arithmetic]
af_tolerance = 1e-6
missingness_max = 0.5
```
