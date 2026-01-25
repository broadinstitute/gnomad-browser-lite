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
}

export function ProteinPaintTrack({
  variants,
  scale,
  width,
  height = 240,
  exons,
  showIntrons,
  onHover,
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
    const data = createLollipops(filteredVariants, scale, params);
    layoutLollipops(data, width, params);
    return data;
  }, [filteredVariants, scale, width, height]);

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

    // Separate lollipops by tier
    const lofTier = lollipops.filter(l => l.isTopTier);
    const otherTiers = lollipops.filter(l => !l.isTopTier);

    // Get tier positions for layer-aware crank stems
    const tierPositions = getTierPositions(height);

    // Calculate the bottom of all LoF disc stacks to ensure stems don't cross over discs
    const lofTierBottom = lofTier.length > 0
      ? Math.max(...lofTier.map(l => l.y + l.stackHeight)) + 3  // Small gap below lowest stack
      : 0;

    // The lower knee of the crank must be ABOVE the missense layer
    // This ensures the diagonal happens in the gap between LoF and missense
    const missenseTop = tierPositions.missense - 20;  // More margin above missense discs

    // Draw non-LoF tiers first (simple straight stems with stacked discs)
    for (const lollipop of otherTiers) {
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

      // Show label on hover only (show top disc's label)
      if (isHovered && lollipop.label) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#333';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const topDiscY = lollipop.y + lollipop.discs[0].radius;
        ctx.fillText(lollipop.label, x + lollipop.radius + 3, topDiscY);
      }
    }

    // Draw LoF tier (crank/dog-leg stems with stacked discs and labels)
    for (const lollipop of lofTier) {
      const isHovered = lollipop.id === hoveredId;
      const x = lollipop.x;

      // Calculate stack bottom
      const stackBottom = lollipop.y + lollipop.stackHeight;

      // Draw stem with crank/dog-leg style:
      // Upper vertical -> Diagonal -> Lower vertical
      // The diagonal happens in the gap between LoF and missense tiers
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1;
      ctx.beginPath();

      // Calculate crank segments - keep diagonal tight and high
      const upperKnee = lofTierBottom;
      // Lower knee should be below upper knee AND above missense
      // Keep diagonal short (15px) to stay high on the canvas
      const lowerKnee = upperKnee < missenseTop
        ? Math.min(upperKnee + 15, missenseTop)  // Normal case: short diagonal in gap
        : upperKnee + 8;  // Tight case: minimal diagonal

      // Upper vertical: from stack bottom down to upper knee
      ctx.moveTo(x, stackBottom);
      ctx.lineTo(x, upperKnee);

      // Diagonal: from upper knee to lower knee (moving toward anchor)
      ctx.lineTo(lollipop.anchorX, lowerKnee);

      // Lower vertical: from lower knee to baseline
      ctx.lineTo(lollipop.anchorX, baselineY);
      ctx.stroke();

      // Draw stacked discs (top to bottom)
      for (const disc of lollipop.discs) {
        const discY = lollipop.y + disc.stackY + disc.radius;  // Center Y of this disc

        ctx.beginPath();
        ctx.fillStyle = disc.color;
        ctx.globalAlpha = isHovered ? 1 : 0.9;
        ctx.arc(x, discY, disc.radius, 0, Math.PI * 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = isHovered ? '#000' : 'rgba(0,0,0,0.3)';
        ctx.lineWidth = isHovered ? 2 : 1;
        ctx.stroke();
      }

      // Draw label (only when showLabel is true, or on hover) - show top disc's label
      if (lollipop.label && (lollipop.showLabel || isHovered)) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = lollipop.color;
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const topDiscY = lollipop.y + lollipop.discs[0].radius;
        ctx.fillText(lollipop.label, x + lollipop.radius + 3, topDiscY);
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
        const lx = lollipop.isTopTier ? lollipop.x : lollipop.anchorX;

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

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', cursor: 'crosshair' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
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
