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
import type { LollipopData, LayoutParams, StackedDisc } from './types';
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
 * Calculate disc radius based on allele frequency using log scale
 * AF typically ranges from very rare (1e-6) to common (0.5)
 */
function calculateDiscRadius(
  af: number,
  maxAf: number,
  params: LayoutParams
): number {
  // Use a minimum AF floor to avoid log(0) issues
  const minAf = 1e-7;
  const safeAf = Math.max(af, minAf);
  const safeMaxAf = Math.max(maxAf, minAf);

  // Log scale for AF (spans many orders of magnitude)
  const logAf = Math.log10(safeAf);
  const logMax = Math.log10(safeMaxAf);
  const logMin = Math.log10(minAf);

  // Normalize to 0-1 range
  const normalized = (logAf - logMin) / (logMax - logMin);

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
 * Create lollipop data from variants, grouped by position with stacked discs
 * Multi-allelic variants (different amino acid changes at same position) stack vertically
 */
export function createLollipops(
  variants: Variant[],
  scale: (pos: number) => number,
  params: LayoutParams
): LollipopData[] {
  // First, group variants by position
  const positionMap = new Map<number, Variant[]>();

  for (const variant of variants) {
    const pos = getVariantPosition(variant);
    if (!positionMap.has(pos)) {
      positionMap.set(pos, []);
    }
    positionMap.get(pos)!.push(variant);
  }

  // Find max AF across all hgvsp groups for radius scaling
  let maxAf = 0;
  for (const posVariants of positionMap.values()) {
    // Group by hgvsp within this position and sum AF
    const hgvspAfs = new Map<string, number>();
    for (const v of posVariants) {
      const hgvsp = v.hgvsp || 'unknown';
      const af = v.af || v.allele_freq || 0;
      hgvspAfs.set(hgvsp, (hgvspAfs.get(hgvsp) || 0) + af);
    }
    for (const af of hgvspAfs.values()) {
      maxAf = Math.max(maxAf, af);
    }
  }

  // Create lollipop data with stacked discs
  const lollipops: LollipopData[] = [];

  for (const [pos, posVariants] of positionMap) {
    // Group variants by hgvsp at this position
    const hgvspMap = new Map<string, Variant[]>();
    for (const v of posVariants) {
      const hgvsp = v.hgvsp || 'unknown';
      if (!hgvspMap.has(hgvsp)) {
        hgvspMap.set(hgvsp, []);
      }
      hgvspMap.get(hgvsp)!.push(v);
    }

    // Create a disc for each unique hgvsp
    const discs: StackedDisc[] = [];
    for (const [hgvsp, hgvspVariants] of hgvspMap) {
      const count = hgvspVariants.length;
      const label = parseHgvspLabel(hgvsp);

      // Determine color, priority, and sum AF from variants in this group
      let color = '#757575';
      let priority = 0;
      let totalAC = 0;
      let totalAF = 0;
      for (const v of hgvspVariants) {
        const p = getConsequencePriority(v.consequence || '');
        if (p > priority) {
          priority = p;
          color = getVariantColor(v);
        }
        totalAC += v.ac || 0;
        totalAF += v.af || v.allele_freq || 0;
      }

      // Priority: consequence class * 1000 + allele count
      const effectivePriority = priority * 1000 + Math.min(totalAC, 500);

      discs.push({
        hgvsp,
        label,
        variants: hgvspVariants,
        count,
        radius: calculateDiscRadius(totalAF, maxAf, params),
        color,
        priority: effectivePriority,
        stackY: 0,  // Will be calculated after sorting
      });
    }

    // Sort discs by priority (highest priority on top = first in array)
    discs.sort((a, b) => b.priority - a.priority);

    // Calculate stack positions (Y offset from top)
    let stackY = 0;
    const discSpacing = 2;  // Gap between stacked discs
    for (const disc of discs) {
      disc.stackY = stackY;
      stackY += disc.radius * 2 + discSpacing;
    }
    const stackHeight = stackY - discSpacing;  // Remove last spacing

    // Get properties from the top (highest priority) disc
    const topDisc = discs[0];
    const maxRadius = Math.max(...discs.map(d => d.radius));

    // Collect all variants at this position
    const allVariants = posVariants;

    lollipops.push({
      id: `pos-${pos}`,
      pos,
      discs,
      label: topDisc.label,
      variants: allVariants,
      count: allVariants.length,
      radius: maxRadius,
      color: topDisc.color,
      priority: topDisc.priority,
      anchorX: scale(pos),
      x: scale(pos),
      y: params.bottomTierY,
      stackHeight,
      labelWidth: estimateLabelWidth(topDisc.label),
      isTopTier: false,
      showLabel: false,
      labelAngle: 0,  // Will be set during layout
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
 * Get tier Y positions for a given height
 */
export function getTierPositions(height: number): Record<string, number> {
  return {
    lof: 60,                    // Top - LoF with labels (raised higher)
    missense: height * 0.55,    // Upper middle (pushed down for crank room)
    synonymous: height * 0.72,  // Lower middle
    noncoding: height * 0.85,   // Near bottom (above gene)
  };
}

/**
 * Assign lollipops to tiers based on consequence
 * The highest-severity tier present becomes the "top tier" with spread layout
 */
export function layoutLollipops(
  lollipops: LollipopData[],
  width: number,
  params: LayoutParams
): void {
  if (lollipops.length === 0) return;

  const height = params.bottomTierY + 15; // Approximate total height
  const tierY = getTierPositions(height);

  // Group by tier
  const tierOrder = ['lof', 'missense', 'synonymous', 'noncoding'] as const;
  const tiers: Record<string, LollipopData[]> = {
    lof: [],
    missense: [],
    synonymous: [],
    noncoding: [],
  };

  for (const lollipop of lollipops) {
    const tier = getTier(lollipop.priority);
    tiers[tier].push(lollipop);
    lollipop.y = tierY[tier];
  }

  // Find the highest-severity tier that has variants (becomes top tier)
  let topTierName: string | null = null;
  for (const tier of tierOrder) {
    if (tiers[tier].length > 0) {
      topTierName = tier;
      break;
    }
  }

  // Mark top tier variants and apply spread layout
  for (const lollipop of lollipops) {
    const tier = getTier(lollipop.priority);
    lollipop.isTopTier = tier === topTierName;
  }

  // Apply spread layout to top tier
  if (topTierName && tiers[topTierName].length > 0) {
    runTopTierForceLayout(tiers[topTierName], width, params);
  }

  // Apply opportunistic horizontal labels to lower tiers
  for (const tier of tierOrder) {
    if (tier !== topTierName && tiers[tier].length > 0) {
      resolveHorizontalLabels(tiers[tier], width);
    }
  }
}

/**
 * Resolve horizontal-only labels for lower tiers
 * Only shows labels where there's clear horizontal space
 */
function resolveHorizontalLabels(
  lollipops: LollipopData[],
  width: number
): void {
  // Sort by X position (anchorX for lower tiers)
  const sorted = [...lollipops].sort((a, b) => a.anchorX - b.anchorX);

  const labelGap = 8;  // More generous gap for lower tiers
  let rightBoundary = -Infinity;

  for (let i = 0; i < sorted.length; i++) {
    const lollipop = sorted[i];
    const labelStart = lollipop.anchorX + lollipop.radius + 3;
    const labelEnd = labelStart + lollipop.labelWidth;

    // Check space on left (from previous label/disc)
    const hasRoomOnLeft = labelStart >= rightBoundary + labelGap;

    // Check space on right (next disc's left edge)
    let hasRoomOnRight = true;
    if (i < sorted.length - 1) {
      const nextLollipop = sorted[i + 1];
      const nextDiscLeft = nextLollipop.anchorX - nextLollipop.radius;
      hasRoomOnRight = labelEnd + labelGap <= nextDiscLeft;
    } else {
      hasRoomOnRight = labelEnd <= width - 10;
    }

    if (hasRoomOnLeft && hasRoomOnRight) {
      lollipop.showLabel = true;
      lollipop.labelAngle = 0;  // Horizontal only for lower tiers
      rightBoundary = labelEnd;
    } else {
      lollipop.showLabel = false;
      rightBoundary = Math.max(rightBoundary, lollipop.anchorX + lollipop.radius);
    }
  }
}

/**
 * Layout for top tier: spread lollipops evenly, then resolve label overlaps
 * This creates the characteristic "fanned out" look with crank stems
 */
function runTopTierForceLayout(
  topTier: LollipopData[],
  width: number,
  params: LayoutParams
): void {
  if (topTier.length === 0) return;

  // Sort by anchor position so they spread in genomic order
  topTier.sort((a, b) => a.anchorX - b.anchorX);

  const margin = 40;
  const availableWidth = width - 2 * margin;

  // Spread lollipops evenly across the width
  // This creates the fanned-out crank stem appearance
  const spacing = topTier.length > 1 ? availableWidth / (topTier.length - 1) : 0;

  for (let i = 0; i < topTier.length; i++) {
    topTier[i].x = margin + i * spacing;
    topTier[i].y = params.topTierY;
    topTier[i].showLabel = false;
  }

  // Resolve label collisions - show labels only where they fit
  resolveLabelCollisions(topTier, width);
}

/**
 * Calculate horizontal footprint of a label at a given angle
 */
function getLabelFootprint(labelWidth: number, angle: number): number {
  if (angle === 0) {
    return labelWidth;  // Horizontal: full width
  } else if (angle === -45) {
    return labelWidth * 0.707;  // 45°: cos(45°) ≈ 0.707
  } else if (angle === -90) {
    return 12;  // Vertical: just font height + padding
  }
  return labelWidth * Math.abs(Math.cos(angle * Math.PI / 180));
}

/**
 * Determine which labels to show and at what angle based on density
 * Uses progressive angles: horizontal (0°) -> diagonal (-45°) -> vertical (-90°)
 */
function resolveLabelCollisions(
  lollipops: LollipopData[],
  width: number
): void {
  if (lollipops.length === 0) return;

  // Sort by X position (left to right)
  const sorted = [...lollipops].sort((a, b) => a.x - b.x);

  // Calculate average spacing to determine density
  const avgSpacing = sorted.length > 1
    ? (sorted[sorted.length - 1].x - sorted[0].x) / (sorted.length - 1)
    : width;

  // Choose angle based on density
  // Tighter spacing = more aggressive angle
  let labelAngle = 0;  // Default: horizontal
  if (avgSpacing < 30) {
    labelAngle = -90;  // Very dense: vertical
  } else if (avgSpacing < 60) {
    labelAngle = -45;  // Medium dense: diagonal
  }

  const labelGap = 4;
  let rightBoundary = -Infinity;

  for (const lollipop of sorted) {
    lollipop.labelAngle = labelAngle;

    const labelStart = lollipop.x + lollipop.radius + 3;
    const footprint = getLabelFootprint(lollipop.labelWidth, labelAngle);

    // Check if there's room for this label
    if (labelStart > rightBoundary) {
      lollipop.showLabel = true;
      rightBoundary = labelStart + footprint + labelGap;
    } else {
      lollipop.showLabel = false;
      rightBoundary = Math.max(rightBoundary, lollipop.x + lollipop.radius + labelGap);
    }

    // Don't let labels extend past the right edge
    if (labelStart + footprint > width - 10) {
      lollipop.showLabel = false;
    }
  }
}

// Re-export for backward compatibility
export { getLayoutParams as getLayoutParamsLegacy };
export function groupVariants() { return []; }
export function runForceLayout() {}
