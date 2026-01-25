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

import type { Variant } from '../../api/types';
import type { LollipopData, LayoutParams, StackedDisc, TierName, TierConfig, LayerDefinition } from './types';
import {
  getVariantPosition,
  getVariantColor,
  getConsequencePriority,
} from '../variantUtils';

/** Fixed Y positions for each layer (used for consistent spacing) */
export const LAYER_Y_POSITIONS = {
  selected: 25,   // Selection layer at top with room for labels
  lof: 80,        // Gap below selection for crankshaft geometry
  missense: 150,
  synonymous: 195,
  noncoding: 225,
} as const;

/** Spacing between the lowest layer and the baseline */
const BASELINE_PADDING = 35;

/**
 * Minimum height for proper crankshaft rendering
 * Accounts for: top tier Y (80) + stack (~30) + upper vertical (20) + diagonal (40) + lower vertical (25) + padding
 */
const MIN_HEIGHT_FOR_CRANKSHAFT = 205;

/**
 * Create standard layer configuration that reproduces current gnomAD behavior
 * This is the factory function for the default layer setup
 * Note: Y positions are now fixed values, not percentages
 */
export function getStandardLayers(_height?: number): LayerDefinition[] {
  return [
    {
      id: 'lof',
      label: 'Loss of Function',
      filter: (variants) => variants.some(v => getConsequencePriority(v.consequence || '') >= 4),
      color: '#dd3333',
      y: LAYER_Y_POSITIONS.lof,
      layout: 'expanded',
      zOrder: 40,
    },
    {
      id: 'missense',
      label: 'Missense',
      filter: (variants) => variants.some(v => getConsequencePriority(v.consequence || '') === 3),
      color: '#f59e0b',
      y: LAYER_Y_POSITIONS.missense,
      layout: 'condensed',
      zOrder: 30,
    },
    {
      id: 'synonymous',
      label: 'Synonymous',
      filter: (variants) => variants.some(v => getConsequencePriority(v.consequence || '') === 2),
      color: '#22c55e',
      y: LAYER_Y_POSITIONS.synonymous,
      layout: 'condensed',
      zOrder: 20,
    },
    {
      id: 'noncoding',
      label: 'Non-coding',
      filter: () => true, // Catch-all for remaining variants
      color: '#757575',
      y: LAYER_Y_POSITIONS.noncoding,
      layout: 'condensed',
      zOrder: 10,
    },
  ];
}

/**
 * Calculate the minimum required height based on which layers have variants
 * Returns the Y position of the lowest occupied layer + padding for baseline
 * Ensures minimum height for proper crankshaft rendering when expanded tiers exist
 */
