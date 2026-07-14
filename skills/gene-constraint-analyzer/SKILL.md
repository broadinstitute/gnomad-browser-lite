---
name: gene-constraint-analyzer
description: Evaluate a gene's tolerance to loss-of-function and missense variation using gnomAD constraint metrics.
metadata:
  ecosystem: genohype
  mcp-server: gnomad-browser-lite
  mcp-tools:
    - get_gene_summary
---

# Gene Constraint Analyzer

You are evaluating a gene's tolerance to genetic variation. Constraint metrics measure whether a gene has fewer damaging variants than expected — genes under strong selection pressure against LoF or missense variants are more likely to be disease-relevant.

## Step 1: Data Acquisition

1. Identify the target gene by symbol (e.g., `BRCA1`) or Ensembl ID (e.g., `ENSG00000012048`).

**If MCP is available** (check for `gnomad-browser-lite` server):
- Call `get_gene_summary(gene)` to retrieve the full gene record including constraint data.

**If MCP is unavailable** (CLI fallback):
- Execute `genohype query <dataset_path> --filter "gene_symbol == '<gene>'"` and extract the `constraint` object from the result.

## Step 2: Loss-of-Function (LoF) Constraint

Read `references/constraint-metrics.md`.

1. Extract `pLI` (Probability of being LoF Intolerant) and `oe_lof_upper` (LOEUF — LoF observed/expected upper bound).
2. Evaluate:
   - **pLI >= 0.9**: Gene IS intolerant to heterozygous loss-of-function. This means haploinsufficiency is likely — losing one copy of this gene is deleterious. LoF variants in this gene have a strong prior for pathogenicity.
   - **pLI < 0.9**: Gene is NOT known to be highly intolerant to LoF.
3. LOEUF provides a continuous metric (preferred over the binary pLI):
   - **LOEUF < 0.35**: Highly constrained — equivalent to pLI >= 0.9 territory.
   - **LOEUF 0.35 - 0.66**: Moderately constrained.
   - **LOEUF > 1.0**: Not constrained — LoF variants are tolerated.
4. Report observed vs expected LoF counts (`obs_lof` / `exp_lof`) and the o/e ratio with confidence interval.

### LOEUF Color Bands (gnomAD browser)

| LOEUF Range | Color | Interpretation |
|-------------|-------|----------------|
| < 0.33 | Red | Highly intolerant to LoF |
| 0.33 - 0.66 | Orange | Moderately intolerant to LoF |
| 0.66 - 1.0 | Yellow | Some constraint signal |
| >= 1.0 | None | Not constrained |

## Step 3: Missense Constraint

Read `references/constraint-metrics.md`.

1. Extract `mis_z` (Missense Z-score) and the missense o/e ratio with confidence interval.
2. Evaluate:
   - **mis_z > 3.09**: Gene is significantly intolerant to missense variation. Missense variants in this gene are more likely to be deleterious. This threshold corresponds to p < 0.001 (one-tailed).
   - **mis_z 2.0 - 3.09**: Moderate constraint signal.
   - **mis_z < 2.0**: No significant missense constraint.
3. Report observed vs expected missense counts.

## Step 4: Synonymous Baseline

1. Extract `syn_z` (Synonymous Z-score).
2. Check that synonymous constraint is not extreme:
   - **syn_z > 3.71**: Flagged — more synonymous variants than expected, which may indicate data quality issues or unusual mutational patterns. Constraint metrics for this gene may be unreliable.
   - **Highly negative syn_z**: Fewer synonymous variants than expected — may indicate coverage issues.
3. Synonymous o/e should be close to 1.0. Significant deviation undermines confidence in the mutational model.

## Step 5: Quality and Outlier Flags

Read `references/constraint-flags.md`.

1. Check the `flags` array in the constraint data.
2. If any flags are present, explicitly warn that constraint metrics may be unreliable:

| Flag | Meaning | Impact |
|------|---------|--------|
| `no_variants` | Zero observed synonymous, missense, AND pLoF variants | Constraint cannot be calculated — gene likely has coverage issues |
| `no_exp_lof` | Zero expected pLoF variants | Gene is too short to calculate LoF constraint |
| `no_exp_mis` | Zero expected missense variants | Gene is too short to calculate missense constraint |
| `no_exp_syn` | Zero expected synonymous variants | Gene is too short for any constraint calculation |
| `lof_too_many` / `outlier_lof` | More pLoF variants than expected | Gene may have unusual mutational properties |
| `mis_too_many` / `outlier_mis` | More missense variants than expected | Gene may have unusual mutational properties |
| `syn_outlier` / `outlier_syn` | Unusual number of synonymous variants | Mutational model may not fit this gene |

## Step 6: Report Generation

Generate a constraint summary with:

1. **Gene**: Symbol, Ensembl ID
2. **LoF Constraint**: pLI score, LOEUF (with color band), obs/exp counts, interpretation
3. **Missense Constraint**: Z-score, obs/exp counts, interpretation
4. **Synonymous Baseline**: Z-score, obs/exp counts, any concerns
5. **Flags**: Any quality warnings
6. **Clinical Implication**: A plain-language summary of what this means:
   - For highly constrained genes: "This gene is highly intolerant to LoF, supporting pathogenicity of frameshift/nonsense/splice variants"
   - For missense-constrained genes: "This gene is constrained against missense variation, increasing the prior for missense variants to be damaging"
   - For unconstrained genes: "This gene tolerates LoF/missense variation, which does not support pathogenicity based on constraint alone"

## When to Use This Skill

- Evaluating whether a gene is a plausible disease gene
- Interpreting the significance of a LoF or missense variant in context of gene constraint
- Comparing constraint profiles across candidate genes
- Understanding why gnomAD displays certain constraint colors/badges
