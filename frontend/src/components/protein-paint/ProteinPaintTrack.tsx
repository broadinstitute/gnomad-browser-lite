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
import { getLayoutParams, createLollipops, layoutLollipops } from './utils';
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

    // Draw non-LoF tiers first (simple straight stems)
    for (const lollipop of otherTiers) {
      const isHovered = lollipop.id === hoveredId;

      // Draw straight stem
      ctx.strokeStyle = '#ccc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lollipop.anchorX, baselineY);
      ctx.lineTo(lollipop.anchorX, lollipop.y);
      ctx.stroke();

      // Draw disc
      ctx.beginPath();
      ctx.fillStyle = lollipop.color;
      ctx.globalAlpha = isHovered ? 1 : 0.7;
      ctx.arc(lollipop.anchorX, lollipop.y, lollipop.radius, 0, Math.PI * 2);
      ctx.fill();

      // Border
      ctx.strokeStyle = isHovered ? '#000' : 'rgba(0,0,0,0.15)';
      ctx.lineWidth = isHovered ? 2 : 1;
      ctx.stroke();

      // Show label on hover only
      if (isHovered && lollipop.label) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#333';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(lollipop.label, lollipop.anchorX + lollipop.radius + 3, lollipop.y);
      }
    }

    // Draw LoF tier (diagonal stems with labels)
    for (const lollipop of lofTier) {
      const isHovered = lollipop.id === hoveredId;

      // Draw stem: straight up from baseline, then diagonal to disc
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lollipop.anchorX, baselineY);

      // Vertical part
      const bendY = lollipop.y + 15;
      ctx.lineTo(lollipop.anchorX, bendY);

      // Diagonal to disc
      ctx.lineTo(lollipop.x, lollipop.y);
      ctx.stroke();

      // Draw disc
      ctx.beginPath();
      ctx.fillStyle = lollipop.color;
      ctx.globalAlpha = isHovered ? 1 : 0.9;
      ctx.arc(lollipop.x, lollipop.y, lollipop.radius, 0, Math.PI * 2);
      ctx.fill();

      // Border
      ctx.strokeStyle = isHovered ? '#000' : 'rgba(0,0,0,0.3)';
      ctx.lineWidth = isHovered ? 2 : 1;
      ctx.stroke();

      // Draw label (always shown for LoF)
      if (lollipop.label) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = lollipop.color;
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(lollipop.label, lollipop.x + lollipop.radius + 3, lollipop.y);
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

      // Find closest lollipop
      let closest: { lollipop: LollipopData; distance: number } | null = null;

      for (const lollipop of lollipopsRef.current) {
        const lx = lollipop.isTopTier ? lollipop.x : lollipop.anchorX;
        const distance = Math.sqrt((lx - mouseX) ** 2 + (lollipop.y - mouseY) ** 2);
        const hitRadius = lollipop.radius + 5;

        if (distance < hitRadius && (!closest || distance < closest.distance)) {
          closest = { lollipop, distance };
        }
      }

      if (closest) {
        setHoveredId(closest.lollipop.id);
        onHover?.(closest.lollipop.variants[0], mouseX, mouseY);
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
