/**
 * Protein-Paint Style Lollipop Visualization
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

/**
 * A disc representing one amino acid change (used in stacks)
 */
export interface StackedDisc {
  /** The protein change notation (e.g., "p.Val600Glu") */
  hgvsp: string;

  /** Short label for display (e.g., "V600E") */
  label: string;

  /** All variants with this exact amino acid change */
  variants: Variant[];

  /** Count of variants with this change */
  count: number;

  /** Disc radius based on count */
  radius: number;

  /** Color based on consequence */
  color: string;

  /** Priority score for this disc */
  priority: number;

  /** Y offset within the stack (0 for bottom disc) */
  stackY: number;
}

/**
 * A lollipop/skewer at a genomic position, may contain stacked discs
 */
export interface LollipopData {
  /** Unique identifier */
  id: string;

  /** Genomic position */
  pos: number;

  /** Stacked discs at this position (sorted by priority, highest on top) */
  discs: StackedDisc[];

  /** Primary label (from top disc) */
  label: string;

  /** All variants at this position */
  variants: Variant[];

  /** Total count of all variants at this position */
  count: number;

  /** Radius of the largest disc (for collision) */
  radius: number;

  /** Color of the highest-priority disc */
  color: string;

  /** Highest priority score among discs */
  priority: number;

  /** Anchor x position (true genomic position in pixels) */
  anchorX: number;

  /** Display x position (for top tier, after force layout) */
  x: number;

  /** Display y position (top of the stack) */
  y: number;

  /** Total height of the disc stack */
  stackHeight: number;

  /** Label width in pixels (for force layout collision) */
  labelWidth: number;

  /** Whether this is in the top (priority) tier */
  isTopTier: boolean;

  /** Whether to show the label (false when too dense) */
  showLabel: boolean;

  /** Label rotation angle in degrees (0 = horizontal, -45 = diagonal, -90 = vertical) */
  labelAngle: number;

  /** The tier this lollipop belongs to */
  tier: TierName;

  /** Whether this tier uses expanded/crank layout */
  isExpanded: boolean;

  /** Whether this variant is user-selected */
  isSelected: boolean;
}

/**
 * Tier names for variant classification
 */
export type TierName = 'selected' | 'lof' | 'missense' | 'synonymous' | 'noncoding';

/**
 * Tier configuration with Y positions and layout behavior
 */
export interface TierConfig {
  /** Y position for this tier */
  y: number;
  /** Whether this tier gets spread/crank layout (vs straight stems) */
  expanded: boolean;
  /** Base priority for tier ordering */
  basePriority: number;
}

/**
 * Layout parameters
 */
export interface LayoutParams {
  /** Minimum disc radius */
  minRadius: number;

  /** Maximum disc radius */
  maxRadius: number;

  /** Number of top-tier lollipops to show with labels */
  topTierCount: number;

  /** Y position for bottom tier */
  bottomTierY: number;

  /** Y position for top tier */
  topTierY: number;

  /** Set of selected variant IDs (for user selection tier) */
  selectedIds?: Set<string>;
}

// Keep old types for compatibility during transition
export interface DiscData {
  id: string;
  hgvsp: string;
  label: string;
  variants: Variant[];
  count: number;
  radius: number;
  color: string;
  stackIndex: number;
  y: number;
}

export interface SkewerData {
  id: string;
  pos: number;
  discs: DiscData[];
  totalCount: number;
  anchorX: number;
  x: number;
  y: number;
  stackHeight: number;
}
