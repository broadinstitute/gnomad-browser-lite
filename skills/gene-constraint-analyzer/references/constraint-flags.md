# Gene Constraint Quality Flags

gnomAD annotates genes with quality flags when constraint metrics may be unreliable. These flags indicate issues with the underlying data or mutational model.

## Flag Catalog

| Flag | Description | Impact on Constraint |
|------|-------------|---------------------|
| `no_variants` | Zero observed synonymous, missense, AND pLoF variants | Complete failure — no constraint can be calculated. Gene likely has severe coverage or annotation issues. |
| `no_exp_lof` | Zero expected pLoF variants | Gene is too short to model LoF constraint. pLI and LOEUF are not meaningful. |
| `no_exp_mis` | Zero expected missense variants | Gene is too short to model missense constraint. Missense Z-score is not meaningful. |
| `no_exp_syn` | Zero expected synonymous variants | Gene is too short for any constraint calculation. All metrics are unreliable. |
| `lof_too_many` / `outlier_lof` | More pLoF variants than expected | Unusual — gene may have atypical mutational properties, or the neutral model doesn't fit. LoF constraint may be underestimated. |
| `mis_too_many` / `outlier_mis` | More missense variants than expected | Similar to above for missense. Missense Z-score may be misleading. |
| `syn_outlier` / `outlier_syn` | More or fewer synonymous variants than expected | The mutational model baseline is off for this gene. All constraint metrics may be unreliable since synonymous variants calibrate the model. |

## Handling Flags

### In the gnomAD browser

Flags that start with `no_` are filtered from display (they indicate absence rather than anomaly). Remaining flags are shown as info badges with descriptions.

### In variant interpretation

When ANY flag is present on a gene:
1. Explicitly state that constraint metrics for this gene may be unreliable
2. Do not use constraint as strong evidence for or against pathogenicity
3. Rely on other evidence types (frequency, functional studies, segregation) instead

### Duplicate flag names

Some flags have two names due to renaming between gnomAD versions:
- `lof_too_many` (v2) = `outlier_lof` (v4)
- `mis_too_many` (v2) = `outlier_mis` (v4)
- `syn_outlier` (v2) = `outlier_syn` (v4)

Both names should be recognized.

## Sources

- gnomAD browser: `gnomad-browser/browser/src/ConstraintTable/GnomadConstraintTable.tsx` lines 125-136 (CONSTRAINT_FLAG_DESCRIPTIONS)
