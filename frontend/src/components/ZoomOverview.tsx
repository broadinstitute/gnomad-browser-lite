import { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import styled from 'styled-components';
import type { Gene, Exon } from '../api/types';
import { mergeOverlappingRegions, linearGenomicScale, regionViewerScale, type ScalePosition } from '../utils/coordinates';

const OverviewContainer = styled.div`
  position: relative;
  padding: 0.75rem 1rem;
  margin-bottom: 0.5rem;
  background: #f8f9fa;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
`;

const OverviewHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.5rem;
  font-size: 14px;
`;

const ZoomInfo = styled.span`
  color: #333;
  flex: 1;
`;

const ZoomButton = styled.button`
  padding: 0.375rem 0.75rem;
  border: 1px solid #1976d2;
  border-radius: 4px;
  background: #1976d2;
  color: white;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    background: #1565c0;
    border-color: #1565c0;
  }
`;

const TrackWrapper = styled.div`
  position: relative;
  height: 50px;
  user-select: none;
`;

const SelectionOverlay = styled.div<{ $isDragging: boolean }>`
  position: absolute;
  top: 0;
  height: 100%;
  background: rgba(66, 133, 244, 0.15);
  border: 2px solid rgba(66, 133, 244, 0.8);
  border-radius: 2px;
  cursor: ${props => props.$isDragging ? 'grabbing' : 'grab'};
  box-sizing: border-box;
`;

const ResizeHandle = styled.div<{ $position: 'left' | 'right' }>`
  position: absolute;
  top: 0;
  ${props => props.$position}: -6px;
  width: 12px;
  height: 100%;
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;

  &::after {
    content: '';
    width: 4px;
    height: 24px;
    background: rgba(66, 133, 244, 0.8);
    border-radius: 2px;
  }

  &:hover::after {
    background: rgba(66, 133, 244, 1);
  }
