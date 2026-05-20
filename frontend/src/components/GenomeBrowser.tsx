import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import type { Gene, Variant, Exon } from '../api/types';
import {
  type Region,
  type ScalePosition,
  mergeOverlappingRegions,
  regionViewerScale,
  linearGenomicScale,
} from '../utils/coordinates';
import {
  getVariantPosition,
  getVariantColor,
  isInExonRegion,
  getVariantRadius,
} from './variantUtils';
import { ProteinPaintTrack } from './protein-paint';
import { VariantHistogramTrack, type BinData } from './VariantHistogramTrack';

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

const SelectionOverlay = styled.div`
  position: absolute;
  top: 0;
  height: 100%;
  background: rgba(66, 133, 244, 0.2);
  border: 1px solid rgba(66, 133, 244, 0.6);
  pointer-events: none;
  z-index: 10;
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
  /** Optional zoom region - if provided, scale will be limited to this region */
  region?: { start: number; stop: number };
  /** Callback when user selects a new region via drag */
  onRegionChange?: (region: { start: number; stop: number }) => void;
  /** Force histogram mode while data is still streaming in */
  isStreaming?: boolean;
  /** Include UTR regions in display and query */
  includeUTRs?: boolean;
  onIncludeUTRsChange?: (v: boolean) => void;
  /** Include non-coding transcript exons in display and query */
  includeNonCodingTranscripts?: boolean;
  onIncludeNonCodingTranscriptsChange?: (v: boolean) => void;
  /** Set of selected variant IDs */
  selectedVariantIds?: Set<string>;
  /** Callback when a variant selection is toggled */
  onToggleVariantSelection?: (variantId: string) => void;
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


// Gene Track Component
interface GeneTrackProps {
  gene: Gene;
  exons?: Exon[];
  scale: ScalePosition;
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

// Variant Track Component using Canvas for performance
interface VariantTrackProps {
  variants: Variant[];
  scale: ScalePosition;
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
  scale: ScalePosition;
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
  regionUrl,
  region,
  onRegionChange,
  isStreaming = false,
  includeUTRs = false,
  onIncludeUTRsChange,
  includeNonCodingTranscripts = false,
  onIncludeNonCodingTranscriptsChange,
  selectedVariantIds,
  onToggleVariantSelection,
}: GenomeBrowserProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [hoveredVariant, setHoveredVariant] = useState<Variant | null>(null);

  // Drag selection state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);

  // Use controlled or uncontrolled mode
  const [showIntronsLocal, setShowIntronsLocal] = useState(false);
  const showIntrons = onShowIntronsChange ? showIntronsProp : showIntronsLocal;
  const setShowIntrons = onShowIntronsChange || setShowIntronsLocal;

  // View mode: 'auto' resolves based on density, or user can force a specific mode
  const [viewMode, setViewMode] = useState<'auto' | 'histogram' | 'lollipop' | 'scatter'>('auto');
  const [hoveredBin, setHoveredBin] = useState<BinData | null>(null);

  // Determine the effective view region (zoom region or full gene)
  const viewRegion = useMemo(() => {
    if (region) {
      return region;
    }
    return { start: gene.start, stop: gene.stop };
  }, [region, gene.start, gene.stop]);

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

  // Filter displayed exons by active feature types
  const displayedExons = useMemo(() => {
    if (!exons) return undefined;
    if (showIntrons) return exons; // show everything in full gene mode
    return exons.filter(e =>
      e.feature_type === 'CDS' ||
      (e.feature_type === 'UTR' && includeUTRs) ||
      (e.feature_type === 'exon' && includeNonCodingTranscripts)
    );
  }, [exons, showIntrons, includeUTRs, includeNonCodingTranscripts]);

  // Create full genomic scale (linear, showing introns)
  const fullScale = useMemo(() => {
    return linearGenomicScale(viewRegion.start, viewRegion.stop, [0, containerWidth]);
  }, [viewRegion.start, viewRegion.stop, containerWidth]);

  // Create collapsed scale (only displayed exon regions, hiding introns)
  const collapsedScale = useMemo(() => {
    if (!displayedExons || displayedExons.length === 0) {
      return fullScale;
    }
    // Filter exons to those within the view region
    const visibleExons = displayedExons.filter(
      e => e.stop >= viewRegion.start && e.start <= viewRegion.stop
    );
    if (visibleExons.length === 0) {
      return fullScale;
    }
    // Clip exons to view region boundaries
    const clippedExons: Region[] = visibleExons.map(e => ({
      start: Math.max(e.start, viewRegion.start),
      stop: Math.min(e.stop, viewRegion.stop),
    }));
    const mergedExons = mergeOverlappingRegions(clippedExons);
    return regionViewerScale(mergedExons, [0, containerWidth]);
  }, [displayedExons, viewRegion.start, viewRegion.stop, containerWidth, fullScale]);

  // Use appropriate scale based on toggle
  const scale = showIntrons ? fullScale : collapsedScale;

  // Count variants in exon regions
  const exonVariantCount = useMemo(() => {
    if (!exons || exons.length === 0 || showIntrons) {
      return variants.length;
    }
    return variants.filter(v => isInExonRegion(getVariantPosition(v), exons)).length;
  }, [variants, exons, showIntrons]);

  // Compute effective view mode (auto-switch at 0.75 variants/pixel)
  // Force histogram while streaming to avoid janky lollipop→histogram transition
  const effectiveViewMode = useMemo(() => {
    if (isStreaming) return 'histogram';
    if (viewMode !== 'auto') return viewMode;
    const density = exonVariantCount / containerWidth;
    return density > 0.75 ? 'histogram' : 'lollipop';
  }, [viewMode, exonVariantCount, containerWidth, isStreaming]);

  // Handle variant hover
  const handleVariantHover = useCallback((variant: Variant | null) => {
    setHoveredVariant(variant);
    onHoverVariant?.(variant);
  }, [onHoverVariant]);

  // Drag-to-zoom handlers
  const trackContainerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!onRegionChange || !trackContainerRef.current) return;

    const rect = trackContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - 80; // Subtract label width

    setIsDragging(true);
    setDragStart(x);
    setDragEnd(x);
  }, [onRegionChange]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || !trackContainerRef.current) return;

    const rect = trackContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - 80; // Subtract label width
    setDragEnd(x);
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    if (!isDragging || dragStart === null || dragEnd === null || !onRegionChange) {
      setIsDragging(false);
      setDragStart(null);
      setDragEnd(null);
      return;
    }

    // Convert pixel positions to genomic coordinates
    const startX = Math.min(dragStart, dragEnd);
    const endX = Math.max(dragStart, dragEnd);

    // Only trigger zoom if selection is at least 5 pixels wide
    if (endX - startX >= 5) {
      const genomicStart = Math.round(scale.invert(startX));
      const genomicEnd = Math.round(scale.invert(endX));

      // Ensure we have valid coordinates
      if (genomicStart < genomicEnd) {
        onRegionChange({ start: genomicStart, stop: genomicEnd });
      }
    }

    setIsDragging(false);
    setDragStart(null);
    setDragEnd(null);
  }, [isDragging, dragStart, dragEnd, scale, onRegionChange]);

  const handleMouseLeave = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      setDragStart(null);
      setDragEnd(null);
    }
  }, [isDragging]);

  // Calculate selection overlay position
  const selectionLeft = dragStart !== null && dragEnd !== null
    ? Math.min(dragStart, dragEnd)
    : 0;
  const selectionWidth = dragStart !== null && dragEnd !== null
    ? Math.abs(dragEnd - dragStart)
    : 0;

  return (
    <BrowserContainer ref={containerRef}>
      <BrowserHeader>
        <HeaderLeft>
          <BrowserTitle>
            Variant Distribution
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
            ) : hoveredBin ? (
              <>
                <strong>{hoveredBin.total} variants</strong>
                {' | '}
                pLoF: {hoveredBin.categories.lof}
                {', Missense: '}{hoveredBin.categories.missense}
                {', Synonymous: '}{hoveredBin.categories.synonymous}
                {', Other: '}{hoveredBin.categories.other}
              </>
            ) : (
              <span style={{ color: '#999' }}>Hover over a variant for details</span>
            )}
          </HoverInfo>
        </HeaderLeft>
        <HeaderRight>
          <select
            value={viewMode}
            onChange={(e) => setViewMode(e.target.value as typeof viewMode)}
            style={{
              padding: '0.375rem 0.5rem',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: '#fff',
              color: '#666',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            <option value="auto">Auto ({effectiveViewMode})</option>
            <option value="histogram">Histogram</option>
            <option value="lollipop">Lollipop</option>
            <option value="scatter">Scatter</option>
          </select>
          {regionUrl && (
            <LinkButton to={regionUrl}>
              View region
            </LinkButton>
          )}
          {exons && exons.some(e => e.feature_type === 'UTR') && (
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeUTRs}
                onChange={e => onIncludeUTRsChange?.(e.target.checked)}
              />
              UTRs
            </label>
          )}
          {exons && exons.some(e => e.feature_type === 'exon') && (
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeNonCodingTranscripts}
                onChange={e => onIncludeNonCodingTranscriptsChange?.(e.target.checked)}
              />
              Non-coding
            </label>
          )}
          {exons && exons.length > 0 && (
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showIntrons}
                onChange={e => setShowIntrons(e.target.checked)}
              />
              Introns
            </label>
          )}
        </HeaderRight>
      </BrowserHeader>

      <TrackContainer
        ref={trackContainerRef}
        onMouseDown={onRegionChange ? handleMouseDown : undefined}
        onMouseMove={onRegionChange ? handleMouseMove : undefined}
        onMouseUp={onRegionChange ? handleMouseUp : undefined}
        onMouseLeave={onRegionChange ? handleMouseLeave : undefined}
        style={{ position: 'relative', cursor: onRegionChange ? 'crosshair' : 'default' }}
      >
        {/* Selection overlay during drag */}
        {isDragging && selectionWidth > 0 && (
          <SelectionOverlay
            style={{
              left: `${80 + selectionLeft}px`, // Add label width offset
              width: `${selectionWidth}px`,
            }}
          />
        )}

        {/* Combined density track + Gene Track (lollipop or histogram mode) */}
        {effectiveViewMode !== 'scatter' && (
          <TrackRow>
            <TrackLabel>Variants</TrackLabel>
            <TrackContent>
              <div style={{ position: 'relative' }}>
                {effectiveViewMode === 'histogram' ? (
                  <VariantHistogramTrack
                    variants={variants}
                    scale={scale}
                    width={containerWidth}
                    exons={exons}
                    showIntrons={showIntrons}
                    onHoverBin={setHoveredBin}
                  />
                ) : (
                  <ProteinPaintTrack
                    variants={variants}
                    scale={scale}
                    width={containerWidth}
                    height={300}
                    exons={exons}
                    showIntrons={showIntrons}
                    onHover={handleVariantHover}
                    selectedIds={selectedVariantIds}
                    onVariantClick={onToggleVariantSelection}
                  />
                )}
                {/* Gene track at bottom */}
                <div style={{ marginTop: -10 }}>
                  <GeneTrack
                    gene={gene}
                    exons={displayedExons}
                    scale={scale}
                    width={containerWidth}
                    showIntrons={showIntrons}
                  />
                  <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 500, color: '#333', marginTop: -7 }}>
                    {gene.gene_symbol || gene.gencode_symbol || gene.gene_id}
                  </div>
                </div>
              </div>
            </TrackContent>
          </TrackRow>
        )}

        {/* Separate Gene Track (scatter mode only) */}
        {effectiveViewMode === 'scatter' && (
          <TrackRow>
            <TrackLabel>Gene</TrackLabel>
            <TrackContent>
              <GeneTrack
                gene={gene}
                exons={displayedExons}
                scale={scale}
                width={containerWidth}
                showIntrons={showIntrons}
              />
            </TrackContent>
          </TrackRow>
        )}

        {/* Variant Track (scatter mode only) */}
        {effectiveViewMode === 'scatter' && (
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
        )}

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
