import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import { scaleLinear, type ScaleLinear } from 'd3-scale';
import type { Gene, Variant, Exon } from '../api/types';

// Helper to get variant position
function getVariantPosition(v: Variant): number {
  return v.pos || v.locus?.position || 0;
}

const BrowserContainer = styled.div`
  margin: 1rem 0;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  padding: 1rem;
  background: #fff;
`;

const BrowserHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  gap: 1rem;
`;

const HeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  flex: 1;
  min-width: 0;
`;

const HeaderRight = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
`;

const BrowserTitle = styled.h3`
  margin: 0;
  font-size: 1rem;
  color: #333;
`;

const ToggleButton = styled.button<{ $active: boolean }>`
  padding: 0.375rem 0.75rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: ${props => props.$active ? '#e3f2fd' : '#fff'};
  color: ${props => props.$active ? '#1976d2' : '#666'};
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    background: ${props => props.$active ? '#bbdefb' : '#f5f5f5'};
    border-color: #ccc;
  }
`;

const LinkButton = styled(Link)`
  padding: 0.375rem 0.75rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #fff;
  color: #666;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  text-decoration: none;

  &:hover {
    background: #f5f5f5;
    border-color: #ccc;
  }
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
  padding: 4px 8px;
  background: #f5f5f5;
  border-radius: 4px;
  font-size: 11px;
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 500px;
  min-width: 200px;
  min-height: 20px;
