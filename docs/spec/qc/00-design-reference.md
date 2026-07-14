# 00 — Design reference 

Condensed, self-contained architecture for `gbl qc` — the other specs build on it.
**Reference, not a work item** — implementable slices are `01`+.

## The big picture (start here)

`gbl qc` answers is for answering: *did this partner run proper QC on the data they're
submitting?* A partner points the tool at their sites-only file and gets back a structured
report — every check marked pass / warn / fail with its supporting metric and example variants
— consumed both on the command line and by the `/qc` web page.

Two design decisions shape everything below:

**One command, a single pass over the data.** All checks run through one entry point,
`gbl qc run <file>`, and you select which to run (default: all). I/O over the variant data
dominates cost, so regardless of how many checks are selected the tool scans the source
exactly once and every check consumes that shared scan. This is what keeps it viable from a
laptop up to cloud-scale files.

**Each check is a streaming aggregation.** A check never sees the whole dataset. It maintains a
small running state and defines just two operations: *fold* one variant record into that state,
and *merge* two states into one. That pair is a standard map–combine–reduce: the source is
partitioned, each partition is folded independently and in parallel, and the partial states are
merged associatively into a final state, which is then evaluated against the check's
expectation. Because the state is bounded — a handful of counters and sums, never the records
themselves — memory stays flat and the input can be arbitrarily large.

A new check is just those two operations plus a
pass/warn/fail rule. The scan, the parallelism, and the reporting are shared infrastructure a
check never touches. That small, well-defined surface is exactly what the `qc-validity-builder`
skill scaffolds — and why a check can be contributed by describing it and reviewing a small
diff. The rest of this document specifies these two ideas precisely.

## CLI surface

New command group in `backend/src/cli.rs` (`Commands` enum), dispatched in `main.rs`, handler
in `backend/src/commands/qc.rs` — same shape as the existing `Validate` / `Load` commands.

```
gbl qc list
    List available checks: id, tier, one-line description, input dependency.

gbl qc run <source> [options]
    Run checks in a single pass over <source> and write a JSON report.
    <source> = Hail Table | VCF(.bgz) | Parquet (local, gs://, s3://).

    --checks <ids>        Comma-separated check/group ids. Default: all single-dataset checks.
    --tier <n[,n]>        Select whole tiers, e.g. --tier 1 or --tier 1,2.
    --reference <path>    A gnomAD release sites table, for reference-dependent checks.
    --config <qc.toml>    Threshold/expectation overrides. Optional.
    --data-type <wgs|exome>  Expectation band set. Default: inferred, else wgs.
    --out <report.json>   Output path. Default: stdout.
    --max-examples <n>    Failing-row examples retained per check. Default: 20.
    --fail-on <fail|warn> Exit-code policy. Default: fail (exit 1 only on FAIL).

gbl qc cross <report1.json> <report2.json> ...   # Tier 3, deferred
```

"One check" is just a `--checks` selection of size one; there is a single scan implementation.

## Execution model — one streaming pass

The runner instantiates one accumulator per selected check, then runs the parallel fold/reduce
already used by genohype `summary` (`genohype/cli/src/commands/summary.rs`):

```rust
let acc = (0..engine.num_partitions())
    .into_par_iter()
    .fold(|| QcAccumulator::new(&selected, &ctx),
          |mut a, p| {
              if let Ok(iter) = engine.scan_partition_iter(p, &[]) {
                  for row in iter.flatten() { a.process_row(&row); }
              }
              a
          })
    .reduce(|| QcAccumulator::new(&selected, &ctx),
            |mut a, b| { a.merge(b); a });
let report = acc.finalize(&ctx);
```

`QcAccumulator` holds a `Vec<CheckState>`, one per selected check in a fixed order. `merge`
combines element-wise by index, so each check defines only its own `process_row` + `merge` +
`finalize`. A `CheckState` **enum** (one variant per check) keeps merges total and avoids
dynamic downcasting. Open the source with `spawn_blocking(QueryEngine::open_path)` — exactly
what `commands/validate.rs` already does.

## Check interface

```rust
pub struct CheckResult {
    pub id: String,             // "arith.ac-le-an"
    pub name: String,           // "AC <= AN"
    pub tier: u8,               // 1 | 2 | 3
    pub category: String,       // "schema" | "arithmetic" | "completeness" | "biological"
    pub status: Status,         // Pass | Warn | Fail
    pub metric: serde_json::Value,
    pub message: String,
    pub n_violations: u64,
    pub examples: Vec<serde_json::Value>,   // bounded sample of offending variant ids/values
    pub expectation: Option<serde_json::Value>,
    pub plot: Option<Plot>,     // present when the check renders a figure
    pub needs: Vec<String>,     // "globals" | "reference" | "consequences"
}

enum CheckState { /* one variant per check: process_row + merge + finalize */ }
```

## ScanContext (built once, shared read-only)

- `globals`: `freq_meta` (array of `{group, ancestry, sex}`) + `freq_index_dict`
  (`"group|ancestry|sex" -> i32`), via `engine.globals()`. Locates global vs per-stratum AC/AN
  in each row's `freq` array.
