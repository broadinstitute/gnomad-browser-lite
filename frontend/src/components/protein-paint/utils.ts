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
import type { LollipopData, LayoutParams, StackedDisc, TierName, TierConfig, LayerDefinition } from './types';
import {
  getVariantPosition,
  getVariantColor,
  getConsequencePriority,
} from '../variantUtils';

/**
 * Create standard layer configuration that reproduces current gnomAD behavior
 * This is the factory function for the default layer setup
 */
export function getStandardLayers(height: number): LayerDefinition[] {
  return [
    {
      id: 'lof',
      label: 'Loss of Function',
      filter: (variants) => variants.some(v => getConsequencePriority(v.consequence || '') >= 4),
      color: '#dd3333',
      y: 60,
      layout: 'expanded',
      zOrder: 40,
    },
    {
      id: 'missense',
      label: 'Missense',
      filter: (variants) => variants.some(v => getConsequencePriority(v.consequence || '') === 3),
      color: '#f59e0b',
      y: height * 0.55,
      layout: 'condensed',
      zOrder: 30,
    },
    {
      id: 'synonymous',
      label: 'Synonymous',
      filter: (variants) => variants.some(v => getConsequencePriority(v.consequence || '') === 2),
      color: '#22c55e',
      y: height * 0.72,
      layout: 'condensed',
      zOrder: 20,
    },
    {
      id: 'noncoding',
      label: 'Non-coding',
      filter: () => true, // Catch-all for remaining variants
      color: '#757575',
      y: height * 0.85,
      layout: 'condensed',
      zOrder: 10,
    },
  ];
}

/**
 * Create a selection layer definition for user-selected variants
 */
export function createSelectionLayer(selectedIds: Set<string>): LayerDefinition {
  return {
    id: 'selected',
    label: 'Selected',
    filter: (variants) => variants.some(v => selectedIds.has(v.variant_id || '')),
    color: '#1976d2',
    y: 40,
    layout: 'expanded',
    zOrder: 100, // Highest priority
  };
}

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
 *
 * @param variants - Array of variants to display
 * @param scale - Scale function mapping genomic position to pixel X
 * @param params - Layout parameters
 * @param layers - Layer configuration (optional, uses standard layers if not provided)
 */
export function createLollipops(
  variants: Variant[],
  scale: (pos: number) => number,
  params: LayoutParams,
  layers?: LayerDefinition[]
): LollipopData[] {
  // Use standard layers if not provided
  const height = params.bottomTierY + 15;
  const layerConfig = layers || getStandardLayers(height);
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

    // Find the matching layer for this lollipop
    const matchedLayer = layerConfig.find(layer => layer.filter(allVariants));
    const layerId = matchedLayer?.id || 'noncoding';
    const isExpanded = matchedLayer?.layout === 'expanded';
    const layerY = matchedLayer?.y || params.bottomTierY;

    // Map layerId to TierName for backward compatibility
    const tier = (layerId === 'lof' || layerId === 'missense' ||
                  layerId === 'synonymous' || layerId === 'noncoding' ||
                  layerId === 'selected')
      ? layerId as TierName
      : 'noncoding';

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
      y: layerY,
      stackHeight,
      labelWidth: estimateLabelWidth(topDisc.label),
      isTopTier: isExpanded,
      showLabel: false,
      labelAngle: 0,  // Will be set during layout
      layerId,  // New generic layer ID
      tier,  // Backward compatibility
      isExpanded,
      isSelected: false,  // Will be set during layout
    });
  }

  return lollipops;
}

/**
 * Tier configuration - defines Y positions and layout behavior
 * Selected tier is dynamically inserted above the highest-priority present tier
 */
export function getTierConfig(height: number): Record<TierName, TierConfig> {
  return {
    selected: { y: 40, expanded: true, basePriority: 10000 },  // User-selected always on top
    lof: { y: 60, expanded: true, basePriority: 4000 },
    missense: { y: height * 0.55, expanded: false, basePriority: 3000 },
    synonymous: { y: height * 0.72, expanded: false, basePriority: 2000 },
    noncoding: { y: height * 0.85, expanded: false, basePriority: 1000 },
  };
}

/**
 * Get tier based on consequence priority
 * Returns: 'lof' | 'missense' | 'synonymous' | 'noncoding'
 */
function getTierFromPriority(priority: number): TierName {
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
  const config = getTierConfig(height);
  return {
    selected: config.selected.y,
    lof: config.lof.y,
    missense: config.missense.y,
    synonymous: config.synonymous.y,
    noncoding: config.noncoding.y,
  };
}

/**
 * Assign lollipops to layers and run layout algorithms
 * Uses the generic layer configuration system
 *
 * @param lollipops - Lollipops to layout (already assigned to layers by createLollipops)
 * @param width - Available width for layout
 * @param params - Layout parameters
 * @param layers - Layer configuration (optional, uses standard layers if not provided)
 */
