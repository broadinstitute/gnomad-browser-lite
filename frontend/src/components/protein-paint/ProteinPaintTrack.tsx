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
import type { LollipopData, LayerDefinition } from './types';
import {
  getLayoutParams,
  createLollipops,
  layoutLollipops,
  getStandardLayers,
  createSelectionLayer,
  calculateRequiredHeight,
} from './utils';
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
  /** Custom layer configuration (optional, uses standard gnomAD layers if not provided) */
  customLayers?: LayerDefinition[];
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
  customLayers,
}: ProteinPaintTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lollipopsRef = useRef<LollipopData[]>([]);

  // Track hovered lollipop
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Position overrides for dragged lollipops (id -> custom X coordinate)
  const [positionOverrides, setPositionOverrides] = useState<Record<string, number>>({});

  // Current drag state
  const [dragState, setDragState] = useState<{
    id: string;        // ID of lollipop being dragged
    startX: number;    // Mouse X at start of drag
    initialX: number;  // Lollipop X at start of drag
    hasMoved: boolean; // To distinguish click vs drag
  } | null>(null);

  // Ref to track if a drag just occurred (since click fires after mouseUp)
  const wasDraggingRef = useRef(false);

  // Filter variants based on intron visibility
  const filteredVariants = useMemo(() => {
    if (showIntrons || !exons || exons.length === 0) {
      return variants;
    }
    return variants.filter((v) => isInExonRegion(getVariantPosition(v), exons));
  }, [variants, exons, showIntrons]);

  // Memoize layer configuration (no longer depends on height)
  const layers = useMemo(() => {
    const baseLayers = customLayers || getStandardLayers();

    // If there are selected variants, prepend selection layer
    if (selectedIds && selectedIds.size > 0) {
      const selectionLayer = createSelectionLayer(selectedIds);
      // Only prepend if not already in custom layers
      if (!baseLayers.find(l => l.id === 'selected')) {
        return [selectionLayer, ...baseLayers];
      }
    }

    return baseLayers;
  }, [customLayers, selectedIds]);

  // Create and layout lollipops, then calculate required height
  const { lollipops, effectiveHeight } = useMemo(() => {
    // Use a large initial height for layout params (bottomTierY calculation)
    const maxHeight = 300;
    const params = getLayoutParams(maxHeight);
    params.selectedIds = selectedIds;
    const data = createLollipops(filteredVariants, scale, params, layers);
    layoutLollipops(data, width, params, layers);

    // Calculate the actual required height based on which layers have data
    const requiredHeight = calculateRequiredHeight(data);

    return { lollipops: data, effectiveHeight: requiredHeight };
  }, [filteredVariants, scale, width, selectedIds, layers]);

  // Use effective height for rendering (ignore the prop if we have data)
  const renderHeight = lollipops.length > 0 ? effectiveHeight : height;

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
    canvas.height = renderHeight * dpr;
    ctx.scale(dpr, dpr);

    const baselineY = renderHeight - 25; // Stems end above the gene track

    // Clear canvas
    ctx.clearRect(0, 0, width, renderHeight);

    // Separate lollipops by expansion type
    const expandedTiers = lollipops.filter(l => l.isExpanded);
    const regularTiers = lollipops.filter(l => !l.isExpanded);

    // Group expanded tiers by layerId for calculating knee positions
    const selectedTier = expandedTiers.filter(l => l.layerId === 'selected');
    // Non-selected expanded tier (could be LoF, missense, etc. depending on filtering)
    const topExpandedTier = expandedTiers.filter(l => l.layerId !== 'selected');

    // Calculate bottom of each expanded tier for crank positioning
    const selectedTierBottom = selectedTier.length > 0
      ? Math.max(...selectedTier.map(l => l.y + l.stackHeight)) + 3
      : 0;
    const topExpandedTierBottom = topExpandedTier.length > 0
      ? Math.max(...topExpandedTier.map(l => l.y + l.stackHeight)) + 3
      : 0;

    // Find the top of the first non-expanded tier (for knee positioning)
    // If no condensed tiers, use a position that allows proper crankshaft geometry
    const firstCondensedY = regularTiers.length > 0
      ? Math.min(...regularTiers.map(l => l.y)) - 15
      : baselineY - 60;

    // Minimum lengths for crankshaft segments
    const MIN_UPPER_VERTICAL = 20;   // Disc to upper knee
    const MIN_DIAGONAL_HEIGHT = 40;  // Upper knee to lower knee (vertical component)
    const MIN_LOWER_VERTICAL = 25;   // Lower knee to baseline

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
      // Use override position if user has dragged this lollipop
      const x = positionOverrides[lollipop.id] ?? lollipop.x;

      // Calculate stack bottom
      const stackBottom = lollipop.y + lollipop.stackHeight;

      // Draw stem with crank/dog-leg style:
      // Upper vertical -> Diagonal -> Lower vertical
      // The diagonal happens in the gap between tiers
      ctx.strokeStyle = isSelected ? '#1976d2' : '#999';
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.beginPath();

      // Calculate crank segments based on layer type
      // Structure: Disc -> Upper Vertical -> Upper Knee -> Diagonal -> Lower Knee -> Lower Vertical -> Baseline
      let upperKnee: number;
      let lowerKnee: number;

      if (lollipop.layerId === 'selected') {
        // Selected layer: keep stem VERTICAL through the top expanded tier region
        // Upper knee is BELOW the top expanded tier (after passing through it vertically)
        const topTierLowerKnee = topExpandedTierBottom > 0
          ? topExpandedTierBottom + MIN_UPPER_VERTICAL
          : stackBottom + MIN_UPPER_VERTICAL;
        upperKnee = topTierLowerKnee;
        lowerKnee = Math.min(upperKnee + MIN_DIAGONAL_HEIGHT, baselineY - MIN_LOWER_VERTICAL);
      } else {
        // Other expanded layers: ensure proper crankshaft geometry
        // Upper knee: below the disc stack with minimum vertical segment
        upperKnee = stackBottom + MIN_UPPER_VERTICAL;

        // Lower knee: ensure minimum diagonal height, but stay above baseline
        const idealLowerKnee = upperKnee + MIN_DIAGONAL_HEIGHT;
        const maxLowerKnee = baselineY - MIN_LOWER_VERTICAL;

        // Lower knee must be below upper knee (diagonal goes down, not up)
        lowerKnee = Math.max(upperKnee + 10, Math.min(idealLowerKnee, maxLowerKnee));
      }

      // Upper vertical: from stack bottom down to upper knee
      ctx.moveTo(x, stackBottom);
      ctx.lineTo(x, upperKnee);

      // Diagonal: from upper knee to lower knee (moving toward anchor)
      ctx.lineTo(lollipop.anchorX, lowerKnee);

      // Lower vertical: from lower knee to baseline
      ctx.lineTo(lollipop.anchorX, baselineY);
      ctx.stroke();

      // Find next lollipop in same layer to check horizontal space for secondary labels
      const sameTier = expandedTiers.filter(l => l.layerId === lollipop.layerId);
      const tierIndex = sameTier.indexOf(lollipop);
      const nextLollipop = tierIndex < sameTier.length - 1 ? sameTier[tierIndex + 1] : null;
      const nextX = nextLollipop ? (positionOverrides[nextLollipop.id] ?? nextLollipop.x) : null;
      const spaceToNext = nextX !== null
        ? nextX - nextLollipop!.radius - (x + lollipop.radius)
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
  }, [lollipops, width, renderHeight, hoveredId, positionOverrides]);

  // Handle mouse move for hover and dragging
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Handle dragging
      if (dragState) {
        const deltaX = mouseX - dragState.startX;
        const newX = Math.max(0, Math.min(width, dragState.initialX + deltaX));

        // Mark as moved if delta > threshold (3px)
        const hasMoved = dragState.hasMoved || Math.abs(deltaX) > 3;
        if (hasMoved && !dragState.hasMoved) {
          setDragState({ ...dragState, hasMoved: true });
        }

        setPositionOverrides((prev) => ({
          ...prev,
          [dragState.id]: newX,
        }));
        return; // Don't update hover state while dragging
      }

      // Find closest lollipop (check all discs in stack)
      let closest: { lollipop: LollipopData; discIndex: number; distance: number } | null = null;

      for (const lollipop of lollipopsRef.current) {
        // Use current visual position (with override if exists)
        const lx = lollipop.isExpanded
          ? (positionOverrides[lollipop.id] ?? lollipop.x)
          : lollipop.anchorX;

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
    [onHover, dragState, positionOverrides, width]
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredId(null);
    onHover?.(null, 0, 0);
    // End any drag in progress
    setDragState(null);
  }, [onHover]);

  // Handle mouse down to start dragging
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Find closest lollipop (check all discs in stack)
      let closest: { lollipop: LollipopData; distance: number } | null = null;

      for (const lollipop of lollipopsRef.current) {
        // Use current visual position (with override if exists)
        const lx = lollipop.isExpanded
          ? (positionOverrides[lollipop.id] ?? lollipop.x)
          : lollipop.anchorX;

        for (const disc of lollipop.discs) {
          const discY = lollipop.y + disc.stackY + disc.radius;
          const distance = Math.sqrt((lx - mouseX) ** 2 + (discY - mouseY) ** 2);
          const hitRadius = disc.radius + 5;

          if (distance < hitRadius && (!closest || distance < closest.distance)) {
            closest = { lollipop, distance };
          }
        }
      }

      if (closest) {
        // Stop propagation to prevent parent's drag-to-zoom from triggering
        e.stopPropagation();

        // Start dragging this lollipop
        const currentX = positionOverrides[closest.lollipop.id] ?? closest.lollipop.x;
        setDragState({
          id: closest.lollipop.id,
          startX: mouseX,
          initialX: currentX,
          hasMoved: false,
        });
      }
    },
    [positionOverrides]
  );

  // Handle mouse up to end dragging
  const handleMouseUp = useCallback(() => {
    // Track if we were dragging (for click handler)
    wasDraggingRef.current = dragState?.hasMoved ?? false;
    setDragState(null);
    // Clear the flag after a brief delay (to catch the click event)
    setTimeout(() => {
      wasDraggingRef.current = false;
    }, 0);
  }, [dragState]);

  // Handle click to select/deselect variant
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current || !onVariantClick) return;

      // Ignore click if we were dragging
      if (wasDraggingRef.current) {
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Find closest lollipop (check all discs in stack)
      let closest: { lollipop: LollipopData; discIndex: number; distance: number } | null = null;

      for (const lollipop of lollipopsRef.current) {
        // Use current visual position (with override if exists)
        const lx = lollipop.isExpanded
          ? (positionOverrides[lollipop.id] ?? lollipop.x)
          : lollipop.anchorX;

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
    [onVariantClick, positionOverrides]
  );

  // Compute cursor style based on drag and hover state
  const cursor = dragState
    ? 'grabbing'
    : hoveredId
    ? 'grab'
    : onVariantClick
    ? 'pointer'
    : 'crosshair';

  // Check if any positions have been overridden
  const hasOverrides = Object.keys(positionOverrides).length > 0;

  // Reset all position overrides
  const handleResetLayout = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger drag or click handlers
    setPositionOverrides({});
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', cursor }}
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onClick={onVariantClick ? handleClick : undefined}
    >
      <canvas
        key={`canvas-${width}-${renderHeight}`}
        ref={canvasRef}
        style={{
          display: 'block',
          width: `${width}px`,
          height: `${renderHeight}px`,
        }}
      />
      {hasOverrides && (
        <button
          onClick={handleResetLayout}
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            padding: '2px 8px',
            fontSize: '11px',
            backgroundColor: 'rgba(255, 255, 255, 0.9)',
            border: '1px solid #ccc',
            borderRadius: '3px',
            cursor: 'pointer',
            color: '#666',
          }}
          title="Reset dragged positions"
        >
          Reset layout
        </button>
      )}
    </div>
  );
}

export default ProteinPaintTrack;
