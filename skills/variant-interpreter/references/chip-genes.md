# CHIP Genes — Clonal Hematopoiesis Warning

## What is CHIP?

Clonal Hematopoiesis of Indeterminate Potential (CHIP) refers to the expansion of blood cell clones carrying somatic mutations. These mutations are acquired (not inherited) and accumulate with age, particularly in blood-forming stem cells.

## CHIP Gene List

The following genes are the most commonly affected by clonal hematopoiesis:

| Gene | Full Name | Role |
|------|-----------|------|
| **ASXL1** | ASXL Transcriptional Regulator 1 | Chromatin modification |
| **DNMT3A** | DNA Methyltransferase 3 Alpha | DNA methylation |
| **TET2** | Tet Methylcytosine Dioxygenase 2 | DNA demethylation |

## Warning Logic

When a variant is found in one of these genes:

> **WARNING**: Gene {GENE} is associated with clonal hematopoiesis. Somatic variants in this gene can appear in blood-derived DNA and may not be germline. If this variant was identified from a blood/saliva sample, consider:
> 1. Confirming with a non-blood tissue sample (e.g., fibroblasts)
> 2. Checking the variant allele fraction — CHIP variants often have VAF < 0.3
> 3. Considering the patient's age — CHIP prevalence increases significantly after age 60

## Why This Matters for Variant Interpretation

- gnomAD is derived primarily from blood-derived DNA
- CHIP variants can appear as "germline" in gnomAD when they are actually somatic
- A variant in DNMT3A/TET2/ASXL1 with low allele fraction may be a somatic CHIP mutation rather than a constitutional variant
- This affects frequency-based evidence: the variant's apparent population frequency may be inflated by somatic occurrences

## Sources

- Jaiswal et al. 2014, *NEJM* 371:2488-2498 (CHIP discovery)
- Implementation: `gmd-api/agent/tools/interpretation.go` line 175
