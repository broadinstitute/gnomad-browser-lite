// Static catalog of every planned `gbl qc` check.
//
// This is the single source the /qc page renders even when a check has no
// result in report.json yet. For each catalog entry the page looks up a
// matching result by `id`:
//   - found   → render real status + metric (+ plot when present)
//   - missing → render a grey "Not yet implemented" placeholder using the
//               description + intended plot below.
//
// Adding a real check later is purely additive: when a new `id` appears in
// report.json its card lights up with NO change here or on the page.
//
// Source of truth for ids/logic/plots:
//   skills/qc-validity-builder/references/check-catalog.md
//   docs/spec/qc/00-design-reference.md

import type { QCTier } from '../api/types';

export interface CatalogCheck {
  id: string;
  name: string;
  tier: QCTier;
  category: string;
  /** One-line description shown on placeholder cards. */
  description: string;
  /** Intended plot type from the catalog (rendered later; named on placeholders now). */
  plot?: string;
  /** Input dependencies, e.g. 'reference', 'consequences', 'globals'. */
  needs?: string[];
}

export interface TierMeta {
  tier: QCTier;
  title: string;
  subtitle: string;
  /** Marks the whole tier as not-yet-built (Tier 3 cross-partner). */
  future?: boolean;
}

export const TIERS: TierMeta[] = [
  {
    tier: 1,
    title: 'Technical validity',
    subtitle:
      'Mathematically guaranteed if the stats were computed correctly — any violation is a bug (hard FAIL).',
  },
  {
    tier: 2,
    title: 'Biological plausibility',
    subtitle:
      'Distributions that should hold for real human sequencing data (WARN when out of band).',
  },
  {
    tier: 3,
    title: 'Cross-partner',
    subtitle: 'Run centrally across partner reports via `gbl qc cross`.',
    future: true,
  },
];