- `strata`: parsed (group, ancestry, sex) with freq-array indices; the global index; the
  mutually-exclusive ancestry indices for subgroup-sum checks.
- `reference_genome`: GRCh38.
- `reference_af`: optional `xpos+alleles -> (AC, AN, AF)` lookup from `--reference`.

## Data access (genohype-core)

- Rows are `EncodedValue` (`core/src/codec/encoded_type.rs`): `Struct`, `Array`, ints, floats,
  `Binary`, `Boolean`, `Null`.
- Field access via `core/src/genomic/extract.rs`: `get_field`, `get_field_any` (case/alias
  fallback, e.g. `ac`/`AC`), `get_nested_field`, `as_i32`, `as_f64`, `as_string`.
- Sites row layout: `locus.contig` (Binary), `locus.position` (Int32), `alleles`
  (Array<Binary>, `[0]`=ref `[1]`=alt), `filters` (Array<Binary>), `freq`
  (Array<Struct{ac, an, af, homozygote_count}>). `freq_meta`/`freq_index_dict` are in globals.
- Classification: SNV iff `len(ref)==1 && len(alt)==1`; indel iff `len(ref)!=len(alt)`; contig
  class via `contig_to_int` (X=23, Y=24, M=25) in `core/src/export/xpos.rs`.
- Schema/field checks reuse `SchemaValidator` / `SchemaGenerator` / `ValidationReport`
  (`core/src/validation/mod.rs`) — the same module `commands/validate.rs` uses.

## Report schema (CLI ↔ app contract)

```jsonc
{
  "schema_version": "1",
  "source": "gs://partner-bucket/sites.ht",
  "dataset_id": "partner-x-v1",
  "reference_genome": "GRCh38",
  "data_type": "wgs",
  "generated_at": "2026-06-29T15:10:00Z",   // stamped by the Rust process
  "rows_scanned": 134221904,
  "summary": { "pass": 14, "warn": 3, "fail": 1 },
  "checks": [
    {
      "id": "arith.ac-le-an", "name": "AC <= AN", "tier": 1, "category": "arithmetic",
      "status": "fail",
      "metric": { "n_violations": 12 },
      "message": "12 records have AC > AN.",
      "n_violations": 12,
      "examples": [ { "variant_id": "1-1234-A-T", "ac": 51, "an": 40 } ],
      "expectation": { "rule": "AC <= AN for every stratum" },
      "plot": null, "needs": []
    }
  ]
}
```

Plot `data` is always a small precomputed summary array, never raw variants — the browser only
renders. `schema_version` lets the frontend evolve safely.

## Testing model (see `05-fixtures-and-testing.md`)

Two levels, kept separate. **Unit:** each check ships a handful of synthetic
`EncodedValue` rows built inline in Rust, asserting PASS and FAIL/WARN in
isolation. **Integration:** all checks share one clean + one omnibus broken VCF
under `examples/federation/`, plus a `defects.json` manifest mapping each injected
defect → the check(s) it trips. `run_checks.py` (and the CI Rust test) run
`gbl qc run` on both and assert against the manifest — clean passes everything
outside `clean_caveats`; broken fails exactly the manifest-named checks and
nothing else. We ship one omnibus broken file, not one per check; per-check
isolation is the unit test's job, and the manifest is what lets a single file
serve the whole catalog.

## Full check catalog

The complete Tier 1/2/3 catalog (ids, formulas, thresholds, `gnomad_methods` refs, plot types)
is in the `qc-validity-builder` skill's `references/check-catalog.md`, and per-check in the `04+`
specs. Tiers at a glance:

- **Tier 1 (FAIL):** `fields.required`, `fields.retired-terms`, `fields.contigs-grch38`,
  `fields.biallelic`, `arith.ac-le-an`, `arith.af-consistent`, `arith.subgroup-sums`,
  `arith.nhomalt-le-half-ac`, `complete.chromosomes`, `complete.missingness`,
  `complete.filter-pass-ratio`.
- **Tier 2 (WARN):** `bio.titv`, `bio.snv-indel-ratio`, `bio.variant-counts-by-chrom`,
  `bio.sfs`, `bio.inbreeding-f`, `bio.an-uniformity`, `bio.af-concordance`,
  `bio.known-variant-fraction`, `bio.variant-type-dist`, `bio.chrxy`.
- **Tier 3 (deferred):** `cross.af-correlation`, `cross.variant-burden`, `cross.cmh-batch`,
  `cross.ancestry-composition`.

## Thresholds live in `qc.toml` (methods team owns the numbers)

```toml
[expectations.wgs]
titv = { min = 2.0, max = 2.1 }
singleton_fraction = { min = 0.40, max = 0.55 }
snv_indel_ratio = { min = 6.0, max = 8.0 }
inbreeding_f_median = { min = -0.05, max = 0.05 }
af_concordance_r = { min = 0.95 }

[arithmetic]
af_tolerance = 1e-6
missingness_max = 0.5
```

The tool always reports the measured value and the band side-by-side, so a rough/missing band
still yields a useful number.
