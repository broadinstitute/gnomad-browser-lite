import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import styled from 'styled-components';
import { scaleLinear, type ScaleLinear } from 'd3-scale';
import type { Gene, Variant } from '../api/types';

const BrowserContainer = styled.div`
  margin: 1rem 0;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  padding: 1rem;
  background: #fff;
`;

const BrowserTitle = styled.h3`
  margin: 0 0 1rem 0;
  font-size: 1rem;
  color: #333;
`;

const TrackContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const TrackRow = styled.div`
  display: flex;
  align-items: stretch;
`;

const TrackLabel = styled.div`
  width: 80px;
  min-width: 80px;
  font-size: 12px;
  color: #666;
  padding-right: 8px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
`;

const TrackContent = styled.div`
  flex: 1;
  position: relative;
`;

const HoverInfo = styled.div`
  margin-top: 8px;
  padding: 8px;
  background: #f5f5f5;
  border-radius: 4px;
  font-size: 12px;
  color: #333;
`;

interface GenomeBrowserProps {
  gene: Gene;
  variants: Variant[];
  width?: number;
  onHoverVariant?: (variant: Variant | null) => void;
}

// Determine variant color based on consequence
function getVariantColor(variant: Variant): string {
  const consequence = variant.consequence?.toLowerCase() || '';

  if (consequence.includes('frameshift') ||
      consequence.includes('stop_gained') ||
      consequence.includes('splice_acceptor') ||
      consequence.includes('splice_donor') ||
      consequence.includes('start_lost')) {
    return '#dd3333'; // Loss of function - red
  }
  if (consequence.includes('missense')) {
    return '#f59e0b'; // Missense - orange
  }
  if (consequence.includes('synonymous')) {
    return '#10b981'; // Synonymous - green
  }
  if (consequence.includes('intron') ||
      consequence.includes('upstream') ||
      consequence.includes('downstream')) {
    return '#a0aec0'; // Non-coding - light gray
  }
  return '#757575'; // Default - gray
}

// Gene Track Component
interface GeneTrackProps {
  gene: Gene;
  scale: ScaleLinear<number, number>;
  width: number;
}

function GeneTrack({ gene, scale, width }: GeneTrackProps) {
  const geneStart = scale(gene.start);
  const geneEnd = scale(gene.stop);
  const geneWidth = Math.max(1, geneEnd - geneStart);

  return (
    <svg width={width} height={30}>
      {/* Gene bar */}
      <rect
        x={geneStart}
        y={12}
        width={geneWidth}
        height={6}
        fill="#4a90d9"
        rx={2}
      />
      {/* Gene symbol */}
      <text
        x={geneStart + geneWidth / 2}
        y={10}
        fontSize={10}
        fontWeight={500}
        fill="#333"
        textAnchor="middle"
      >
        {gene.gene_symbol || gene.gencode_symbol || gene.gene_id}
      </text>
    </svg>
  );
}

// Variant Track Component using Canvas for performance
interface VariantTrackProps {
  variants: Variant[];
  scale: ScaleLinear<number, number>;
  width: number;
  height?: number;
  onHover?: (variant: Variant | null, x: number, y: number) => void;
}

function VariantTrack({ variants, scale, width, height = 60, onHover }: VariantTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Memoize variant positions for hover detection
  const variantPositions = useMemo(() => {
    return variants.map(v => ({
      variant: v,
      x: scale(v.pos),
      // Y position based on allele frequency (higher AF = lower on screen)
      y: Math.max(4, Math.min(height - 4, height - 4 - Math.log10(Math.max(v.af || v.allele_freq || 0.00001, 0.00001) + 0.00001) * 8))
    }));
  }, [variants, scale, height]);

  // Draw variants on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw background grid
    ctx.strokeStyle = '#f0f0f0';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const y = (height / 5) * i + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Draw variants
    variantPositions.forEach(({ variant, x, y }) => {
      ctx.beginPath();
      ctx.fillStyle = getVariantColor(variant);
      ctx.globalAlpha = 0.7;
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fill();
    });

    ctx.globalAlpha = 1;
  }, [variantPositions, width, height]);

  // Handle mouse move for hover
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || !onHover) return;

    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Find closest variant within 10px
    let closest: { variant: Variant; distance: number } | null = null;
    for (const { variant, x, y } of variantPositions) {
      const distance = Math.sqrt((x - mouseX) ** 2 + (y - mouseY) ** 2);
      if (distance < 10 && (!closest || distance < closest.distance)) {
        closest = { variant, distance };
      }
    }

    onHover(closest?.variant || null, mouseX, mouseY);
  }, [variantPositions, onHover]);

  const handleMouseLeave = useCallback(() => {
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
        width={width}
        height={height}
        style={{ display: 'block' }}
      />
    </div>
  );
}