export const CHECK_CATALOG: CatalogCheck[] = [
  // ---- Tier 1: technical validity ----
  {
    id: 'fields.required',
    name: 'Required fields present',
    tier: 1,
    category: 'schema',
    description:
      'AC, AN, nhomalt, and the per-ancestry / per-sex strata are all present in the schema.',
  },
  {
    id: 'fields.retired-terms',
    name: 'No retired terminology',
    tier: 1,
    category: 'schema',
    description:
      'Rejects retired labels (oth, other, pop, population) in freq metadata / globals.',
    needs: ['globals'],
  },
  {
    id: 'fields.contigs-grch38',
    name: 'GRCh38 contigs only',
    tier: 1,
    category: 'schema',
    description: 'Every locus contig belongs to the GRCh38 primary-assembly enum.',
  },
  {
    id: 'fields.biallelic',
    name: 'Biallelic sites',
    tier: 1,
    category: 'schema',
    description: 'Every site has exactly two alleles (reference + a single alternate).',
  },
  {
    id: 'arith.ac-le-an',
    name: 'AC ≤ AN',
    tier: 1,
    category: 'arithmetic',
    description: 'No stratum reports an allele count above the allele number, or a negative count.',
    needs: ['globals'],
  },
  {
    id: 'arith.af-consistent',
    name: 'AF = AC / AN',
    tier: 1,
    category: 'arithmetic',
    description: 'Allele frequency matches AC/AN within tolerance; AF is defined iff AN > 0.',
    needs: ['globals'],
  },
  {
    id: 'arith.subgroup-sums',
    name: 'Subgroup sums',
    tier: 1,
    category: 'arithmetic',
    description: 'Allele counts and numbers of the ancestry strata sum to the global AC / AN.',
    needs: ['globals'],
  },
  {
    id: 'arith.nhomalt-le-half-ac',
    name: 'nhomalt ≤ AC / 2',
    tier: 1,
    category: 'arithmetic',
    description: 'The homozygote count never exceeds half the allele count.',
    needs: ['globals'],
  },
  {
    id: 'complete.chromosomes',
    name: 'All chromosomes present',
    tier: 1,
    category: 'completeness',
    description: 'Every autosome plus X (and Y when expected) is represented with a plausible count.',
  },
  {
    id: 'complete.missingness',
    name: 'Field missingness < 50%',
    tier: 1,
    category: 'completeness',
    description: 'No required field is missing in more than half of the scanned sites.',
  },
  {
    id: 'complete.filter-pass-ratio',
    name: 'Filter PASS ratio',
    tier: 1,
    category: 'completeness',
    description: 'The PASS / total variant ratio matches the reference expectation.',
    needs: ['reference'],
  },

  // ---- Tier 2: biological plausibility ----
  {
    id: 'bio.titv',
    name: 'Ti / Tv ratio',
    tier: 2,
    category: 'biological',
    description: 'Transition / transversion ratio over biallelic SNVs falls in the expected band.',
    plot: 'bar',
  },
  {
    id: 'bio.snv-indel-ratio',
    name: 'SNV / indel ratio',
    tier: 2,
    category: 'biological',
    description: 'Counts by allele-length class sit near the expected ~7:1 SNV-to-indel ratio.',
    plot: 'bar',
  },
  {
    id: 'bio.variant-counts-by-chrom',
    name: 'Variant counts by chromosome',
    tier: 2,
    category: 'biological',
    description: 'Per-contig variant counts scale roughly with chromosome length.',
    plot: 'bar',
  },
  {
    id: 'bio.sfs',
    name: 'Site frequency spectrum',
    tier: 2,
    category: 'biological',
    description: 'AC / AF bins form the expected L-shape; the singleton fraction sits in band.',
    plot: 'bar (log y)',
  },
  {
    id: 'bio.inbreeding-f',
    name: 'Inbreeding coefficient',
    tier: 2,
    category: 'biological',
    description: 'The per-site inbreeding-F distribution is centered near zero with a bounded tail.',
    plot: 'histogram',
    needs: ['globals'],
  },
  {
    id: 'bio.an-uniformity',
    name: 'AN uniformity',
    tier: 2,
    category: 'biological',
    description: 'Mean AN is uniform across autosomes; chrX ~0.75× and chrY low, as expected.',
    plot: 'bar + line',
    needs: ['globals'],
  },
  {
    id: 'bio.af-concordance',
    name: 'AF concordance',
    tier: 2,
    category: 'biological',
    description: 'Allele frequencies of shared variants correlate with the reference (r > 0.95).',
    plot: 'scatter',
    needs: ['reference'],
  },
  {
    id: 'bio.known-variant-fraction',
    name: 'Known-variant fraction',
    tier: 2,
    category: 'biological',
    description: 'The fraction of partner variants also present in the reference sits in band.',
    needs: ['reference'],
  },
  {
    id: 'bio.variant-type-dist',
    name: 'Variant consequence mix',
    tier: 2,
    category: 'biological',
    description: 'Consequence-class fractions (SNV %, syn:mis ratio, pLoF %) match expectation.',
    plot: 'bar',
    needs: ['consequences'],
  },
  {
    id: 'bio.chrxy',
    name: 'Sex-chromosome metrics',
    tier: 2,
    category: 'biological',
    description: 'No homozygotes on chrY; chrX non-PAR global nhomalt equals nhomalt_XX.',
    needs: ['globals'],
  },

  // ---- Tier 3: cross-partner (deferred) ----
  {
    id: 'cross.af-correlation',
    name: 'Cross-partner AF correlation',
    tier: 3,
    category: 'cross',
    description: 'Common-variant AF correlates across partners within each matched ancestry.',
    plot: 'scatter',
  },
  {
    id: 'cross.variant-burden',
    name: 'Variant burden',
    tier: 3,
    category: 'cross',
    description: 'Counts partner-unique variants and flags burden outliers.',
    plot: 'bar',
  },
  {
    id: 'cross.cmh-batch',
    name: 'CMH batch effect',
    tier: 3,
    category: 'cross',
    description: 'Cochran–Mantel–Haenszel test for batch effects, stratified by ancestry.',
  },
  {
    id: 'cross.ancestry-composition',
    name: 'Ancestry composition',
    tier: 3,
    category: 'cross',
    description: 'Per-partner ancestry shares compared against expectation.',
    plot: 'bar',
  },
];

export function catalogByTier(tier: QCTier): CatalogCheck[] {
  return CHECK_CATALOG.filter((c) => c.tier === tier);
}
