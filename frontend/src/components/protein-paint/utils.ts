/**
 * Protein-Paint Style Lollipop Visualization - Utilities
 *
 * Inspired by ProteinPaint from St. Jude Children's Research Hospital
 * Reference: Zhou et al., Nature Genetics 48, 4–6 (2016)
 * https://doi.org/10.1038/ng.3466
 *
 * This is a clean-room reimplementation using D3.js, not derived from
 * ProteinPaint source code. Visual design concepts are adapted with
 * attribution per academic conventions.
 */

import { forceSimulation, forceX, forceCollide } from 'd3-force';
import type { Variant } from '../../api/types';
import type { LollipopData, LayoutParams } from './types';
import {
  getVariantPosition,
  getVariantColor,
  getConsequencePriority,
} from '../variantUtils';

/**
 * Get layout parameters based on dimensions
 */
export function getLayoutParams(height: number): LayoutParams {
  return {
    minRadius: 4,
    maxRadius: 14,
    topTierCount: 15, // Number of labeled lollipops in top tier
    bottomTierY: height - 15, // Bottom tier near baseline
    topTierY: 100, // Top tier at fixed 100px from top
  };
}

/**
 * Calculate disc radius based on variant count using log scale
 */
function calculateDiscRadius(
  count: number,
  maxCount: number,
  params: LayoutParams
): number {
  if (count <= 1) {
    return params.minRadius;
  }

  const logCount = Math.log(count);
  const logMax = Math.log(Math.max(maxCount, 2));
  const normalized = logCount / logMax;

  return params.minRadius + normalized * (params.maxRadius - params.minRadius);
}

/**
 * Parse hgvsp to extract short label (e.g., "p.Val600Glu" -> "V600E")
 */
function parseHgvspLabel(hgvsp: string | undefined): string {
  if (!hgvsp) return '';

  // Handle "p.Val600Glu" format - convert to single letter
  const match = hgvsp.match(/p\.([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})/);
  if (match) {
    const aa3to1: Record<string, string> = {
      Ala: 'A', Arg: 'R', Asn: 'N', Asp: 'D', Cys: 'C',
      Glu: 'E', Gln: 'Q', Gly: 'G', His: 'H', Ile: 'I',
      Leu: 'L', Lys: 'K', Met: 'M', Phe: 'F', Pro: 'P',
      Ser: 'S', Thr: 'T', Trp: 'W', Tyr: 'Y', Val: 'V',
      Ter: '*',
    };
    const ref = aa3to1[match[1]] || match[1];
    const pos = match[2];
    const alt = aa3to1[match[3]] || match[3];
    return `${ref}${pos}${alt}`;
  }

  // Handle "p.V600E" format (already single letter)
  const shortMatch = hgvsp.match(/p\.([A-Z])(\d+)([A-Z*])/);
  if (shortMatch) {
    return `${shortMatch[1]}${shortMatch[2]}${shortMatch[3]}`;
  }

  // Handle synonymous "p.Val600=" format
  const synMatch = hgvsp.match(/p\.([A-Z][a-z]{2})(\d+)=/);
  if (synMatch) {
    const aa3to1: Record<string, string> = {
      Ala: 'A', Arg: 'R', Asn: 'N', Asp: 'D', Cys: 'C',
      Glu: 'E', Gln: 'Q', Gly: 'G', His: 'H', Ile: 'I',
      Leu: 'L', Lys: 'K', Met: 'M', Phe: 'F', Pro: 'P',
      Ser: 'S', Thr: 'T', Trp: 'W', Tyr: 'Y', Val: 'V',
    };
    const ref = aa3to1[synMatch[1]] || synMatch[1];
    return `${ref}${synMatch[2]}=`;
  }

  // Handle short synonymous "p.V600=" format
  const shortSynMatch = hgvsp.match(/p\.([A-Z])(\d+)=/);
  if (shortSynMatch) {
    return `${shortSynMatch[1]}${shortSynMatch[2]}=`;
  }

  // Fallback: strip "p." prefix if present
  return hgvsp.replace(/^p\./, '');
}

/**
 * Estimate label width in pixels
 */
function estimateLabelWidth(label: string): number {
  // Approximate: 6px per character for 9px font
  return label.length * 6 + 4;
}

/**
 * Create lollipop data from variants, grouped by hgvsp
 */