// Position Axis Component
interface PositionAxisProps {
  scale: ScaleLinear<number, number>;
  width: number;
}

function PositionAxis({ scale, width }: PositionAxisProps) {
  const ticks = scale.ticks(8);

  return (
    <svg width={width} height={25}>
      {/* Axis line */}
      <line x1={0} y1={0} x2={width} y2={0} stroke="#999" strokeWidth={1} />

      {/* Ticks */}
      {ticks.map(tick => {
        const x = scale(tick);
        return (
          <g key={tick} transform={`translate(${x}, 0)`}>
            <line y1={0} y2={5} stroke="#999" strokeWidth={1} />
            <text
              y={18}
              fontSize={10}
              fill="#666"
              textAnchor="middle"
            >
              {(tick / 1e6).toFixed(2)}Mb
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function GenomeBrowser({
  gene,
  variants,
  onHoverVariant
}: GenomeBrowserProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [hoveredVariant, setHoveredVariant] = useState<Variant | null>(null);

  // Measure container width
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width - 32 - 80); // Account for padding and label
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Create scale for genomic coordinates
  const scale = useMemo(() => {
    const padding = 0.02; // 2% padding on each side
    const range = gene.stop - gene.start;
    const paddedStart = gene.start - range * padding;
    const paddedEnd = gene.stop + range * padding;

    return scaleLinear()
      .domain([paddedStart, paddedEnd])
      .range([0, containerWidth]);
  }, [gene.start, gene.stop, containerWidth]);

  // Handle variant hover
  const handleVariantHover = useCallback((variant: Variant | null) => {
    setHoveredVariant(variant);
    onHoverVariant?.(variant);
  }, [onHoverVariant]);

  return (
    <BrowserContainer ref={containerRef}>
      <BrowserTitle>Variant Distribution ({variants.length.toLocaleString()} variants)</BrowserTitle>

      <TrackContainer>
        {/* Gene Track */}
        <TrackRow>
          <TrackLabel>Gene</TrackLabel>
          <TrackContent>
            <GeneTrack gene={gene} scale={scale} width={containerWidth} />
          </TrackContent>
        </TrackRow>

        {/* Variant Track */}
        <TrackRow>
          <TrackLabel>Variants</TrackLabel>
          <TrackContent>
            <VariantTrack
              variants={variants}
              scale={scale}
              width={containerWidth}
              onHover={handleVariantHover}
            />
          </TrackContent>
        </TrackRow>

        {/* Position Axis */}
        <TrackRow>
          <TrackLabel>Position</TrackLabel>
          <TrackContent>
            <PositionAxis scale={scale} width={containerWidth} />
          </TrackContent>
        </TrackRow>
      </TrackContainer>

      {hoveredVariant && (
        <HoverInfo>
          <strong>{hoveredVariant.variant_id}</strong>
          {' | '}
          Position: {hoveredVariant.pos?.toLocaleString()}
          {hoveredVariant.af !== undefined && (
            <>
              {' | '}
              AF: {hoveredVariant.af < 0.0001 ? hoveredVariant.af.toExponential(2) : hoveredVariant.af.toFixed(6)}
            </>
          )}
          {hoveredVariant.consequence && (
            <>
              {' | '}
              {hoveredVariant.consequence}
            </>
          )}
        </HoverInfo>
      )}
    </BrowserContainer>
  );
}

export default GenomeBrowser;
