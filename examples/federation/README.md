# Federation QC test fixtures

Two **sites-only VCF fixtures** that stand in for an external gnomAD **federation
partner's** frequency submission, for exercising `gbl qc` and the `/qc` report page:

| file | what it is |
|------|------------|
| `partner-clean.vcf.bgz` (+ `.tbi`) | carved from real gnomAD v4.1 genomes; passes all Tier-1 checks, plausible Tier-2 |
| `partner-broken.vcf.bgz` (+ `.tbi`) | the clean fixture with a documented list of injected defects |
| `defects.json` | machine-readable manifest: per-defect counts, example variant ids, and which check each trips |
| `build_clean.py` | reproducibility script: gnomAD v4.1 sites HT → `partner-clean.vcf.bgz` |
| `make_broken.py` | deterministic mutator: `partner-clean` → `partner-broken` + `defects.json` |
| `run_checks.py` | runs `gbl qc` on both fixtures and checks the result against `defects.json` |

Both files are **sites-only** (no genotype/sample columns). Per-variant `AC`, `AN`,
`AF`, `nhomalt` are carried as INFO fields, stratified by genetic-ancestry group
and sex karyotype, mirroring the gnomAD VCF INFO layout.

## Source data

gnomAD **v4.1** genomes sites (public, no auth):

```
gs://gcp-public-data--gnomad/release/4.1/ht/genomes/gnomad.genomes.v4.1.sites.ht
```

Reference genome: **GRCh38**.

### Region set

Carved to keep the fixture small (~18–22 MB per file) while giving real
allele-frequency, Ti/Tv, and SFS signal. Each contig comes from exactly one
window, so the emitted VCF is coordinate-sorted for tabix.

| region | contig:interval | ~records | why |
|--------|-----------------|----------|-----|
| PCSK9  | `chr1:55039000-55065000`   | 6,082  | gene region already shipped in `data/test_intervals.json` |
| BRCA1  | `chr17:43044000-43126000`  | 22,606 | gene region already shipped in `data/test_intervals.json` |
| chr21 window | `chr21:20000000-20150000` | 41,196 | autosomal SFS / Ti-Tv signal |
| chr22 window | `chr22:20000000-20150000` | 41,693 | autosomal SFS / Ti-Tv signal |
| chrX window  | `chrX:23000000-23100000`  | 17,763 | non-PAR X; needed for `bio.chrxy` |
| chrY window  | `chrY:2800000-3300000`    | 31,563 | non-PAR (male-specific) Y; needed for `bio.chrxy` and the "missing chrY" defect |

Total: **160,903** records in `partner-clean.vcf.bgz`.

### Stratification / terminology

gnomAD v4 terminology throughout. Genetic-ancestry groups carried:
`afr`, `amr`, `asj`, `eas`, `fin`, `nfe`, `sas`, `remaining`; sex karyotypes `XX`, `XY`.

INFO keys per record (108 total): global `AC`/`AN`/`AF`/`nhomalt`, then the same
four for each sex (`AC_XX`, …), each ancestry group (`AC_afr`, …), and each
ancestry × sex cell (`AC_afr_XX`, …). `AF = AC/AN`, or `.` when `AN == 0`.

## Building the clean fixture

`genohype export vcf` **cannot** be used directly: it only projects the flat
`info` struct and drops the top-level positional `freq` array plus the
`freq_meta`/`freq_index_dict` globals that index it (see genohype note
`20260714-vcf-freq-array-drop`). So `build_clean.py` reads those itself:

```bash
# per region, sites-only, freq array + globals:
genohype info  <HT> --globals                       # freq_meta -> stratum indices
genohype query <HT> --interval chr1:55039000-55065000 \
    --fields locus,alleles,freq,filters --json      # one region's rows

# reproduce end to end (scripts are stdlib-only; uv pins the interpreter):
uv run build_clean.py        # -> partner-clean.vcf.bgz (+ .tbi)
```

All aggregate strata (global, per-sex, per-ancestry) are **derived by summing the
finest ancestry × sex cells**, so the clean fixture is arithmetically
self-consistent by construction: `AC ≤ AN`, `AF = AC/AN`, `Σ subgroup = global`,
and `nhomalt ≤ AC/2` hold for every record and every stratum. (Because we sum the
8 carried ancestry groups, the derived global totals are slightly below gnomAD's
published adj totals, which also include `ami`/`mid` — expected for a partner
submission carrying its own group set.)

> **Note.** `genohype query --interval` parallelizes across partitions and does
> not guarantee position-sorted output when a window straddles a partition
> boundary, so `build_clean.py` sorts each region by position before writing.

### Measured Tier-2-relevant stats (clean)

- Ti/Tv (PASS SNVs): **1.75** overall (gene windows ≈ 1.96; chr21/chrX/chrY
  windows are lower). A regional subset legitimately won't hit the genome-wide
  2.0–2.1 band; Tier-2 bands live in `qc.toml` and are calibrated by the methods
  team, and the tool reports the measured value alongside the band.

