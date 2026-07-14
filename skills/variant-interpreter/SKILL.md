---
name: variant-interpreter
description: Guide through ACMG-style clinical variant interpretation using gnomAD frequency, constraint, pext, and in silico data.
metadata:
  ecosystem: genohype
  mcp-server: gnomad-browser-lite
  mcp-tools:
    - get_variant_details
    - get_gene_summary
    - interpret_variant_pathogenicity
---

# Variant Interpreter

You are acting as a clinical bioinformatics assistant. Your goal is to evaluate the potential pathogenicity of a genetic variant using gnomAD data, following the ACMG/AMP framework.

This skill produces the same interpretation as the `interpret_variant_pathogenicity` MCP tool, but with full reasoning transparency. Both paths use the same reference documents as their source of truth.

## Step 1: Data Acquisition

1. Identify the variant. Accept formats: `1-55516888-G-A`, `chr1:55516888:G:A`, or rsID.
2. Determine the dataset (default: `gnomad_r4`).

**If MCP is available** (check for `gnomad-browser-lite` server):
- Call `get_variant_details(variant_id, dataset)` to retrieve the full variant record.

**If MCP is unavailable** (CLI fallback):
- Execute `genohype query <dataset_path> --filter "locus == '<variant_id>'"` to get the raw JSON record.
- Parse the JSON output for the fields needed in subsequent steps.

## Step 2: Quality Checks

Read `references/loftee-flags.md` and `references/chip-genes.md`.

1. **Variant-level flags**: Check the `flags` array. If `lcr` is present, warn that the variant is in a low complexity region prone to sequencing artifacts.
2. **QC filters**: Check `exome.filters` and `genome.filters`. If any value is not `PASS`, flag immediately — the variant did not pass gnomAD's quality control.
3. **CHIP genes**: Check the gene symbol against the CHIP gene list (ASXL1, DNMT3A, TET2). If matched, append a somatic mutation warning — variants in these genes in blood-derived DNA may be clonal hematopoiesis, not germline.

## Step 3: Allele Frequency Analysis

Read `references/acmg-frequency.md`.

1. Extract the **maximum Filtering Allele Frequency (FAFmax)** across all populations.
   - FAF is preferred over raw AF because it accounts for sampling uncertainty.
2. Apply ACMG frequency thresholds:
   - **BA1 (Stand-alone Benign)**: FAFmax >= 5% (0.05). Variant is too common to cause rare disease.
   - **BS1 (Strong Benign)**: FAFmax >= 1% (0.01). Unlikely to cause rare Mendelian disease.
   - **Rare**: FAFmax < 1%. Consistent with a role in rare disease, but most rare variants are benign.
3. **Disease-specific threshold** (if user provides disease parameters):
   - Ask for: prevalence, inheritance mode (dominant/recessive), penetrance, genetic heterogeneity.
   - Calculate the Maximum Credible Allele Frequency using the **Whiffin formula** from the reference doc.
   - Compare FAFmax against this calculated threshold.

Report the exome AC/AN/AF and genome AC/AN/AF along with the population showing highest frequency.

## Step 4: Consequence and LOFTEE

Read `references/loftee-flags.md`.

1. Find the **canonical transcript** consequence (or MANE Select if available).
2. Identify the `major_consequence` (e.g., `missense_variant`, `frameshift_variant`, `stop_gained`).
3. For **high-impact consequences** (frameshift, nonsense, splice_acceptor, splice_donor, stop_gained):
   - Check the LOFTEE annotation:
     - `LOF == "LC"`: Low confidence pLoF — may not actually impact gene function.
     - `LOFFilter != "PASS"`: LOFTEE filtered this variant — likely does not impact gene function.
   - If LOFTEE is high confidence and passes filters, this is a strong signal for pathogenicity.
4. Report PolyPhen-2 and SIFT predictions if available on the transcript.

## Step 5: Gene Constraint

1. **If MCP is available**: Call `get_gene_summary(gene_symbol)` to retrieve constraint data.
2. **If MCP is unavailable**: Extract constraint metrics from the variant payload or query separately.
3. Evaluate:
   - **pLI >= 0.9**: Gene IS intolerant to loss-of-function variants (haploinsufficient).
   - **pLI < 0.9**: Gene is NOT known to be highly LoF-intolerant.
   - Also note LOEUF if available (lower = more constrained; < 0.35 is highly intolerant).

A high-impact variant in a highly constrained gene has a stronger prior for pathogenicity.

## Step 6: Transcript Expression (Pext) Analysis

Read `references/pext-interpretation.md`.

1. Find the mean pext score for the region containing the variant.
2. Cross-reference pext with the variant consequence:
   - **High-impact + pext < 0.1**: WARNING — this is a weakly expressed region. The high-impact annotation is likely a false positive or annotation error. Significantly reduces pathogenicity likelihood.
   - **High-impact + pext >= 0.9**: Constitutively expressed region — increases likelihood of functional impact.
   - **Missense + pext >= 0.9**: Highly expressed region, suggesting functional importance — increases likelihood of deleterious effect.
   - **Any variant + pext < 0.1**: Weakly expressed region — may indicate limited functional impact.

## Step 7: In Silico Predictors

Read `references/in-silico-thresholds.md`.

1. Extract scores for each available predictor from the variant data.
2. For each predictor, classify as **Benign** (green), **Uncertain** (yellow), or **Pathogenic** (red) using the three-tier thresholds from the reference document.
3. Track the consensus: count pathogenic vs benign predictions.
   - **Majority pathogenic**: Overall supports pathogenicity.
   - **Majority benign**: Overall supports benign impact.
   - **Split**: No clear consensus.
4. Note any predictor flags (e.g., `has_duplicate` for multiple scores).

## Step 8: Synthesis and Report

1. **If the `interpret_variant_pathogenicity` MCP tool is available**: Call it now to get the deterministic fast-path result. Compare its output with your manual step-by-step reasoning. Note any discrepancies.

2. **Generate a final report** with these sections:
   - **Variant**: ID, gene, consequence, transcript
   - **Quality**: Flags, QC filter status, CHIP warning if applicable
   - **Allele Frequency**: FAFmax, ACMG frequency classification (BA1/BS1/Rare), population context
   - **Functional Impact**: LOFTEE status, gene constraint (pLI/LOEUF)
   - **Expression**: Pext score and interpretation
   - **In Silico Consensus**: Per-predictor scores and overall consensus
   - **Warnings**: All accumulated warnings
   - **Conclusion**: Preliminary assessment with recommendation for clinical correlation

Always conclude with: *"This is a preliminary computational assessment. Clinical correlation with patient phenotype is required for definitive classification."*

## When to Use This Skill

- A researcher asks "Is this variant pathogenic?"
- A clinician wants to evaluate a candidate variant from exome/genome sequencing
- Triaging variants from a VCF for clinical review
- Understanding why gnomAD flags a variant in a particular way

## Limitations

- This skill provides a **preliminary** assessment, not a definitive ACMG classification
- Full ACMG classification requires additional evidence not available in gnomAD alone (functional studies, segregation data, de novo status)
- For automated full 28-criteria ACMG classification, use `fastvep annotate --acmg` (see the fastVEP ACMG documentation)
- ClinVar concordance should be checked separately
