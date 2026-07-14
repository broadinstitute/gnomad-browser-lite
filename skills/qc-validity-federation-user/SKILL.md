---
name: qc-validity-federation-user
description: Run federation validity checks on a sites-only submission and interpret the QC report. Use when verifying that a partner ran proper QC on data they submitted as AC/AN/nhomalt without sharing genotypes.
metadata:
  ecosystem: genohype
  mcp-server: gnomad-browser-lite
  mcp-tools:
    - get_qc_report
---

# QC Verify (Federation)

You are helping verify a federation partner's **sites-only** submission — per-variant `AC`,
`AN`, `nhomalt` stratified by genetic-ancestry group and sex, with no individual genotypes. You
cannot re-run their genotype-level QC; you inspect aggregate statistics and judge whether they
look like the output of a properly-QC'd cohort.

Read `docs/spec/qc/README.md` for the problem→fingerprint model and the three tiers.

## Step 1: Run the checks

Given a sites file (`.ht`, `.vcf.bgz`, or Parquet; local, `gs://`, or `s3://`):

```bash
gbl qc run <source> --out qc-report.json
# Tier 1 only (fast, structural):        --tier 1
# add reference-dependent checks:        --reference gs://.../v4.1.sites.ht --checks bio.af-concordance,...
# threshold overrides:                   --config qc.toml
```

Everything runs in the partner's own environment; the report contains only aggregates and a
bounded sample of offending variant ids. Raw data does not move.

To review an already-generated report, read `qc-report.json` directly, or call the
`get_qc_report` MCP tool / `GET /api/qc-report` if a `gbl serve` deployment is configured.

## Step 2: Interpret by tier

- **Tier 1 (technical validity) — any FAIL is disqualifying.** These are mathematically
  guaranteed (`AC ≤ AN`, `AF = AC/AN`, subgroups sum to global, `nhomalt ≤ AC/2`) plus schema.
  A FAIL means a pipeline bug, not biology. Report the specific rule and the example variants.
- **Tier 2 (biological plausibility) — WARNs need judgment.** Compare each measured value to
  its band and translate the deviation into the likely upstream cause (see the table below). A
  WARN is a signal to investigate, not an automatic reject — it depends on N and ancestry mix.
- **Tier 3 (cross-partner)** — only meaningful once ≥2 nodes exist; currently deferred.

## Step 3: Translate WARNs into likely causes

| Signal in the report | Likely upstream problem |
|---|---|
| Low Ti/Tv, low known-variant %, high variant count | No / poor variant filtering |
| Inbreeding F ≪ 0 (excess het), distorted SFS, elevated singletons | Sample contamination |
| Excess doubletons / excess common variants | Relatives not removed |
| AF concordance failure vs gnomAD | Ancestry mislabeling |
| Homozygous-alt calls on chrY, chrX anomalies | Sex misassignment |
| Non-uniform AN, missing chromosomes | Coverage problems |
| Wrong counts, unexpected contigs, missing fields | Pipeline misconfiguration |

## Step 4: Report

Produce a summary: pass/warn/fail counts; each Tier-1 FAIL with rule + example variants; each
Tier-2 WARN with measured value, band, and the plain-language likely cause; and an overall
recommendation (accept / investigate / reject) — noting explicitly that the borderline call is
a **human** decision the methods team owns.

## Scale

If the sites file is very large, hand off to the **`gh-cluster`** and **`pool-analyzer`** skills
to run the scan on a distributed pool.

## When to use

- Verifying a new partner submission before it enters the federation.
- Re-checking a resubmission after a partner fixes flagged issues.
- Explaining *why* a submission was flagged, in terms of the upstream QC step that failed.
