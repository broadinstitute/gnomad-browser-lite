import { useRef, useEffect, useMemo, useCallback } from 'react';
import type { Variant, Exon } from '../api/types';
import type { ScalePosition } from '../utils/coordinates';
import { getVariantPosition, getConsequencePriority, isInExonRegion } from './variantUtils';
import { getStandardLayers } from './protein-paint/utils';

const BIN_WIDTH = 4;

export interface BinData {
  pixelStart: number;
  pixelEnd: number;
  total: number;
  categories: {
    lof: number;
    missense: number;
    synonymous: number;
    other: number;
  };
}

interface VariantHistogramTrackProps {
  variants: Variant[];
  scale: ScalePosition;
  width: number;
  height?: number;
  exons?: Exon[];
  showIntrons: boolean;
  onHoverBin?: (bin: BinData | null) => void;
}

// Extract colors from standard layers (matching lollipop view exactly)
const LAYER_COLORS = (() => {
  const layers = getStandardLayers();
  const colorMap: Record<string, string> = {};
  for (const layer of layers) {
    colorMap[layer.id] = layer.color;
  }
  return {
    lof: colorMap['lof'] || '#dd3333',
    missense: colorMap['missense'] || '#f59e0b',
    synonymous: colorMap['synonymous'] || '#22c55e',
    other: colorMap['noncoding'] || '#757575',
  };
})();

// Draw order: bottom to top (other, synonymous, missense, lof)
const DRAW_ORDER: (keyof BinData['categories'])[] = ['other', 'synonymous', 'missense', 'lof'];
const CATEGORY_COLORS: Record<string, string> = {
  lof: LAYER_COLORS.lof,
  missense: LAYER_COLORS.missense,
  synonymous: LAYER_COLORS.synonymous,
  other: LAYER_COLORS.other,
};

function categorizePriority(priority: number): keyof BinData['categories'] {
  if (priority >= 4) return 'lof';
  if (priority === 3) return 'missense';
  if (priority === 2) return 'synonymous';
  return 'other';
}

export function VariantHistogramTrack({
  variants,
  scale,
  width,
  height = 150,
  exons,
  showIntrons,
  onHoverBin,
}: VariantHistogramTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const bins = useMemo(() => {
    const numBins = Math.max(1, Math.floor(width / BIN_WIDTH));
    const binArray: BinData[] = Array.from({ length: numBins }, (_, i) => ({
      pixelStart: i * BIN_WIDTH,
      pixelEnd: (i + 1) * BIN_WIDTH,
      total: 0,
      categories: { lof: 0, missense: 0, synonymous: 0, other: 0 },
    }));

    const filteredVariants = showIntrons || !exons || exons.length === 0
      ? variants
      : variants.filter(v => isInExonRegion(getVariantPosition(v), exons));

    for (const v of filteredVariants) {
      const pixelX = scale(getVariantPosition(v));
      const binIndex = Math.floor(pixelX / BIN_WIDTH);
      if (binIndex >= 0 && binIndex < numBins) {
        const bin = binArray[binIndex];
        const priority = getConsequencePriority(v.consequence || '');
        const category = categorizePriority(priority);
        bin.categories[category]++;
        bin.total++;
      }
    }

    return binArray;
  }, [variants, scale, width, exons, showIntrons]);

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Find max bin total for Y scale
    const maxTotal = Math.max(1, ...bins.map(b => b.total));

    const plotBottom = height - 20; // leave room for gene model below
    const plotTop = 30;
    const plotHeight = plotBottom - plotTop;

    // Draw bars
    for (const bin of bins) {
      if (bin.total === 0) continue;

      let yOffset = plotBottom;

      for (const category of DRAW_ORDER) {
        const count = bin.categories[category];
        if (count === 0) continue;

        const barHeight = (count / maxTotal) * plotHeight;
        yOffset -= barHeight;

        ctx.fillStyle = CATEGORY_COLORS[category];
        ctx.fillRect(bin.pixelStart, yOffset, BIN_WIDTH - 1, barHeight);
      }
    }
  }, [bins, width, height]);

  // Hover handling
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || !onHoverBin) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const binIndex = Math.floor(mouseX / BIN_WIDTH);

    if (binIndex >= 0 && binIndex < bins.length && bins[binIndex].total > 0) {
      onHoverBin(bins[binIndex]);
    } else {
      onHoverBin(null);
    }
  }, [bins, onHoverBin]);

  const handleMouseLeave = useCallback(() => {
    onHoverBin?.(null);
  }, [onHoverBin]);

  const maxTotal = useMemo(() => Math.max(1, ...bins.map(b => b.total)), [bins]);

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', cursor: 'crosshair' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Y-axis max label positioned to the left of the track */}
      <div style={{
        position: 'absolute',
        left: -28,
        top: 8,
        fontSize: 9,
        color: '#999',
        textAlign: 'right',
        width: 24,
      }}>
        {maxTotal}
      </div>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ display: 'block', width, height }}
      />
    </div>
  );
}