## Building the broken fixture

```bash
uv run make_broken.py         # partner-clean.vcf.bgz -> partner-broken.vcf.bgz + defects.json
```

Deterministic: records are selected by file order + fixed predicates (never at
random). Each arithmetic/schema defect hits a small, disjoint set of records and
is crafted to trip **only** its target check (e.g. the `AC>AN` records are
rewritten into an otherwise self-consistent state so subgroup sums / AF / nhomalt
still hold). Exact affected variant ids are in `defects.json`.

### Defect table

| # | Defect | Injected how | Check(s) tripped | Tier | Records |
|---|--------|--------------|------------------|------|---------|
| 1 | Retired ancestry term | `nfe` strata relabeled `oth` in every INFO key + header | `fields.retired-terms` | 1 | all (129,340) |
| 2 | Non-GRCh38 contig | `CHROM` `chr1`→`1` (GRCh37-style) | `fields.contigs-grch38` | 1 | 5 |
| 3 | Missing required field | global `nhomalt` INFO key dropped | `fields.required` | 1 | 5 |
| 4 | AC > AN | record rewritten to `AC=51, AN=40` | `arith.ac-le-an` | 1 | 5 |
| 5 | AF ≠ AC/AN | global `AF` overwritten to `0.5` | `arith.af-consistent` | 1 | 5 |
| 6 | Subgroup sum ≠ global | `AC_afr += 25` without bumping global | `arith.subgroup-sums` | 1 | 5 |
| 7 | nhomalt > AC/2 | global `nhomalt` set to `AC` | `arith.nhomalt-le-half-ac` | 1 | 5 |
| 8 | Missing chrY | all chrY records dropped; `##contig=chrY` removed | `complete.chromosomes`, `bio.chrxy` | 1/2 | 31,563 |
| 9 | Contamination signature | `nhomalt` zeroed on common (AF ≥ 0.05) sites → excess het, F ≪ 0 | `bio.inbreeding-f` | 2 | 1,803 |
| 10 | Poor filtering | chr22 PASS transitions flipped to transversions (Ti/Tv 1.60 → 1.39) | `bio.titv` | 2 | 4,000 |

Defects **1–3** are the minimum bar for the plan-72 walking-skeleton demo (the
schema/fields step); the rest enrich the report as later checks land. Defects 9
and 10 are approximate (their Tier-2 bands are calibrated later); they depress the
relevant metric in the right direction rather than target an exact threshold.

The broken fixture differs from the clean one **only** by the edits above:
`partner-broken.vcf.bgz` has 129,340 records (160,903 − 31,563 chrY), contigs
`{1, chr1, chr17, chr21, chr22, chrX}`, and `oth` in place of `nfe`.

## Sanity checks

```bash
bgzip -t partner-clean.vcf.bgz  && bgzip -t partner-broken.vcf.bgz    # BGZF integrity
tabix  -p vcf partner-clean.vcf.bgz                                   # index round-trips
genohype info  partner-clean.vcf.bgz                                  # opens; 108 INFO fields
genohype info  partner-broken.vcf.bgz
genohype query partner-clean.vcf.bgz --count                          # 160903
genohype query partner-broken.vcf.bgz --interval chr17:43045000-43120000 --limit 1 --json
# (bcftools view works too where available; not installed in this env)
```

`genohype query` decodes every INFO stratum back to the right value — verified
against the raw records — so the reader path the `gbl qc` checks build on can
consume these fixtures directly (global + all `AC`/`AN`/`AF`/`nhomalt` strata,
including the broken file's relabeled `oth` and `AC=51,AN=40` defect records).

## Testing with `gbl qc`

`defects.json` is the contract between these fixtures and the checks: each defect
lists the check(s) it trips, the affected record count, and example variant ids.
`run_checks.py` runs `gbl qc` on both fixtures and asserts against it:

```bash
uv run run_checks.py                                   # uses `gbl`
GBL='cargo run -q --bin backend --' uv run run_checks.py   # before the gbl rename
uv run run_checks.py --strict                          # stray warns / false positives -> exit 1
```

It is **manifest-driven and incremental**: a check named in the manifest but not
yet implemented is reported `SKIP`, so the same command is meaningful from the
first check through the full catalog. `clean` must PASS everything except the
manifest's `clean_caveats` (checks that legitimately can't pass on a small
regional subset — `complete.chromosomes`, `bio.titv`); `broken` must fail exactly
the manifest-named checks and nothing else. Until `gbl qc` exists
(`docs/spec/qc/01-scaffold.md`), the runner SKIPs unless `--require` is given.

See `docs/spec/qc/05-fixtures-and-testing.md` for the full testing model (unit vs
integration, why one omnibus broken file, and the `--scenario` escape hatch).