export function layoutLollipops(
  lollipops: LollipopData[],
  width: number,
  params: LayoutParams,
  layers?: LayerDefinition[]
): void {
  if (lollipops.length === 0) return;

  const height = params.bottomTierY + 15;
  const selectedIds = params.selectedIds || new Set<string>();

  // Build layer config: prepend selection layer if there are selected variants
  let layerConfig = layers || getStandardLayers(height);

  // Check if any variant is selected
  const hasSelectedVariants = lollipops.some(l =>
    l.variants.some(v => selectedIds.has(v.variant_id || ''))
  );

  // If we have selected variants, prepend the selection layer
  if (hasSelectedVariants) {
    const selectionLayer = createSelectionLayer(selectedIds);
    // Only prepend if selection layer isn't already in the config
    if (!layerConfig.find(l => l.id === 'selected')) {
      layerConfig = [selectionLayer, ...layerConfig];
    }
  }

  // Group lollipops by layer
  const layerGroups = new Map<string, LollipopData[]>();
  for (const layer of layerConfig) {
    layerGroups.set(layer.id, []);
  }

  // Mark selection status and re-assign to layers if selection layer is active
  for (const lollipop of lollipops) {
    const isSelected = lollipop.variants.some(v => selectedIds.has(v.variant_id || ''));
    lollipop.isSelected = isSelected;

    // If selected and selection layer exists, reassign to selection layer
    if (isSelected && hasSelectedVariants) {
      lollipop.layerId = 'selected';
      lollipop.tier = 'selected';
      const selectionLayer = layerConfig.find(l => l.id === 'selected');
      if (selectionLayer) {
        lollipop.y = selectionLayer.y;
        lollipop.isExpanded = selectionLayer.layout === 'expanded';
      }
    }

    // Add to appropriate layer group
    const group = layerGroups.get(lollipop.layerId);
    if (group) {
      group.push(lollipop);
    } else {
      // Fallback: put in the last layer
      const lastLayer = layerConfig[layerConfig.length - 1];
      layerGroups.get(lastLayer.id)?.push(lollipop);
    }
  }

  // Find the first non-selection expanded layer (for collision avoidance)
  const firstExpandedLayer = layerConfig.find(l => l.id !== 'selected' && l.layout === 'expanded');

  // Layout each layer
  for (const layer of layerConfig) {
    const items = layerGroups.get(layer.id) || [];
    if (items.length === 0) continue;

    // Set Y position from layer config
    for (const item of items) {
      item.y = layer.y;
      item.isExpanded = layer.layout === 'expanded';
      item.isTopTier = item.isExpanded;  // Backward compatibility
    }

    if (layer.layout === 'expanded') {
      if (layer.id === 'selected') {
        // Use dedicated selected tier layout (pulls toward anchor)
        runSelectedTierLayout(items, width, params);
      } else {
        // Use force layout for expanded layers
        // Exclude selected variants if they were reassigned
        const nonSelected = items.filter(l => !l.isSelected);
        if (nonSelected.length > 0) {
          runExpandedLayout(nonSelected, width, params);
        }
      }
      // Resolve label collisions for expanded layers
      resolveLabelCollisions(items, width);
    } else {
      // Condensed layout: x stays at anchorX
      for (const item of items) {
        item.x = item.anchorX;
      }
      // Apply opportunistic horizontal labels
      resolveHorizontalLabels(items, width);
    }
  }

  // Cross-layer collision avoidance: selected stems vs first expanded layer
  if (hasSelectedVariants && firstExpandedLayer) {
    const selectedItems = layerGroups.get('selected') || [];
    const expandedItems = layerGroups.get(firstExpandedLayer.id) || [];
    const nonSelectedExpanded = expandedItems.filter(l => !l.isSelected);

    if (selectedItems.length > 0 && nonSelectedExpanded.length > 0) {
      const tierY = getTierPositions(height);
      avoidStemCollisions(selectedItems, nonSelectedExpanded, tierY, height);
    }
  }
}

/**
 * Generic expanded layout - replaces runTopTierForceLayout
 * Spreads lollipops evenly across available width
 */
function runExpandedLayout(
  items: LollipopData[],
  width: number,
  params: LayoutParams
): void {
  if (items.length === 0) return;

  // Sort by anchor position for genomic order
  items.sort((a, b) => a.anchorX - b.anchorX);

  const margin = 40;
  const availableWidth = width - 2 * margin;
  const spacing = items.length > 1 ? availableWidth / (items.length - 1) : 0;

  for (let i = 0; i < items.length; i++) {
    items[i].x = margin + i * spacing;
    items[i].showLabel = false;
  }

  resolveLabelCollisions(items, width);
}

/**
 * Avoid collisions between selected tier stems and LoF tier discs/labels
 * Selected stems are now VERTICAL through the LoF tier (at selected.x),
 * so we just need to ensure LoF variants don't overlap with that vertical line
 */