`;

interface ZoomOverviewProps {
  gene: Gene;
  exons?: Exon[];
  zoomRegion: { start: number; stop: number };
  onRegionChange: (region: { start: number; stop: number }) => void;
  onReset: () => void;
}

export function ZoomOverview({
  gene,
  exons,
  zoomRegion,
  onRegionChange,
  onReset,
}: ZoomOverviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [dragState, setDragState] = useState<{
    type: 'move' | 'resize-left' | 'resize-right';
    startX: number;
    startRegion: { start: number; stop: number };
  } | null>(null);

  // Measure container width
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Get CDS exons for display (only coding regions, not UTRs)
  const cdsExons = useMemo(() => {
    if (!exons || exons.length === 0) return [];
    // Filter to only CDS (coding) regions and sort by position
    const filtered = exons
      .filter(e => e.feature_type === 'CDS')
      .map(e => ({ start: e.start, stop: e.stop }))
      .sort((a, b) => a.start - b.start);
    if (filtered.length === 0) return [];
    // Merge truly overlapping regions but keep separate exons distinct
    return mergeOverlappingRegions(filtered);
  }, [exons]);

  // Use collapsed scale for the overview - shows only exonic regions
  const scale = useMemo((): ScalePosition => {
    if (cdsExons.length === 0) {
      // Fallback to linear scale if no exons
      return linearGenomicScale(gene.start, gene.stop, [0, containerWidth], 0.01);
    }
    // Use regionViewerScale to show collapsed exons (no introns)
    return regionViewerScale(cdsExons, [0, containerWidth], 3);
  }, [cdsExons, gene.start, gene.stop, containerWidth]);

  // For dragging, we need a linear scale to convert pixel deltas to genomic deltas
  const linearScale = useMemo((): ScalePosition => {
    return linearGenomicScale(gene.start, gene.stop, [0, containerWidth], 0);
  }, [gene.start, gene.stop, containerWidth]);

  // Calculate selection position on the collapsed scale
  // Find the exons that overlap with the zoom region and highlight that span
  const selectionBounds = useMemo(() => {
    if (cdsExons.length === 0) {
      // No exons - use direct scale mapping
      const left = scale(zoomRegion.start);
      const right = scale(zoomRegion.stop);
      return { left, width: Math.max(right - left, 10) };
    }

    // Find exons that overlap with the zoom region
    const overlappingExons = cdsExons.filter(
      exon => exon.stop >= zoomRegion.start && exon.start <= zoomRegion.stop
    );

    if (overlappingExons.length === 0) {
      // Zoom region is entirely in introns - find nearest exon position
      const midpoint = (zoomRegion.start + zoomRegion.stop) / 2;
      const pos = scale(midpoint);
      return { left: pos - 5, width: 10 };
    }

    // Get the pixel bounds for the overlapping exon range
    // Clip the bounds to the actual zoom region
    const firstExon = overlappingExons[0];
    const lastExon = overlappingExons[overlappingExons.length - 1];

    const clippedStart = Math.max(firstExon.start, zoomRegion.start);
    const clippedStop = Math.min(lastExon.stop, zoomRegion.stop);

    const left = scale(clippedStart);
    const right = scale(clippedStop);

    return { left, width: Math.max(right - left, 10) };
  }, [cdsExons, zoomRegion, scale]);

  const selectionLeft = selectionBounds.left;
  const selectionWidth = selectionBounds.width;

  // Drag handlers
  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    type: 'move' | 'resize-left' | 'resize-right'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDragState({
      type,
      startX: e.clientX,
      startRegion: { ...zoomRegion },
    });
  }, [zoomRegion]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragState) return;

    const deltaX = e.clientX - dragState.startX;
    // Use linear scale for converting pixel deltas to genomic deltas
    // This ensures dragging moves smoothly through genomic space
    const deltaGenomic = linearScale.invert(deltaX) - linearScale.invert(0);

    let newStart = dragState.startRegion.start;
    let newStop = dragState.startRegion.stop;

    if (dragState.type === 'move') {
      // Move the whole selection
      newStart = dragState.startRegion.start + deltaGenomic;
      newStop = dragState.startRegion.stop + deltaGenomic;

      // Clamp to gene boundaries
      if (newStart < gene.start) {
        const offset = gene.start - newStart;
        newStart = gene.start;
        newStop = newStop + offset;
      }
      if (newStop > gene.stop) {
        const offset = newStop - gene.stop;
        newStop = gene.stop;
        newStart = newStart - offset;
      }
    } else if (dragState.type === 'resize-left') {
      newStart = Math.max(gene.start, Math.min(dragState.startRegion.start + deltaGenomic, newStop - 1000));
    } else if (dragState.type === 'resize-right') {
      newStop = Math.min(gene.stop, Math.max(dragState.startRegion.stop + deltaGenomic, newStart + 1000));
    }

    onRegionChange({
      start: Math.round(newStart),
      stop: Math.round(newStop),
    });
  }, [dragState, linearScale, gene.start, gene.stop, onRegionChange]);

  const handleMouseUp = useCallback(() => {
    setDragState(null);
  }, []);

  // Add/remove global mouse listeners for drag
  useEffect(() => {
    if (dragState) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragState, handleMouseMove, handleMouseUp]);

  // Click on track to center selection there
  const handleTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (dragState) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    // Use collapsed scale's invert - clicking on an exon centers on that genomic position
    const clickGenomic = scale.invert(clickX);

    const regionSize = zoomRegion.stop - zoomRegion.start;
    let newStart = clickGenomic - regionSize / 2;
    let newStop = clickGenomic + regionSize / 2;

    // Clamp to gene boundaries
    if (newStart < gene.start) {
      newStart = gene.start;
      newStop = gene.start + regionSize;
    }
    if (newStop > gene.stop) {
      newStop = gene.stop;
      newStart = gene.stop - regionSize;
    }

    onRegionChange({
      start: Math.round(newStart),
      stop: Math.round(newStop),
    });
  }, [dragState, scale, zoomRegion, gene.start, gene.stop, onRegionChange]);

  const regionSize = zoomRegion.stop - zoomRegion.start;
  const regionSizeStr = regionSize >= 1000
    ? `${(regionSize / 1000).toFixed(1)}kb`
    : `${regionSize}bp`;

  return (
    <OverviewContainer>
      <OverviewHeader>
        <ZoomInfo>
          Viewing: <strong>{gene.chrom}:{zoomRegion.start.toLocaleString()}-{zoomRegion.stop.toLocaleString()}</strong>
          {' '}({regionSizeStr})
        </ZoomInfo>
        <ZoomButton onClick={onReset}>
          Reset to full gene
        </ZoomButton>
      </OverviewHeader>

      <TrackWrapper ref={containerRef} onClick={handleTrackClick}>
        {/* Mini gene track SVG */}
        <svg
          width={containerWidth}
          height={50}
          style={{ position: 'absolute', top: 0, left: 0 }}
        >
          {/* CDS exon blocks (collapsed view - no introns) */}
          {cdsExons.map((exon, idx) => {
            const x = scale(exon.start);
            const width = Math.max(2, scale(exon.stop) - x);
            return (
              <rect
                key={idx}
                x={x}
                y={17}
                width={width}
                height={16}
                fill="#616161"
                rx={1}
              />
            );
          })}

          {/* If no exons, show a simple gene bar */}
          {cdsExons.length === 0 && (
            <rect
              x={scale(gene.start)}
              y={20}
              width={Math.max(2, scale(gene.stop) - scale(gene.start))}
              height={10}
              fill="#616161"
              rx={2}
            />
          )}
        </svg>

        {/* Selection overlay */}
        <SelectionOverlay
          $isDragging={dragState?.type === 'move'}
          style={{
            left: `${selectionLeft}px`,
            width: `${Math.max(selectionWidth, 10)}px`,
          }}
          onMouseDown={(e) => handleMouseDown(e, 'move')}
        >
          <ResizeHandle
            $position="left"
            onMouseDown={(e) => handleMouseDown(e, 'resize-left')}
          />
          <ResizeHandle
            $position="right"
            onMouseDown={(e) => handleMouseDown(e, 'resize-right')}
          />
        </SelectionOverlay>
      </TrackWrapper>
    </OverviewContainer>
  );
}

export default ZoomOverview;
