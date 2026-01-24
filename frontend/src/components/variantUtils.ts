/**
 * Shared variant utility functions
 *
 * These utilities are used by both the scatter plot VariantTrack and
 * the Protein-Paint style lollipop visualization.
 */

import type { Variant, Exon } from '../api/types';

/**
 * Extract the genomic position from a variant object
 * Handles both flattened and legacy nested locus formats
 */
export function getVariantPosition(v: Variant): number {
  return v.pos || v.locus?.position || 0;
}

/**
 * Determine variant color based on VEP consequence
 * Uses gnomAD's classic consequence color scheme
 */
export function getVariantColor(variant: Variant): string {
  const consequence = variant.consequence?.toLowerCase() || '';

  // Loss of function (pLoF) - red
  if (
    consequence.includes('frameshift') ||
    consequence.includes('stop_gained') ||
    consequence.includes('splice_acceptor') ||
    consequence.includes('splice_donor') ||
    consequence.includes('start_lost')
  ) {
    return '#dd3333';
  }

  // Missense - orange
  if (consequence.includes('missense')) {
    return '#f59e0b';
  }

  // Synonymous - green
  if (consequence.includes('synonymous')) {
    return '#10b981';
  }

  // Non-coding - light gray
  if (
    consequence.includes('intron') ||
    consequence.includes('upstream') ||
    consequence.includes('downstream')
  ) {
    return '#a0aec0';
  }

  // Default - gray (other coding variants)
  return '#757575';
}

/**
 * Check if a genomic position falls within any exon region
 */
export function isInExonRegion(pos: number, exons: Exon[]): boolean {
  return exons.some((exon) => pos >= exon.start && pos <= exon.stop);
}

/**
 * Calculate variant radius based on log allele frequency
 * More common variants (higher AF) get larger circles
 */
export function getVariantRadius(af: number | undefined): number {
  const minRadius = 2;
  const maxRadius = 8;

  if (af === undefined || af === null || af === 0) {
    return minRadius;
  }

  // Log10 scale: AF ranges from ~1e-6 to 1
  // Map log10(AF) from [-6, 0] to [minRadius, maxRadius]
  const logAf = Math.log10(Math.max(af, 1e-6));
  const normalizedLog = (logAf + 6) / 6; // Maps [-6, 0] to [0, 1]
  const clampedNorm = Math.max(0, Math.min(1, normalizedLog));

  return minRadius + clampedNorm * (maxRadius - minRadius);
}

/**
 * Consequence priority for determining dominant color when grouping variants
 * Higher values = higher priority (shown on top)
 */
export function getConsequencePriority(consequence: string): number {
  const lc = consequence.toLowerCase();

  // pLoF - highest priority
  if (
    lc.includes('frameshift') ||
    lc.includes('stop_gained') ||
    lc.includes('splice_acceptor') ||
    lc.includes('splice_donor') ||
    lc.includes('start_lost')
  ) {
    return 4;
  }

  // Missense
  if (lc.includes('missense')) {
    return 3;
  }

  // Synonymous
  if (lc.includes('synonymous')) {
    return 2;
  }

  // Non-coding
  if (lc.includes('intron') || lc.includes('upstream') || lc.includes('downstream')) {
    return 0;
  }

  // Other coding
  return 1;
}
