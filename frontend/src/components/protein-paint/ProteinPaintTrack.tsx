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

import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import type { Variant, Exon } from '../../api/types';
import type { LollipopData } from './types';
import { getLayoutParams, createLollipops, layoutLollipops, getTierPositions } from './utils';
import { getVariantPosition, isInExonRegion } from '../variantUtils';

interface ProteinPaintTrackProps {
  variants: Variant[];
  scale: (pos: number) => number;
  width: number;
  height?: number;
  exons?: Exon[];
  showIntrons: boolean;
  onHover?: (variant: Variant | null, x: number, y: number) => void;
  /** Set of selected variant IDs */
  selectedIds?: Set<string>;
  /** Callback when a variant is clicked (toggles selection) */
  onVariantClick?: (variantId: string) => void;
}

export function ProteinPaintTrack({
  variants,
  scale,
  width,
  height = 240,
  exons,
  showIntrons,
  onHover,
  selectedIds,
  onVariantClick,
}: ProteinPaintTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lollipopsRef = useRef<LollipopData[]>([]);

  // Track hovered lollipop
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Filter variants based on intron visibility
  const filteredVariants = useMemo(() => {
    if (showIntrons || !exons || exons.length === 0) {
      return variants;
    }
    return variants.filter((v) => isInExonRegion(getVariantPosition(v), exons));
  }, [variants, exons, showIntrons]);

  // Create and layout lollipops
  const lollipops = useMemo(() => {
    const params = getLayoutParams(height);
    params.selectedIds = selectedIds;
    const data = createLollipops(filteredVariants, scale, params);
    layoutLollipops(data, width, params);
    return data;
  }, [filteredVariants, scale, width, height, selectedIds]);

  // Store for hit detection
  lollipopsRef.current = lollipops;

  // Draw to canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high-DPI displays
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const baselineY = height - 25; // Stems end above the gene track

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Separate lollipops by expansion type
    const expandedTiers = lollipops.filter(l => l.isExpanded);
    const regularTiers = lollipops.filter(l => !l.isExpanded);

    // Get tier positions for layer-aware crank stems
    const tierPositions = getTierPositions(height);

    // Group expanded tiers by tier name for calculating knee positions
    const selectedTier = expandedTiers.filter(l => l.tier === 'selected');
    const lofTier = expandedTiers.filter(l => l.tier === 'lof');

    // Calculate bottom of each expanded tier for crank positioning
    const selectedTierBottom = selectedTier.length > 0
      ? Math.max(...selectedTier.map(l => l.y + l.stackHeight)) + 3
      : 0;
    const lofTierBottom = lofTier.length > 0
      ? Math.max(...lofTier.map(l => l.y + l.stackHeight)) + 3
      : 0;

    // The lower knee of the crank must be ABOVE the next layer
    // For selected tier: knee above LoF tier (or missense if no LoF)
    // For LoF tier: knee above missense layer
    const missenseTop = tierPositions.missense - 20;
    const lofTop = tierPositions.lof - 10;

    // Draw regular (non-expanded) tiers first (simple straight stems with stacked discs)
    for (const lollipop of regularTiers) {
      const isHovered = lollipop.id === hoveredId;
      const x = lollipop.anchorX;

      // Calculate stack bottom (where stem ends)
      const stackBottom = lollipop.y + lollipop.stackHeight;

      // Draw straight stem to bottom of stack
      ctx.strokeStyle = '#ccc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, baselineY);
      ctx.lineTo(x, stackBottom);
      ctx.stroke();

      // Draw stacked discs (top to bottom)
      for (const disc of lollipop.discs) {
        const discY = lollipop.y + disc.stackY + disc.radius;  // Center Y of this disc

        ctx.beginPath();
        ctx.fillStyle = disc.color;
        ctx.globalAlpha = isHovered ? 1 : 0.7;
        ctx.arc(x, discY, disc.radius, 0, Math.PI * 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = isHovered ? '#000' : 'rgba(0,0,0,0.15)';
        ctx.lineWidth = isHovered ? 2 : 1;
        ctx.stroke();
      }

      // Show label if space available or on hover (horizontal only for lower tiers)
      if (lollipop.label && (lollipop.showLabel || isHovered)) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = isHovered ? '#333' : lollipop.color;
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const topDiscY = lollipop.y + lollipop.discs[0].radius;
        ctx.fillText(lollipop.label, x + lollipop.radius + 3, topDiscY);
      }
    }

    // Draw expanded tiers (crank/dog-leg stems with stacked discs and labels)
    for (const lollipop of expandedTiers) {
      const isHovered = lollipop.id === hoveredId;
      const isSelected = lollipop.isSelected;
      const x = lollipop.x;

      // Calculate stack bottom
      const stackBottom = lollipop.y + lollipop.stackHeight;

      // Draw stem with crank/dog-leg style:
      // Upper vertical -> Diagonal -> Lower vertical
      // The diagonal happens in the gap between tiers
      ctx.strokeStyle = isSelected ? '#1976d2' : '#999';
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.beginPath();

      // Calculate crank segments based on tier
      // The upper knee is just below this tier's stack
      // The lower knee is above the next tier
      let upperKnee: number;
      let lowerKnee: number;

      if (lollipop.tier === 'selected') {
        // Selected tier: keep stem VERTICAL through LoF tier region to avoid collisions
        // Upper knee is BELOW the LoF tier (after passing through it vertically)
        // This ensures selected stems don't cross LoF tier labels
        const lofLowerKnee = lofTierBottom < missenseTop
          ? Math.min(lofTierBottom + 15, missenseTop)
          : lofTierBottom + 8;
        upperKnee = lofLowerKnee;  // Start diagonal BELOW LoF tier
        lowerKnee = lofLowerKnee + 20;  // Short diagonal segment
      } else {
        // LoF tier: crank above missense
        upperKnee = lofTierBottom;
        lowerKnee = upperKnee < missenseTop
          ? Math.min(upperKnee + 15, missenseTop)
          : upperKnee + 8;
      }

      // Upper vertical: from stack bottom down to upper knee
      ctx.moveTo(x, stackBottom);
      ctx.lineTo(x, upperKnee);

      // Diagonal: from upper knee to lower knee (moving toward anchor)
      ctx.lineTo(lollipop.anchorX, lowerKnee);

      // Lower vertical: from lower knee to baseline
      ctx.lineTo(lollipop.anchorX, baselineY);
      ctx.stroke();

      // Find next lollipop in same tier to check horizontal space for secondary labels
      const sameTier = expandedTiers.filter(l => l.tier === lollipop.tier);
      const tierIndex = sameTier.indexOf(lollipop);
      const nextLollipop = tierIndex < sameTier.length - 1 ? sameTier[tierIndex + 1] : null;
      const spaceToNext = nextLollipop
        ? nextLollipop.x - nextLollipop.radius - (x + lollipop.radius)
        : width - x - lollipop.radius;

      // Draw stacked discs (top to bottom) with optional horizontal labels for lower discs
      for (let discIdx = 0; discIdx < lollipop.discs.length; discIdx++) {
        const disc = lollipop.discs[discIdx];
        const discY = lollipop.y + disc.stackY + disc.radius;  // Center Y of this disc

        ctx.beginPath();
        ctx.fillStyle = disc.color;
        ctx.globalAlpha = isHovered ? 1 : 0.9;
        ctx.arc(x, discY, disc.radius, 0, Math.PI * 2);
        ctx.fill();

        // Border - highlight selected variants with blue border
        if (isSelected) {
          ctx.strokeStyle = '#1976d2';
          ctx.lineWidth = 2.5;
        } else if (isHovered) {
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 2;
        } else {
          ctx.strokeStyle = 'rgba(0,0,0,0.3)';
          ctx.lineWidth = 1;
        }
        ctx.stroke();

        // For lower discs in allelic series: show horizontal label if space available
        if (discIdx > 0 && disc.label) {
          const labelWidth = disc.label.length * 6 + 4;  // Estimate
          const labelGap = 8;
          if (spaceToNext >= labelWidth + labelGap || isHovered) {
            ctx.globalAlpha = 1;
            ctx.fillStyle = disc.color;
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(disc.label, x + lollipop.radius + 3, discY);
          }
        }
      }

      // Draw primary label for top disc (with rotation based on density)
      if (lollipop.label && (lollipop.showLabel || isHovered)) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = lollipop.color;
        ctx.font = 'bold 10px sans-serif';

        const topDiscY = lollipop.y + lollipop.discs[0].radius;
        const angle = lollipop.labelAngle;

        if (angle === 0) {
          // Horizontal label - to the right of disc
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(lollipop.label, x + lollipop.radius + 3, topDiscY);
        } else if (angle === -90) {
          // Vertical label - centered above disc
          ctx.save();
          ctx.translate(x, lollipop.y - 3);  // Position above the top disc
          ctx.rotate(-Math.PI / 2);  // -90 degrees
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(lollipop.label, 0, 0);
          ctx.restore();
        } else {
          // Diagonal label (-45°)
          ctx.save();
          ctx.translate(x + lollipop.radius + 3, topDiscY);
          ctx.rotate(angle * Math.PI / 180);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(lollipop.label, 0, 0);
          ctx.restore();
        }
      }
    }

    ctx.globalAlpha = 1;
  }, [lollipops, width, height, hoveredId]);

  // Handle mouse move for hover
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Find closest lollipop (check all discs in stack)
      let closest: { lollipop: LollipopData; discIndex: number; distance: number } | null = null;

      for (const lollipop of lollipopsRef.current) {
        const lx = lollipop.isExpanded ? lollipop.x : lollipop.anchorX;

        // Check each disc in the stack
        for (let i = 0; i < lollipop.discs.length; i++) {
          const disc = lollipop.discs[i];
          const discY = lollipop.y + disc.stackY + disc.radius;
          const distance = Math.sqrt((lx - mouseX) ** 2 + (discY - mouseY) ** 2);
          const hitRadius = disc.radius + 5;

          if (distance < hitRadius && (!closest || distance < closest.distance)) {
            closest = { lollipop, discIndex: i, distance };
          }
        }
      }

      if (closest) {
        setHoveredId(closest.lollipop.id);
        // Return the first variant from the hovered disc
        const hoveredDisc = closest.lollipop.discs[closest.discIndex];
        onHover?.(hoveredDisc.variants[0], mouseX, mouseY);
      } else {
        setHoveredId(null);
        onHover?.(null, mouseX, mouseY);
      }
    },
    [onHover]
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredId(null);
    onHover?.(null, 0, 0);
  }, [onHover]);

  // Handle click to select/deselect variant
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current || !onVariantClick) return;

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Find closest lollipop (check all discs in stack)
      let closest: { lollipop: LollipopData; discIndex: number; distance: number } | null = null;

      for (const lollipop of lollipopsRef.current) {
        const lx = lollipop.isExpanded ? lollipop.x : lollipop.anchorX;

        for (let i = 0; i < lollipop.discs.length; i++) {
          const disc = lollipop.discs[i];
          const discY = lollipop.y + disc.stackY + disc.radius;
          const distance = Math.sqrt((lx - mouseX) ** 2 + (discY - mouseY) ** 2);
          const hitRadius = disc.radius + 5;

          if (distance < hitRadius && (!closest || distance < closest.distance)) {
            closest = { lollipop, discIndex: i, distance };
          }
        }
      }

      if (closest) {
        // Get the first variant from the clicked disc
        const clickedDisc = closest.lollipop.discs[closest.discIndex];
        const variantId = clickedDisc.variants[0]?.variant_id;
        if (variantId) {
          onVariantClick(variantId);
        }
      }
    },
    [onVariantClick]
  );

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', cursor: onVariantClick ? 'pointer' : 'crosshair' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={onVariantClick ? handleClick : undefined}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: width,
          height: height,
        }}
      />
    </div>
  );
}

export default ProteinPaintTrack;
