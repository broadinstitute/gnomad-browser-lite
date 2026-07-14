# In Silico Predictor Thresholds

gnomAD uses a three-tier color system for in silico predictors: green (benign), yellow (uncertain/warning), red (pathogenic/danger). Scores are compared against two thresholds to determine the tier.

## gnomAD v4 Predictors (PREDICTORS_V4)

| Predictor | Warning Threshold | Danger Threshold | Absolute Value | Description |
|-----------|-------------------|------------------|----------------|-------------|
| **REVEL** (`revel_max`) | 0.644 | 0.773 | No | Rare Exome Variant Ensemble Learner. Missense-only. Calibrated per Pejaver 2022. |
| **CADD** | 25.3 | 28.1 | No | Combined Annotation Dependent Depletion. All variant types. |
| **SpliceAI** (`spliceai_ds_max`) | 0.2 | 0.5 | No | Splice site disruption. Max delta score across acceptor/donor gain/loss. |
| **Pangolin** (`pangolin_largest_ds`) | 0.2 | 0.5 | Yes | Splice prediction. Uses absolute value of largest delta score. |
| **phyloP** | 7.367 | 9.741 | No | Conservation score. Higher = more conserved across species. |
| **PolyPhen (max)** (`polyphen_max`) | 0.978 | 0.999 | No | Missense functional impact. Max across transcripts. |

### Interpretation

For each predictor score:
- **Score >= Danger threshold**: RED — Supports pathogenicity (high impact)
- **Score >= Warning threshold**: YELLOW — Uncertain significance (moderate impact)
- **Score < Warning threshold**: GREEN — Supports benign impact (low impact)

For Pangolin, apply `abs(score)` before comparing against thresholds.

## gnomAD v3 / Legacy Predictors

| Predictor | Warning Threshold | Danger Threshold | Description |
|-----------|-------------------|------------------|-------------|
| **REVEL** (`revel`) | 0.5 | 0.75 | Older REVEL thresholds (pre-calibration) |
| **CADD** | 10 | 20 | Older CADD thresholds |
| **PrimateAI** | 0.5 | 0.7 | Primate conservation-based predictor |
| **SpliceAI** (`splice_ai`) | 0.5 | 0.8 | Older SpliceAI thresholds |

## REVEL for ACMG Classification (ClinGen SVI Calibrated)

When performing formal ACMG classification, REVEL has calibrated strength tiers (Pejaver 2022). These are more granular than the browser display thresholds:

| REVEL Score | PP3 (Pathogenic) | BP4 (Benign) |
|-------------|------------------|--------------|
| >= 0.932 | Strong | — |
| >= 0.773 | Moderate | — |
| >= 0.644 | Supporting | — |
| <= 0.290 | — | Supporting |
| <= 0.183 | — | Moderate |
| <= 0.016 | — | Strong |
| <= 0.003 | — | **Very Strong** |

REVEL is the only calibrated tool that reaches Very Strong for BP4.

**Important**: REVEL is only applicable to missense variants. Do not apply REVEL scores to synonymous, nonsense, frameshift, or splice variants.

## Consensus Scoring

After scoring each predictor individually:
1. Count how many predict pathogenic (score >= danger threshold).
2. Count how many predict benign (score < warning threshold).
3. Determine consensus:
   - **Majority pathogenic** (pathogenic > total/2): Overall supports pathogenicity
   - **Majority benign** (benign > total/2): Overall supports benign impact
   - **Otherwise**: No clear consensus

## Predictor Flags

- `has_duplicate`: Variant has multiple scores for this predictor (e.g., from different transcript models). The displayed value is typically the max.

## Sources

- gnomAD browser: `gnomad-browser/browser/src/VariantPage/VariantInSilicoPredictors.tsx` (PREDICTORS_V4 lines 22-60)
- MCP implementation: `gmd-api/agent/tools/interpretation.go` lines 310-372
- Pejaver V, et al. 2022, *Am J Hum Genet* 109:2163-2177 (REVEL calibration)
- Walker LC, et al. 2023, *Am J Hum Genet* 110:1046-1067 (SpliceAI for ACMG)
