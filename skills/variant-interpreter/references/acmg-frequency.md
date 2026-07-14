# ACMG Allele Frequency Thresholds

Allele frequency is the single most powerful piece of evidence in variant interpretation. A variant that is common in the general population cannot be the cause of a rare disease.

## Standard ACMG/AMP Thresholds

| Criterion | Threshold | Strength | Interpretation |
|-----------|-----------|----------|----------------|
| **BA1** | FAF >= 5% (0.05) | Stand-alone Benign | Too common for any rare Mendelian disease. Classification stops here. |
| **BS1** | FAF >= 1% (0.01) | Strong Benign | Greater than expected for any rare disorder. Strong evidence against pathogenicity. |
| **PM2** | Absent from gnomAD | Supporting Pathogenic | Rarity is consistent with pathogenicity, but most rare variants are benign. Downgraded from Moderate to Supporting per ClinGen SVI (Sept 2020). |

**Use Filtering Allele Frequency (FAF)**, not raw AF. FAF accounts for sampling uncertainty and provides a more conservative estimate. Take the maximum FAF across all populations.

**BA1 requires AN >= 2,000** per ClinGen SVI guidance (March 2024, gnomAD v4). If allele number is below this threshold, frequency criteria cannot be reliably applied.

### BA1 Exception List (Ghosh 2018)

Nine known-pathogenic variants have population frequencies above 5% and are exempt from BA1:
- HFE c.845G>A (p.Cys282Tyr) — hereditary hemochromatosis
- HFE c.187C>G (p.His63Asp)
- MEFV common variants (FMF)
- BTD c.1330G>C (biotinidase deficiency)
- And others listed in Ghosh et al. 2018

If a variant matches this exception list, BA1 does NOT apply regardless of frequency.

## Disease-Specific Thresholds: Whiffin Formula

For specific diseases, calculate a tighter maximum credible allele frequency using the Whiffin et al. formula. This replaces the generic BA1/BS1 thresholds with disease-appropriate cutoffs.

### Formula

**Dominant inheritance:**
```
maxAF = prevalence / (2 * penetrance * genetic_heterogeneity)
```

**Recessive inheritance:**
```
maxAF = sqrt(prevalence / (penetrance * genetic_heterogeneity))
```

### Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `prevalence` | Disease prevalence in the population (e.g., 1/10000 = 0.0001) | Required |
| `inheritance` | `"dominant"` or `"recessive"` | Required |
| `penetrance` | Proportion of carriers who develop disease (0-1) | 1.0 |
| `genetic_heterogeneity` | Proportion of disease caused by this gene (0-1) | 1.0 |

### Example

Hypertrophic cardiomyopathy (HCM) via MYBPC3:
- Prevalence: 1/500 (0.002)
- Inheritance: dominant
- Penetrance: 0.5
- Heterogeneity: 0.25 (MYBPC3 accounts for ~25% of HCM)

```
maxAF = 0.002 / (2 * 0.5 * 0.25) = 0.008 (0.8%)
```

Any variant with FAF > 0.8% is too common to be a pathogenic HCM variant in MYBPC3.

## Sources

- Richards et al. 2015, *Genet Med* 17:405-424 (ACMG/AMP guidelines)
- Whiffin et al. 2017, *Genet Med* 19:1151-1153 (maximum credible AF)
- Ghosh et al. 2018, *Hum Mutat* 39:1525-1530 (BA1 exceptions)
- ClinGen SVI PM2 Recommendation v1.0, September 2020 (PM2 downgrade)
- ClinGen SVI gnomAD v4 Guidance, March 2024 (AN >= 2,000 for BA1/BS1)
- Implementation: `gmd-api/agent/tools/interpretation.go` lines 20-39, 96-148
