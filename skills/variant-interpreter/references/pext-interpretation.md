# Pext (Proportion Expression across Transcripts) Interpretation

Pext quantifies how much a given exonic region is expressed across GTEx tissues. It helps distinguish genuinely impactful variants from annotation artifacts caused by weakly expressed transcript isoforms.

## Key Rules

### Rule 1: High-impact variant + pext < 0.1 = Likely annotation error

If a variant has a high-impact consequence (frameshift, nonsense, splice_acceptor, splice_donor, stop_gained) but lies in a region with mean pext < 0.1 across GTEx tissues:

**WARNING**: This significantly reduces the likelihood of it being a true pathogenic loss-of-function variant. The high-impact annotation is likely driven by a transcript isoform that is rarely expressed in any tissue. This is a common source of false-positive pLoF calls.

### Rule 2: High-impact variant + pext >= 0.9 = Constitutively expressed

A high-impact variant in a region with pext >= 0.9 is in a constitutively expressed region. This increases the likelihood of genuine functional impact — the exon is actively used in most or all tissues.

### Rule 3: Missense variant + pext >= 0.9 = Functionally important region

A missense variant in a highly expressed region (pext >= 0.9) suggests the affected protein region is functionally important, increasing the likelihood of a deleterious effect.

### Rule 4: Any variant + pext < 0.1 = Weakly expressed

Regardless of consequence type, a variant in a region with pext < 0.1 may have limited functional impact because the region is rarely included in mature transcripts.

## Pext Score Interpretation

| Pext Score | Interpretation |
|------------|----------------|
| **>= 0.9** | Constitutively expressed — region is actively used in most tissues |
| **0.5 - 0.9** | Moderately expressed — region is used in some tissues/isoforms |
| **0.1 - 0.5** | Weakly expressed — region is used in minority of transcripts |
| **< 0.1** | Rarely expressed — region is mostly absent from mature transcripts |

## How Pext is Calculated

- Pext = proportion of total gene expression attributable to transcripts that include a given base position
- Derived from GTEx RNA-seq data across 53 tissues
- The `mean` value averages across all tissues
- Tissue-specific pext values are also available for targeted analysis

## Clinical Significance

Pext is especially important for:
1. **Filtering false-positive pLoF variants**: Many apparent loss-of-function variants in gnomAD fall in weakly expressed exons and are unlikely to have functional impact.
2. **Prioritizing variants for follow-up**: Variants in constitutively expressed regions deserve more scrutiny.
3. **Resolving discrepancies**: When a variant looks pathogenic by consequence but has high population frequency, low pext can explain the discrepancy.

## Sources

- Cummings et al. 2020, *Nature* 581:434-443 (transcript expression-aware annotation)
- Implementation: `gmd-api/agent/tools/interpretation.go` lines 254-269