export function calculateRequiredHeight(lollipops: LollipopData[]): number {
  if (lollipops.length === 0) return 120; // Minimum height

  // Check if any lollipop uses expanded layout (needs crankshaft space)
  const hasExpandedTier = lollipops.some(l => l.isExpanded);

  // Find the maximum Y position among all lollipops (accounting for stack height)
  const maxY = Math.max(...lollipops.map(l => l.y + l.stackHeight));

  // Calculate height based on content
  const contentHeight = maxY + BASELINE_PADDING;

  // If we have expanded tiers, ensure minimum height for proper crankshaft geometry
  if (hasExpandedTier) {
    return Math.max(MIN_HEIGHT_FOR_CRANKSHAFT, contentHeight);
  }

  return Math.max(120, contentHeight);
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
    y: LAYER_Y_POSITIONS.selected,
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
 * Parse hgvsc to extract short label for non-coding variants
 * e.g., "c.1799T>A" -> "c.1799T>A", "c.100+1G>A" -> "c.100+1G>A"
 */
function parseHgvscLabel(hgvsc: string | undefined): string {
  if (!hgvsc) return '';

  // Strip transcript prefix if present (e.g., "ENST00000123456.1:c.100G>A" -> "c.100G>A")
  const colonIdx = hgvsc.lastIndexOf(':');
  const notation = colonIdx >= 0 ? hgvsc.slice(colonIdx + 1) : hgvsc;

  // Return the c. notation as-is (it's already reasonably short)
  return notation;
}

/**
 * Get the best available HGVS key for grouping variants
 * Prefers hgvsp for coding variants, falls back to hgvsc for non-coding
 */
function getHgvsKey(v: Variant): string {
  // Use hgvsp if available and meaningful
  if (v.hgvsp && v.hgvsp !== 'unknown') {
    return v.hgvsp;
  }
  // Fall back to hgvsc for non-coding variants
  if (v.hgvsc) {
    return v.hgvsc;
  }
  return 'unknown';
}

/**
 * Get the best available label for a variant
 * Prefers hgvsp label for coding variants, falls back to hgvsc for non-coding
 */
function getVariantLabel(v: Variant): string {
  // Use hgvsp if available
  if (v.hgvsp) {
    const label = parseHgvspLabel(v.hgvsp);
    if (label) return label;
  }
  // Fall back to hgvsc for non-coding variants
  if (v.hgvsc) {
    return parseHgvscLabel(v.hgvsc);
  }
  return '';
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

  // Find max AF across all HGVS groups for radius scaling
  let maxAf = 0;
  for (const posVariants of positionMap.values()) {
    // Group by HGVS key within this position and sum AF
    const hgvsAfs = new Map<string, number>();
    for (const v of posVariants) {
      const key = getHgvsKey(v);
      const af = v.af || v.allele_freq || 0;
      hgvsAfs.set(key, (hgvsAfs.get(key) || 0) + af);
    }
    for (const af of hgvsAfs.values()) {
      maxAf = Math.max(maxAf, af);
    }
  }

  // Create lollipop data with stacked discs
  const lollipops: LollipopData[] = [];

  for (const [pos, posVariants] of positionMap) {
    // Group variants by HGVS key (hgvsp if coding, hgvsc if non-coding)
    const hgvsMap = new Map<string, Variant[]>();
    for (const v of posVariants) {
      const key = getHgvsKey(v);
      if (!hgvsMap.has(key)) {
        hgvsMap.set(key, []);
      }
      hgvsMap.get(key)!.push(v);
    }

    // Create a disc for each unique HGVS entry
    const discs: StackedDisc[] = [];
    for (const [hgvsKey, hgvsVariants] of hgvsMap) {
      const count = hgvsVariants.length;
      // Use the first variant to get the best label (hgvsp preferred, fallback to hgvsc)
      const label = getVariantLabel(hgvsVariants[0]);

      // Determine color, priority, and sum AF from variants in this group
      let color = '#757575';
      let priority = 0;
      let totalAC = 0;
      let totalAF = 0;
      for (const v of hgvsVariants) {
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
        hgvsp: hgvsKey,  // Store the HGVS key (could be hgvsp or hgvsc)
        label,
        variants: hgvsVariants,
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
export function getTierConfig(_height?: number): Record<TierName, TierConfig> {
  return {
    selected: { y: LAYER_Y_POSITIONS.selected, expanded: true, basePriority: 10000 },
    lof: { y: LAYER_Y_POSITIONS.lof, expanded: true, basePriority: 4000 },
    missense: { y: LAYER_Y_POSITIONS.missense, expanded: false, basePriority: 3000 },
    synonymous: { y: LAYER_Y_POSITIONS.synonymous, expanded: false, basePriority: 2000 },
    noncoding: { y: LAYER_Y_POSITIONS.noncoding, expanded: false, basePriority: 1000 },
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

  // Find the dynamic top tier: the first non-selection layer that has lollipops
  // This layer gets expanded/crankshaft treatment even if its config says 'condensed'
  let dynamicTopLayer: LayerDefinition | null = null;
  for (const layer of layerConfig) {
    if (layer.id === 'selected') continue;
    const items = layerGroups.get(layer.id) || [];
    if (items.length > 0) {
      dynamicTopLayer = layer;
      break;
    }
  }

  // Layout each layer
  for (const layer of layerConfig) {
    const items = layerGroups.get(layer.id) || [];
    if (items.length === 0) continue;

    // Determine if this layer should be expanded:
    // - Selection layer is always expanded
    // - Dynamic top layer (first non-selection layer with variants) is expanded
    // - Otherwise use the layer's configured layout
    const isDynamicTopLayer = dynamicTopLayer && layer.id === dynamicTopLayer.id;
    const shouldBeExpanded = layer.id === 'selected' || isDynamicTopLayer || layer.layout === 'expanded';

    // Set Y position - dynamic top layer moves to the standard top tier position (60)
    // This ensures crankshaft stems render correctly
    const effectiveY = (isDynamicTopLayer && layer.layout !== 'expanded') ? 60 : layer.y;

    for (const item of items) {
      item.y = effectiveY;
      item.isExpanded = shouldBeExpanded;
      item.isTopTier = item.isExpanded;  // Backward compatibility
    }

    if (shouldBeExpanded) {
      if (layer.id === 'selected') {
        // Selection layer: cluster nearby variants, spread evenly within clusters
        runClusteredLayout(items, width, params);
      } else {
        // Dynamic top layer: also use clustered layout for consistency
        const nonSelected = items.filter(l => !l.isSelected);
        if (nonSelected.length > 0) {
          runClusteredLayout(nonSelected, width, params);
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

  // Cross-layer collision avoidance: selected stems vs dynamic top layer
  if (hasSelectedVariants && dynamicTopLayer) {
    const selectedItems = layerGroups.get('selected') || [];
    const expandedItems = layerGroups.get(dynamicTopLayer.id) || [];
    const nonSelectedExpanded = expandedItems.filter(l => !l.isSelected);

    if (selectedItems.length > 0 && nonSelectedExpanded.length > 0) {
      avoidStemCollisions(selectedItems, nonSelectedExpanded, width);
    }
  }
}

/**
 * Avoid collisions between selected tier stems and top tier discs/labels,
 * and minimize diagonal stem line crossings between the two layers.
 */
function avoidStemCollisions(
  selectedLollipops: LollipopData[],
  topLollipops: LollipopData[],
  width: number
): void {
  if (selectedLollipops.length === 0 || topLollipops.length === 0) return;

  // Step 1: Minimize stem crossings by adjusting top layer positions
  // Stems go from x (at disc) diagonally to anchorX (at baseline)
  // Two stems cross if their x positions have opposite ordering from their anchors
  minimizeStemCrossings(selectedLollipops, topLollipops);

  // Step 2: Avoid disc/label collisions with vertical stem segments
  const stemClearance = 10;
  const labelAngleAdjust = 1.1;

  for (const selected of selectedLollipops) {
    const stemX = selected.x;

    for (const top of topLollipops) {
      const labelExtent = top.showLabel ? top.labelWidth * labelAngleAdjust : 0;
      const topLeft = top.x - top.radius;
      const topRight = top.x + top.radius + labelExtent;

      const hasCollision = stemX > topLeft - stemClearance && stemX < topRight + stemClearance;

      if (hasCollision) {
        if (stemX <= top.x) {
          const shiftNeeded = stemX + stemClearance + top.radius - top.x + 5;
          top.x = top.x + shiftNeeded;
        } else {
          const shiftNeeded = top.x + top.radius + labelExtent + stemClearance - stemX + 5;
          top.x = top.x - shiftNeeded;
        }
      }
    }
  }

  // Step 3: Resolve any disc-disc overlaps within top tier
  resolveDiscOverlaps(topLollipops);

  // Step 4: Re-resolve labels since positions changed
  resolveLabelCollisions(topLollipops, width);
}

/**
 * Minimize stem crossings between two layers by adjusting x positions.
 * A crossing occurs when two stems' x positions have opposite order from their anchors.
 */
function minimizeStemCrossings(
  selectedLollipops: LollipopData[],
  topLollipops: LollipopData[]
): void {
  // For each pair of (selected, top) lollipops with nearby anchors,
  // check if their stems would cross and try to fix it

  // Sort both by anchor position for easier comparison
  const sortedSelected = [...selectedLollipops].sort((a, b) => a.anchorX - b.anchorX);
  const sortedTop = [...topLollipops].sort((a, b) => a.anchorX - b.anchorX);

  // Build a list of potential crossings
  interface Crossing {
    selected: LollipopData;
    top: LollipopData;
    anchorDiff: number;
  }

  const nearPairs: Crossing[] = [];
  const anchorProximity = 50; // Consider stems "near" if anchors are within this distance

  for (const sel of sortedSelected) {
    for (const top of sortedTop) {
      const anchorDiff = Math.abs(sel.anchorX - top.anchorX);
      if (anchorDiff < anchorProximity) {
        nearPairs.push({ selected: sel, top, anchorDiff });
      }
    }
  }

  // For nearby pairs, check if stems cross and try to align x positions
  // to match anchor ordering (reduces visual crossing)
  for (const pair of nearPairs) {
    const sel = pair.selected;
    const top = pair.top;

    // Stems cross if: (sel.anchorX < top.anchorX) !== (sel.x < top.x)
    const anchorOrder = sel.anchorX < top.anchorX;
    const xOrder = sel.x < top.x;

    if (anchorOrder !== xOrder) {
      // Crossing detected! Try to nudge top layer to match anchor order
      // Move top.x toward a position that matches the anchor relationship
      const minSpacing = top.radius + top.labelWidth * 0.5 + 15;

      if (anchorOrder) {
        // sel anchor is left of top anchor, so sel.x should be left of top.x
        // Nudge top.x to the right of sel.x
        if (top.x < sel.x + minSpacing) {
          top.x = sel.x + minSpacing;
        }
      } else {
        // sel anchor is right of top anchor, so sel.x should be right of top.x
        // Nudge top.x to the left of sel.x
        if (top.x > sel.x - minSpacing) {
          top.x = sel.x - minSpacing;
        }
      }
    }
  }
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
 * Clustered layout for expanded layers: group nearby variants and spread evenly within each cluster
 * Uses crankshaft stems to connect spread positions back to genomic anchors
 */
function runClusteredLayout(
  selectedTier: LollipopData[],
  width: number,
  _params: LayoutParams
): void {
  if (selectedTier.length === 0) return;

  // Initialize
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

  // Calculate minimum spacing needed for labels
  const minSpacing = Math.max(
    ...selectedTier.map(l => l.radius * 2 + l.labelWidth * 0.8 + 8)
  );

  // Cluster variants that are close together (within 2x minSpacing of each other)
  const clusterThreshold = minSpacing * 2.5;
  const clusters: LollipopData[][] = [];
  let currentCluster: LollipopData[] = [selectedTier[0]];

  for (let i = 1; i < selectedTier.length; i++) {
    const prev = selectedTier[i - 1];
    const curr = selectedTier[i];

    if (curr.anchorX - prev.anchorX <= clusterThreshold) {
      // Close enough - add to current cluster
      currentCluster.push(curr);
    } else {
      // Gap detected - start new cluster
      clusters.push(currentCluster);
      currentCluster = [curr];
    }
  }
  clusters.push(currentCluster);

  // Layout each cluster
  const margin = 40;

  for (const cluster of clusters) {
    if (cluster.length === 1) {
      // Single item stays at anchor
      cluster[0].x = cluster[0].anchorX;
      continue;
    }

    // Calculate cluster bounds
    const minAnchor = cluster[0].anchorX;
    const maxAnchor = cluster[cluster.length - 1].anchorX;
    const anchorSpan = maxAnchor - minAnchor;
    const midpoint = (minAnchor + maxAnchor) / 2;

    // Required span for this cluster
    const requiredSpan = (cluster.length - 1) * minSpacing;
    const effectiveSpan = Math.max(anchorSpan, requiredSpan);

    // Position cluster centered on its anchor midpoint
    let startX = midpoint - effectiveSpan / 2;
    let endX = midpoint + effectiveSpan / 2;

    // Clamp to width bounds
    if (startX < margin) {
      startX = margin;
      endX = startX + effectiveSpan;
    }
    if (endX > width - margin) {
      endX = width - margin;
      startX = endX - effectiveSpan;
    }
    startX = Math.max(margin, startX);

    // Distribute evenly within cluster region
    const spacing = (endX - startX) / (cluster.length - 1);
    for (let i = 0; i < cluster.length; i++) {
      cluster[i].x = startX + i * spacing;
    }
  }

  // Resolve any inter-cluster overlaps
  resolveClusterOverlaps(clusters, minSpacing, width, margin);
}

/**
 * Push clusters apart if they overlap
 */
function resolveClusterOverlaps(
  clusters: LollipopData[][],
  minSpacing: number,
  width: number,
  margin: number
): void {
  if (clusters.length < 2) return;

  for (let iter = 0; iter < 5; iter++) {
    let hasOverlap = false;

    for (let i = 0; i < clusters.length - 1; i++) {
      const leftCluster = clusters[i];
      const rightCluster = clusters[i + 1];

      const leftRight = leftCluster[leftCluster.length - 1].x;
      const rightLeft = rightCluster[0].x;
      const gap = rightLeft - leftRight;

      if (gap < minSpacing) {
        hasOverlap = true;
        const shift = (minSpacing - gap) / 2 + 2;

        // Shift left cluster left
        for (const l of leftCluster) {
          l.x = Math.max(margin, l.x - shift);
        }
        // Shift right cluster right
        for (const l of rightCluster) {
          l.x = Math.min(width - margin, l.x + shift);
        }
      }
    }

    if (!hasOverlap) break;
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
