# Gene Constraint Metrics

Gene constraint measures whether a gene has fewer damaging variants than expected under a neutral mutation model. Genes under strong purifying selection show depletion of damaging variants relative to expectation.

## Core Metrics

### pLI (Probability of being Loss-of-function Intolerant)

- **Range**: 0 to 1
- **Threshold**: pLI >= 0.9 indicates extreme intolerance to heterozygous LoF
- **Interpretation**: High pLI means the gene is haploinsufficient — losing one copy is deleterious
- **Limitations**: Binary (high/low), doesn't capture intermediate constraint; being replaced by LOEUF

### LOEUF (Loss-of-function Observed/Expected Upper bound Fraction)

- **Field**: `oe_lof_upper` (upper bound of the o/e confidence interval)
- **Range**: 0+ (lower = more constrained)
- **Thresholds**:
  - < 0.35: Highly constrained (equivalent to pLI >= 0.9)
  - 0.35 - 0.66: Moderately constrained
  - 0.66 - 1.0: Some constraint signal
  - \> 1.0: Not constrained
- **Preferred metric**: Continuous, more informative than binary pLI
- **Color bands in gnomAD browser**: < 0.33 red, < 0.66 orange, < 1.0 yellow

### Missense Z-score (mis_z)

- **Interpretation**: Positive Z = fewer missense variants than expected (constrained)
- **Thresholds**:
  - \> 3.09: Significantly constrained (p < 0.001, one-tailed). Used for PP2 criterion in ACMG.
  - 2.0 - 3.09: Moderate constraint
  - < 2.0: Not significantly constrained
- **Clinical use**: PP2 criterion — missense variants in missense-constrained genes get supporting pathogenic evidence

### Synonymous Z-score (syn_z)

- **Interpretation**: Should be near zero — synonymous variants are (mostly) neutral
- **Warning threshold**: syn_z > 3.71 is highlighted red in the gnomAD browser
- **Purpose**: Quality control. Extreme values indicate problems with the mutational model for this gene

### Observed/Expected (o/e) Ratios

For each category (LoF, missense, synonymous):
- `obs_{category}`: Number of observed variants in gnomAD
- `exp_{category}`: Number of expected variants under neutral model
- `oe_{category}`: obs/exp ratio
- `oe_{category}_lower`: Lower bound of 90% CI
- `oe_{category}_upper`: Upper bound of 90% CI (LOEUF uses this for LoF)

An o/e of 0.2 means only 20% as many variants were observed as expected — strong depletion.

## How Constraint is Calculated

1. A depth-corrected mutation rate model predicts how many variants each gene should have
2. Observed variant counts come from high-quality gnomAD callset (AF < 0.1%, PASS filters, median depth >= 1)
3. The o/e ratio and its confidence interval are computed
4. pLI uses a mixture model with three categories: null (LoF tolerated), recessive (heterozygous LoF tolerated), haploinsufficient (heterozygous LoF not tolerated)

## Combining Constraint with Variant Interpretation

| Gene Constraint | Variant Type | Impact on Interpretation |
|-----------------|-------------|--------------------------|
| pLI >= 0.9 + LoF variant | frameshift/nonsense/splice | Strong support for pathogenicity (PVS1 applicable) |
| pLI >= 0.9 + missense | missense | Gene is LoF-intolerant, but doesn't directly inform missense pathogenicity |
| mis_z > 3.09 + missense | missense | Supporting evidence for pathogenicity (PP2) |
| pLI < 0.5 + LoF variant | any LoF | Gene tolerates LoF — less likely to be pathogenic via haploinsufficiency |

## Sources

- Karczewski et al. 2020, *Nature* 581:434-443 (gnomAD v2 constraint)
- Samocha et al. 2014, *Nat Genet* 46:944-950 (original constraint model)
- gnomAD browser: `gnomad-browser/browser/src/ConstraintTable/GnomadConstraintTable.tsx`
- MCP implementation: `gmd-api/agent/tools/interpretation.go` lines 216-220 (pLI >= 0.9 threshold)