function avoidStemCollisions(
  selectedLollipops: LollipopData[],
  lofLollipops: LollipopData[],
  _tierY: Record<string, number>,
  _height: number
): void {
  if (selectedLollipops.length === 0 || lofLollipops.length === 0) return;

  // Selected stems are now vertical through the LoF tier at selected.x
  // We need to ensure LoF discs and labels don't overlap with these vertical lines
  const stemClearance = 10;
  const labelAngleAdjust = 1.1;  // Labels at -45° extend further than simple horizontal calc

  for (const selected of selectedLollipops) {
    // The stem is at selected.x through the LoF tier region
    const stemX = selected.x;

    for (const lof of lofLollipops) {
      // Calculate the full extent of this LoF variant (disc + angled label)
      const labelExtent = lof.showLabel ? lof.labelWidth * labelAngleAdjust : 0;
      const lofLeft = lof.x - lof.radius;
      const lofRight = lof.x + lof.radius + labelExtent;

      // Check if stem passes through this LoF variant's zone
      const hasCollision = stemX > lofLeft - stemClearance && stemX < lofRight + stemClearance;

      if (hasCollision) {
        // Collision detected! Shift LoF variant away from the stem
        if (stemX <= lof.x) {
          // Stem is to the left of disc center, shift LoF disc to the right
          const shiftNeeded = stemX + stemClearance + lof.radius - lof.x + 5;
          lof.x = lof.x + shiftNeeded;
        } else {
          // Stem is to the right of disc center, shift LoF disc to the left
          const shiftNeeded = lof.x + lof.radius + labelExtent + stemClearance - stemX + 5;
          lof.x = lof.x - shiftNeeded;
        }
      }
    }
  }

  // After stem avoidance, resolve any disc-disc overlaps within LoF tier
  resolveDiscOverlaps(lofLollipops);

  // Re-resolve labels since positions changed
  resolveLabelCollisions(lofLollipops, 2000);  // Use large width to not clip
}

/**
 * Resolve disc-disc overlaps by pushing apart overlapping lollipops
 * Iterates until no overlaps remain or max iterations reached
 */
function resolveDiscOverlaps(lollipops: LollipopData[]): void {
  if (lollipops.length < 2) return;

  // Sort by x position
  lollipops.sort((a, b) => a.x - b.x);

  const minGap = 4; // Minimum gap between disc edges
  const maxIterations = 10;

  for (let iter = 0; iter < maxIterations; iter++) {
    let hasOverlap = false;

    for (let i = 0; i < lollipops.length - 1; i++) {
      const left = lollipops[i];
      const right = lollipops[i + 1];

      const leftEdge = left.x + left.radius;
      const rightEdge = right.x - right.radius;
      const overlap = leftEdge + minGap - rightEdge;

      if (overlap > 0) {
        hasOverlap = true;
        // Push apart - each moves half the overlap distance
        const shift = overlap / 2 + 1;

        // Move toward respective anchors if possible
        if (left.anchorX < left.x) {
          left.x -= shift;
        } else {
          right.x += shift;
        }

        if (right.anchorX > right.x) {
          right.x += shift;
        } else {
          left.x -= shift;
        }
      }
    }

    if (!hasOverlap) break;
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
 * Layout for selected tier: pull variants toward their anchor position
 * Uses force simulation with strong pull to anchorX and collision avoidance
 */
function runSelectedTierLayout(
  selectedTier: LollipopData[],
  width: number,
  _params: LayoutParams
): void {
  if (selectedTier.length === 0) return;

  // Initialize X to anchorX (Y is already set from tierY in layoutLollipops)
  for (const lollipop of selectedTier) {
    lollipop.x = lollipop.anchorX;
    lollipop.showLabel = false;
  }

  if (selectedTier.length === 1) {
    // Single selected variant stays at its anchor
    return;
  }

  // Sort by anchor position
  selectedTier.sort((a, b) => a.anchorX - b.anchorX);

  // Use force simulation to resolve overlaps while keeping close to anchor
  interface SimNode {
    x: number;
    anchorX: number;
    radius: number;
    lollipop: LollipopData;
  }

  const nodes: SimNode[] = selectedTier.map(l => ({
    x: l.anchorX,
    anchorX: l.anchorX,
    radius: l.radius + l.labelWidth * 0.3, // Account for label space
    lollipop: l,
  }));

  // Run force simulation with strong pull to anchor
  const simulation = forceSimulation(nodes)
    .force('x', forceX<SimNode>(d => d.anchorX).strength(0.8))
    .force('collide', forceCollide<SimNode>(d => d.radius + 15).strength(1))
    .stop();

  // Run simulation
  for (let i = 0; i < 100; i++) {
    simulation.tick();
  }

  // Apply positions back, clamping to width bounds
  const margin = 30;
  for (const node of nodes) {
    node.lollipop.x = Math.max(margin, Math.min(width - margin, node.x));
  }
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
