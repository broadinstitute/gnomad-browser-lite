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

  // Find max count across all hgvsp groups for radius scaling
  let maxCount = 1;
  for (const posVariants of positionMap.values()) {
    // Group by hgvsp within this position
    const hgvspCounts = new Map<string, number>();
    for (const v of posVariants) {
      const hgvsp = v.hgvsp || 'unknown';
      hgvspCounts.set(hgvsp, (hgvspCounts.get(hgvsp) || 0) + 1);
    }
    for (const count of hgvspCounts.values()) {
      maxCount = Math.max(maxCount, count);
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

      // Determine color and priority from highest-priority variant in this group
      let color = '#757575';
      let priority = 0;
      let totalAC = 0;
      for (const v of hgvspVariants) {
        const p = getConsequencePriority(v.consequence || '');
        if (p > priority) {
          priority = p;
          color = getVariantColor(v);
        }
        totalAC += v.ac || 0;
      }

      // Priority: consequence class * 1000 + allele count
      const effectivePriority = priority * 1000 + Math.min(totalAC, 500);

      discs.push({
        hgvsp,
        label,
        variants: hgvspVariants,
        count,
        radius: calculateDiscRadius(count, maxCount, params),
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
 * Determine which labels to show based on collision detection
 * Iterates left-to-right, showing labels only when there's room
 */
function resolveLabelCollisions(
  lollipops: LollipopData[],
  width: number
): void {
  // Sort by X position (left to right)
  const sorted = [...lollipops].sort((a, b) => a.x - b.x);

  const labelGap = 4;  // Minimum gap between label end and next disc
  let rightBoundary = -Infinity;  // Right edge of last shown label

  for (const lollipop of sorted) {
    // Calculate where this label would start (right edge of disc + small gap)
    const labelStart = lollipop.x + lollipop.radius + 3;

    // Check if there's room for this label
    if (labelStart > rightBoundary) {
      // Show this label
      lollipop.showLabel = true;
      // Update boundary to include this label
      rightBoundary = labelStart + lollipop.labelWidth + labelGap;
    } else {
      // No room - hide this label, but update boundary to disc edge
      lollipop.showLabel = false;
      // The next label needs to clear at least this disc
      rightBoundary = Math.max(rightBoundary, lollipop.x + lollipop.radius + labelGap);
    }

    // Don't let labels extend past the right edge
    if (rightBoundary > width - 10) {
      lollipop.showLabel = false;
    }
  }
}

// Re-export for backward compatibility
export { getLayoutParams as getLayoutParamsLegacy };
export function groupVariants() { return []; }
export function runForceLayout() {}