`;

interface GenomeBrowserProps {
  gene: Gene;
  variants: Variant[];
  exons?: Exon[];
  width?: number;
  showIntrons?: boolean;
  onShowIntronsChange?: (showIntrons: boolean) => void;
  onHoverVariant?: (variant: Variant | null) => void;
  regionUrl?: string;
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

// Region type for collapsed scale
interface Region {
  start: number;
  stop: number;
}

// Create a collapsed scale that maps only exon regions to pixel coordinates
// Returns a function that maps genomic position to pixel position
function createCollapsedScale(
  regions: Region[],
  width: number,
  padding: number = 10
): (pos: number) => number {
  if (regions.length === 0) {
    return () => 0;
  }

  // Sort regions by start position
  const sortedRegions = [...regions].sort((a, b) => a.start - b.start);

  // Merge overlapping regions
  const mergedRegions: Region[] = [];
  for (const region of sortedRegions) {
    if (mergedRegions.length === 0) {
      mergedRegions.push({ ...region });
    } else {
      const last = mergedRegions[mergedRegions.length - 1];
      if (region.start <= last.stop + 1) {
        // Merge overlapping or adjacent regions
        last.stop = Math.max(last.stop, region.stop);
      } else {
        mergedRegions.push({ ...region });
      }
    }
  }

  // Calculate total length of all regions
  const totalLength = mergedRegions.reduce((sum, r) => sum + (r.stop - r.start + 1), 0);

  // Calculate available width (excluding padding between regions)
  const gapWidth = 2; // Small gap between regions
  const numGaps = mergedRegions.length - 1;
  const availableWidth = width - (numGaps * gapWidth) - (padding * 2);

  // Calculate cumulative offsets for each region
  const regionOffsets: { start: number; stop: number; pixelStart: number; pixelEnd: number }[] = [];
  let currentPixel = padding;

  for (const region of mergedRegions) {
    const regionLength = region.stop - region.start + 1;
    const regionWidth = (regionLength / totalLength) * availableWidth;

    regionOffsets.push({
      start: region.start,
      stop: region.stop,
      pixelStart: currentPixel,
      pixelEnd: currentPixel + regionWidth,
    });

    currentPixel += regionWidth + gapWidth;
  }

  // Return scale function
  return (pos: number): number => {
    // Find which region contains this position
    for (const region of regionOffsets) {
      if (pos >= region.start && pos <= region.stop) {
        // Linear interpolation within the region
        const relativePos = (pos - region.start) / (region.stop - region.start + 1);
        return region.pixelStart + relativePos * (region.pixelEnd - region.pixelStart);
      }
    }

    // Position is outside all regions (in an intron)
    // Find the nearest region and return its edge
    for (let i = 0; i < regionOffsets.length; i++) {
      const region = regionOffsets[i];
      if (pos < region.start) {
        // Before this region - return start of this region
        return region.pixelStart;
      }
      if (i < regionOffsets.length - 1) {
        const nextRegion = regionOffsets[i + 1];
        if (pos > region.stop && pos < nextRegion.start) {
          // Between this region and next - return end of this region
          return region.pixelEnd;
        }
      }
    }

    // After all regions
    return regionOffsets[regionOffsets.length - 1]?.pixelEnd ?? width - padding;
  };
}

// Check if a position falls within any exon region
function isInExonRegion(pos: number, exons: Exon[]): boolean {
  return exons.some(exon => pos >= exon.start && pos <= exon.stop);
}

// Exon styling based on feature type (matching gnomAD)
const EXON_STYLES = {
  CDS: {
    fill: '#424242',  // Dark gray for coding regions
    height: 16,
  },
  UTR: {
    fill: '#424242',  // Same color but thinner
    height: 6,
  },
  exon: {
    fill: '#bdbdbd',  // Light gray for generic exons
    height: 6,
  },
};

// Scale function type (can be d3 scale or collapsed scale)
type ScaleFunction = (pos: number) => number;

// Gene Track Component
interface GeneTrackProps {
  gene: Gene;
  exons?: Exon[];
  scale: ScaleFunction;
  width: number;
  showIntrons: boolean;
}

function GeneTrack({ gene, exons, scale, width, showIntrons }: GeneTrackProps) {
  const trackHeight = 40;
  const centerY = trackHeight / 2;

  // Sort exons for proper layering: exon first, then UTR, then CDS
  const sortedExons = useMemo(() => {
    if (!exons || exons.length === 0) return [];
    const order = { exon: 0, UTR: 1, CDS: 2 };
    return [...exons].sort((a, b) => {
      const orderA = order[a.feature_type] ?? 0;
      const orderB = order[b.feature_type] ?? 0;
      return orderA - orderB;
    });
  }, [exons]);

  // Calculate gene span for label positioning
  const geneStart = scale(gene.start);
  const geneEnd = scale(gene.stop);

  return (
    <svg width={width} height={trackHeight}>
      {/* Gene symbol */}
      <text
        x={width / 2}
        y={10}
        fontSize={11}
        fontWeight={500}
        fill="#333"
        textAnchor="middle"
      >
        {gene.gene_symbol || gene.gencode_symbol || gene.gene_id}
      </text>

      {/* Transcript line - only show when introns are visible */}
      {showIntrons && (
        <line
          x1={geneStart}
          y1={centerY}
          x2={geneEnd}
          y2={centerY}
          stroke="#424242"
          strokeWidth={2}
        />
      )}

      {/* Exons */}
      {sortedExons.length > 0 ? (
        sortedExons.map((exon, idx) => {
          const exonStart = scale(exon.start);
          const exonStop = scale(exon.stop);
          const exonWidth = Math.max(1, exonStop - exonStart);
          const style = EXON_STYLES[exon.feature_type] || EXON_STYLES.exon;

          return (
            <rect
              key={`${exon.feature_type}-${exon.start}-${idx}`}
              x={exonStart}
              y={centerY - style.height / 2}
              width={exonWidth}
              height={style.height}
              fill={style.fill}
            />
          );
        })
      ) : (
        // Fallback: simple gene bar if no exons
        <rect
          x={geneStart}
          y={centerY - 3}
          width={Math.max(1, geneEnd - geneStart)}
          height={6}
          fill="#4a90d9"
          rx={2}
        />
      )}
    </svg>
  );
}

// Calculate radius based on log allele frequency
// More common variants (higher AF) get larger circles
function getVariantRadius(af: number | undefined): number {
  const minRadius = 2;
  const maxRadius = 8;

  if (af === undefined || af === null || af === 0) {
    return minRadius;
  }

  // Log10 scale: AF ranges from ~1e-6 to 1
  // Map log10(AF) from [-6, 0] to [minRadius, maxRadius]
  const logAf = Math.log10(Math.max(af, 1e-6));
  const normalizedLog = (logAf + 6) / 6; // Maps [-6, 0] to [0, 1]
  const clampedNorm = Math.max(0, Math.min(1, normalizedLog));

  return minRadius + clampedNorm * (maxRadius - minRadius);
}

// Variant Track Component using Canvas for performance
interface VariantTrackProps {
  variants: Variant[];
  scale: ScaleFunction;
  width: number;
  height?: number;
  exons?: Exon[];
  showIntrons: boolean;
  onHover?: (variant: Variant | null, x: number, y: number) => void;
}

function VariantTrack({ variants, scale, width, height = 80, exons, showIntrons, onHover }: VariantTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Memoize variant positions for hover detection
  // Filter out variants not in exon regions when introns are hidden
  const variantPositions = useMemo(() => {
    const filteredVariants = showIntrons || !exons || exons.length === 0
      ? variants
      : variants.filter(v => isInExonRegion(getVariantPosition(v), exons));

    return filteredVariants.map(v => {
      const af = v.af || v.allele_freq || 0;
      const radius = getVariantRadius(af);
      const pos = getVariantPosition(v);
      return {
        variant: v,
        x: scale(pos),
        // Spread variants vertically with some randomness based on position to avoid overlap
        y: height / 2 + ((pos % 7) - 3) * 6,
        radius,
      };
    });
  }, [variants, scale, height, exons, showIntrons]);

  // Draw variants on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw center line
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Sort by radius (draw larger circles first so smaller ones appear on top)
    const sortedPositions = [...variantPositions].sort((a, b) => b.radius - a.radius);

    // Draw variants
    sortedPositions.forEach(({ variant, x, y, radius }) => {
      ctx.beginPath();
      ctx.fillStyle = getVariantColor(variant);
      ctx.globalAlpha = 0.7;
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fill();
      // Add subtle border for better visibility
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
  }, [variantPositions, width, height]);

  // Handle mouse move for hover
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || !onHover) return;

    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Find closest variant within its radius + small margin
    let closest: { variant: Variant; distance: number } | null = null;
    for (const { variant, x, y, radius } of variantPositions) {
      const distance = Math.sqrt((x - mouseX) ** 2 + (y - mouseY) ** 2);
      const hitRadius = radius + 3; // Add small margin for easier hovering
      if (distance < hitRadius && (!closest || distance < closest.distance)) {
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
  scale: ScaleFunction;
  width: number;
  exons?: Exon[];
  showIntrons: boolean;
  geneStart: number;
  geneStop: number;
}

function PositionAxis({ scale, width, exons, showIntrons, geneStart, geneStop }: PositionAxisProps) {
  // Generate ticks based on view mode
  const ticks = useMemo(() => {
    if (showIntrons) {
      // Full gene view - use regular ticks
      const range = geneStop - geneStart;
      const step = Math.pow(10, Math.floor(Math.log10(range / 5)));
      const start = Math.ceil(geneStart / step) * step;
      const result = [];
      for (let tick = start; tick <= geneStop; tick += step) {
        result.push(tick);
      }
      return result;
    } else if (exons && exons.length > 0) {
      // Collapsed view - show tick at start of each exon region
      const sortedExons = [...exons].sort((a, b) => a.start - b.start);
      // Show start of first exon, middle somewhere, and end of last exon
      const uniqueStarts = [...new Set(sortedExons.map(e => e.start))];
      if (uniqueStarts.length <= 3) {
        return uniqueStarts;
      }
      // Show a subset of exon positions
      const step = Math.max(1, Math.floor(uniqueStarts.length / 4));
      return uniqueStarts.filter((_, i) => i % step === 0);
    }
    return [];
  }, [showIntrons, exons, geneStart, geneStop]);

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
  exons,
  showIntrons: showIntronsProp = false,
  onShowIntronsChange,
  onHoverVariant,
  regionUrl
}: GenomeBrowserProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [hoveredVariant, setHoveredVariant] = useState<Variant | null>(null);

  // Use controlled or uncontrolled mode
  const [showIntronsLocal, setShowIntronsLocal] = useState(false);
  const showIntrons = onShowIntronsChange ? showIntronsProp : showIntronsLocal;
  const setShowIntrons = onShowIntronsChange || setShowIntronsLocal;

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

  // Create full genomic scale
  const fullScale = useMemo(() => {
    const padding = 0.02; // 2% padding on each side
    const range = gene.stop - gene.start;
    const paddedStart = gene.start - range * padding;
    const paddedEnd = gene.stop + range * padding;

    const linearScale = scaleLinear()
      .domain([paddedStart, paddedEnd])
      .range([0, containerWidth]);

    return (pos: number) => linearScale(pos);
  }, [gene.start, gene.stop, containerWidth]);

  // Create collapsed scale (only exon regions)
  const collapsedScale = useMemo(() => {
    if (!exons || exons.length === 0) {
      return fullScale;
    }
    return createCollapsedScale(exons, containerWidth);
  }, [exons, containerWidth, fullScale]);

  // Use appropriate scale based on toggle
  const scale = showIntrons ? fullScale : collapsedScale;

  // Count variants in exon regions
  const exonVariantCount = useMemo(() => {
    if (!exons || exons.length === 0 || showIntrons) {
      return variants.length;
    }
    return variants.filter(v => isInExonRegion(getVariantPosition(v), exons)).length;
  }, [variants, exons, showIntrons]);

  // Handle variant hover
  const handleVariantHover = useCallback((variant: Variant | null) => {
    setHoveredVariant(variant);
    onHoverVariant?.(variant);
  }, [onHoverVariant]);

  return (
    <BrowserContainer ref={containerRef}>
      <BrowserHeader>
        <HeaderLeft>
          <BrowserTitle>
            Variant Distribution ({exonVariantCount.toLocaleString()} variants
            {!showIntrons && exons && exons.length > 0 && ' in coding regions'})
          </BrowserTitle>
          <HoverInfo>
            {hoveredVariant ? (
              <>
                <strong>{hoveredVariant.variant_id}</strong>
                {' | '}
                {hoveredVariant.pos?.toLocaleString()}
                {hoveredVariant.af !== undefined && (
                  <>
                    {' | AF: '}
                    {hoveredVariant.af < 0.0001 ? hoveredVariant.af.toExponential(2) : hoveredVariant.af.toFixed(4)}
                  </>
                )}
                {hoveredVariant.consequence && (
                  <>
                    {' | '}
                    {hoveredVariant.consequence}
                  </>
                )}
              </>
            ) : (
              <span style={{ color: '#999' }}>Hover over a variant for details</span>
            )}
          </HoverInfo>
        </HeaderLeft>
        <HeaderRight>
          {regionUrl && (
            <LinkButton to={regionUrl}>
              View region
            </LinkButton>
          )}
          {exons && exons.length > 0 && (
            <ToggleButton
              $active={showIntrons}
              onClick={() => setShowIntrons(!showIntrons)}
              title={showIntrons ? 'Hide intronic regions' : 'Show intronic regions'}
            >
              {showIntrons ? 'Hide introns' : 'Show full gene'}
            </ToggleButton>
          )}
        </HeaderRight>
      </BrowserHeader>

      <TrackContainer>
        {/* Gene Track */}
        <TrackRow>
          <TrackLabel>Gene</TrackLabel>
          <TrackContent>
            <GeneTrack
              gene={gene}
              exons={exons}
              scale={scale}
              width={containerWidth}
              showIntrons={showIntrons}
            />
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
              exons={exons}
              showIntrons={showIntrons}
              onHover={handleVariantHover}
            />
          </TrackContent>
        </TrackRow>

        {/* Position Axis */}
        <TrackRow>
          <TrackLabel>Position</TrackLabel>
          <TrackContent>
            <PositionAxis
              scale={scale}
              width={containerWidth}
              exons={exons}
              showIntrons={showIntrons}
              geneStart={gene.start}
              geneStop={gene.stop}
            />
          </TrackContent>
        </TrackRow>
      </TrackContainer>
    </BrowserContainer>
  );
}

export default GenomeBrowser;
