# 04 — `bio.sfs`: Site Frequency Spectrum

> **This is the template for every Tier-2 check spec.** Copy this file, rename it
> `NN-<check>.md`, and fill each section. One check = one PR. The `qc-validity-builder` skill reads
> a spec in exactly this shape and scaffolds the Rust.

**Owner:** methods team. **Depends on:** `01` (scaffold). **Tier:** 2 (WARN). **Needs:** —
(record-only; single pass, sites-only). **Plot:** bar (log y). **One PR.**

## 1. What it detects

The site frequency spectrum is the distribution of variants across allele-frequency bins. In a
well-QC'd human cohort it is strongly **L-shaped**: the overwhelming majority of variants are
rare, with a large singleton spike. Deviations flag upstream failures:

- **Contamination** → inflated rare/singleton fraction (spurious low-frequency calls).
- **Unremoved relatives** → excess doubletons and common variants.
- **No/poor filtering** → generally distorted shape.

So `bio.sfs` is the shared fingerprint for three distinct problems — high signal-to-effort,
which is why it's the recommended first Tier-2 check.

## 2. Metric & formula

Bin every biallelic variant by allele frequency, using AC for the low end and AF for the rest
(matching `gnomad_methods` `freq_bin_expr`, `assessment/summary_stats.py`):

```
bins = [ AC==1 (singleton), AC==2 (doubleton),
         AF < 1e-4, 1e-4 ≤ AF < 1e-3, 1e-3 ≤ AF < 1e-2,
         1e-2 ≤ AF < 1e-1, AF ≥ 1e-1 ]
singleton_fraction = n(AC==1) / n_variants
```

Use the **global** (adj) AC/AF stratum (locate via `ScanContext.strata` global index).

## 3. Expectation (band)

| data type | singleton_fraction | shape |
|-----------|--------------------|-------|
| WGS | 0.40 – 0.55 | monotonic L (each higher-AF bin ≤ previous) |
| exome | TBD (calibrate) | L |

Bands are placeholders to calibrate against a known-good release; source from `qc.toml`
`[expectations.<data_type>] singleton_fraction`. Always report measured value **and** band.

## 4. Status logic

- `singleton_fraction` within band **and** shape monotonic → **PASS**.
- Out of band or non-monotonic → **WARN** (Tier 2 never hard-FAILs).
- Message: e.g. `"L-shaped; singletons 47% (expected 40–55% for WGS)."`

## 5. Accumulator sketch (`CheckState::Sfs`)

```rust
struct SfsState { bins: [u64; 7], n_variants: u64 }
// process_row: if biallelic, read global AC/AF, increment the matching bin + n_variants
// merge:       element-wise add bins, add n_variants
// finalize:    singleton_fraction = bins[0]/n_variants; compare to band; build Plot + CheckResult
```

`process_row` reads `freq[global]` via `get_nested_field`/`as_i32`/`as_f64`; biallelic via
`len(alleles) == 2`. Allocation-free; `merge` is a per-element add (associative/commutative).

## 6. Plot payload

```jsonc
"plot": {
  "type": "sfs_bar",
  "data": {
    "bins": ["AC=1","AC=2","<0.01%","0.01-0.1%","0.1-1%","1-10%",">10%"],
    "counts": [63084295, 11290011, /* ... */]
  }
}
```

Precompute in Rust; the browser only renders (log-y bar via a `SFSChart` Visx component). Never
put raw variants in the plot.

## 7. gnomad_methods reference

`freq_bin_expr` (`gnomad/assessment/summary_stats.py:24-89`) — AC0/singleton/doubleton then AF
cuts `1e-4, 1e-3, 1e-2, 1e-1, 0.95`. Match the bin edges.

## 8. Acceptance criteria

- [ ] `bio.sfs` appears in `gbl qc list` (tier 2, biological, needs: none, plot: sfs_bar).
- [ ] On `partner-clean.vcf.bgz`: PASS with `singleton_fraction` in band and a populated plot.
- [ ] On `partner-broken.vcf.bgz` (contamination defect, if injected): WARN with an out-of-band
      singleton fraction.
- [ ] Unit test: synthetic rows across the AC/AF bins → exact expected bin counts and status.
- [ ] The `/qc` card for `bio.sfs` flips from "Not yet implemented" to a live WARN/PASS with the
      bar plot.

---

### Section checklist when cloning this template

`1` what it detects · `2` metric/formula · `3` expectation band (+ `qc.toml` key) · `4` status
logic · `5` accumulator sketch (`process_row`/`merge`/`finalize`) · `6` plot payload (or "none")
· `7` gnomad_methods reference · `8` acceptance criteria (clean PASS, broken WARN, unit test,
UI card lights up).