export function createLollipops(
  variants: Variant[],
  scale: (pos: number) => number,
  params: LayoutParams
): LollipopData[] {
  // Group variants by position + hgvsp
  const groupMap = new Map<string, { pos: number; hgvsp: string; variants: Variant[] }>();

  for (const variant of variants) {
    const pos = getVariantPosition(variant);
    const hgvsp = variant.hgvsp || 'unknown';
    const key = `${pos}-${hgvsp}`;

    if (!groupMap.has(key)) {
      groupMap.set(key, { pos, hgvsp, variants: [] });
    }
    groupMap.get(key)!.variants.push(variant);
  }

  // Find max count for radius scaling
  let maxCount = 1;
  for (const group of groupMap.values()) {
    maxCount = Math.max(maxCount, group.variants.length);
  }

  // Create lollipop data
  const lollipops: LollipopData[] = [];

  for (const [key, group] of groupMap) {
    const { pos, hgvsp, variants: groupVariants } = group;
    const count = groupVariants.length;
    const label = parseHgvspLabel(hgvsp);

    // Determine color and priority from highest-priority variant
    // Also sum up allele counts across all variants in this group
    let color = '#757575';
    let priority = 0;
    let totalAC = 0;
    for (const v of groupVariants) {
      const p = getConsequencePriority(v.consequence || '');
      if (p > priority) {
        priority = p;
        color = getVariantColor(v);
      }
      // Sum allele count (AC) - the actual observation count in population
      totalAC += v.ac || 0;
    }

    // Priority: consequence class * 1000 + allele count
    // This prioritizes LoF first, then by how common the variant is
    const effectivePriority = priority * 1000 + Math.min(totalAC, 500);

    lollipops.push({
      id: key,
      pos,
      hgvsp,
      label,
      variants: groupVariants,
      count,
      radius: calculateDiscRadius(count, maxCount, params),
      color,
      priority: effectivePriority,
      anchorX: scale(pos),
      x: scale(pos),
      y: params.bottomTierY,
      labelWidth: estimateLabelWidth(label),
      isTopTier: false,
    });
  }

  return lollipops;
}

/**
 * Get tier based on consequence priority
 * Returns: 'lof' | 'missense' | 'synonymous' | 'noncoding'
 */
function getTier(priority: number): 'lof' | 'missense' | 'synonymous' | 'noncoding' {
  const consequencePriority = Math.floor(priority / 1000);
  if (consequencePriority >= 4) return 'lof';
  if (consequencePriority === 3) return 'missense';
  if (consequencePriority === 2) return 'synonymous';
  return 'noncoding';
}

/**
 * Assign lollipops to tiers based on consequence
 */
export function layoutLollipops(
  lollipops: LollipopData[],
  width: number,
  params: LayoutParams
): void {
  if (lollipops.length === 0) return;

  const height = params.bottomTierY + 15; // Approximate total height

  // Define Y positions for each tier
  const tierY = {
    lof: 80,                    // Top - LoF with labels
    missense: height * 0.45,    // Upper middle
    synonymous: height * 0.65,  // Lower middle
    noncoding: height * 0.82,   // Near bottom (above gene)
  };

  // Group by tier
  const tiers: Record<string, LollipopData[]> = {
    lof: [],
    missense: [],
    synonymous: [],
    noncoding: [],
  };

  for (const lollipop of lollipops) {
    const tier = getTier(lollipop.priority);
    tiers[tier].push(lollipop);
    lollipop.isTopTier = tier === 'lof'; // Only LoF gets special treatment
    lollipop.y = tierY[tier];
  }

  // Spread LoF evenly with labels
  if (tiers.lof.length > 0) {
    runTopTierForceLayout(tiers.lof, width, params);
  }
}

/**
 * Force layout for top tier that accounts for label width
 */
function runTopTierForceLayout(
  topTier: LollipopData[],
  width: number,
  params: LayoutParams
): void {
  // Sort by anchor position so they spread in order
  topTier.sort((a, b) => a.anchorX - b.anchorX);

  // Simple approach: spread evenly across the width
  const margin = 60;
  const availableWidth = width - 2 * margin;
  const spacing = topTier.length > 1 ? availableWidth / (topTier.length - 1) : 0;

  for (let i = 0; i < topTier.length; i++) {
    topTier[i].x = margin + i * spacing;
    topTier[i].y = params.topTierY;
  }
}

// Re-export for backward compatibility
export { getLayoutParams as getLayoutParamsLegacy };
export function groupVariants() { return []; }
export function runForceLayout() {}
