/**
 * Coordinate utilities for genomic region scaling.
 * Ported from @gnomad/region-viewer with TypeScript improvements.
 */

export interface Region {
  start: number;
  stop: number;
}

export type ScalePosition = {
  (position: number): number;
  invert: (x: number) => number;
};

/**
 * Merge overlapping or adjacent regions into a single set of non-overlapping regions.
 * Regions must be sorted by start position before calling this function.
 */
export function mergeOverlappingRegions(regions: Region[]): Region[] {
  if (regions.length === 0) {
    return [];
  }

  const sortedRegions = [...regions].sort((a, b) => a.start - b.start);
  const mergedRegions: Region[] = [{ ...sortedRegions[0] }];

  let previousRegion = mergedRegions[0];

  for (let i = 1; i < sortedRegions.length; i += 1) {
    const nextRegion = sortedRegions[i];

    if (nextRegion.start <= previousRegion.stop + 1) {
      // Regions overlap or are adjacent - merge them
      if (nextRegion.stop > previousRegion.stop) {
        previousRegion.stop = nextRegion.stop;
      }
    } else {
      // No overlap - add as new region
      previousRegion = { ...nextRegion };
      mergedRegions.push(previousRegion);
    }
  }

  return mergedRegions;
}

/**
 * Create a scale function that maps genomic positions to pixel coordinates.
 * Supports both forward (position -> pixel) and inverse (pixel -> position) mapping.
 *
 * The scale distributes pixel width proportionally across regions based on their
 * base pair size, with visual gaps between regions.
 *
 * @param domainRegions - Array of genomic regions (should be merged/non-overlapping)
 * @param range - Pixel range [start, end] for the output
 * @param gapWidth - Pixel width of gaps between regions (default 4)
 * @returns Scale function with .invert() method
 */
export function regionViewerScale(
  domainRegions: Region[],
  range: [number, number],
  gapWidth: number = 4
): ScalePosition {
  if (domainRegions.length === 0) {
    // Return identity scale for empty regions
    const emptyScale = ((_position: number) => range[0]) as ScalePosition;
    emptyScale.invert = () => 0;
    return emptyScale;
  }

  const totalRegionSize = domainRegions.reduce(
    (acc, region) => acc + (region.stop - region.start + 1),
    0
  );

  // Calculate total gap space and available width for regions
  const numGaps = domainRegions.length - 1;
  const totalGapWidth = numGaps * gapWidth;
  const availableWidth = (range[1] - range[0]) - totalGapWidth;

  // Pre-calculate region boundaries in pixel space
  const regionBoundaries: { start: number; stop: number; pixelStart: number; pixelEnd: number }[] = [];
  let currentPixel = range[0];

  for (let i = 0; i < domainRegions.length; i++) {
    const region = domainRegions[i];
    const regionSize = region.stop - region.start + 1;
    const regionWidth = (regionSize / totalRegionSize) * availableWidth;

    regionBoundaries.push({
      start: region.start,
      stop: region.stop,
      pixelStart: currentPixel,
      pixelEnd: currentPixel + regionWidth,
    });

    currentPixel += regionWidth + gapWidth;
  }

  const scale = ((position: number): number => {
    // Find which region contains this position
    for (const boundary of regionBoundaries) {
      if (position >= boundary.start && position <= boundary.stop) {
        const relativePos = (position - boundary.start) / (boundary.stop - boundary.start + 1);
        return boundary.pixelStart + relativePos * (boundary.pixelEnd - boundary.pixelStart);
      }
    }

    // Position is in a gap - find nearest region edge
    for (let i = 0; i < regionBoundaries.length; i++) {
      const boundary = regionBoundaries[i];
      if (position < boundary.start) {
        return boundary.pixelStart;
      }
      if (i < regionBoundaries.length - 1 && position > boundary.stop) {
        const nextBoundary = regionBoundaries[i + 1];
        if (position < nextBoundary.start) {
          // In the gap - return end of current region
          return boundary.pixelEnd;
        }
      }
    }

    return regionBoundaries[regionBoundaries.length - 1].pixelEnd;
  }) as ScalePosition;

  scale.invert = (x: number): number => {
    const clampedX = Math.max(Math.min(x, range[1]), range[0]);

    // Find which region or gap contains this pixel
    for (let i = 0; i < regionBoundaries.length; i++) {
      const boundary = regionBoundaries[i];

      if (clampedX >= boundary.pixelStart && clampedX <= boundary.pixelEnd) {
        // Inside a region
        const relativePixel = (clampedX - boundary.pixelStart) / (boundary.pixelEnd - boundary.pixelStart);
        return Math.round(boundary.start + relativePixel * (boundary.stop - boundary.start));
      }

      // Check if in gap after this region
      if (i < regionBoundaries.length - 1) {
        const nextBoundary = regionBoundaries[i + 1];
        if (clampedX > boundary.pixelEnd && clampedX < nextBoundary.pixelStart) {
          // In the gap - return end of current region
          return boundary.stop;
        }
      }
    }

    return domainRegions[domainRegions.length - 1].stop;
  };

  return scale;
}

/**
 * Create a linear scale for full genomic range (showing introns).
 * This is a simpler scale that maps linearly from genomic to pixel coordinates.
 *
 * @param start - Start genomic position
 * @param stop - Stop genomic position
 * @param range - Pixel range [start, end]
 * @param padding - Fractional padding to add on each side (default 0.02 = 2%)
 */
export function linearGenomicScale(
  start: number,
  stop: number,
  range: [number, number],
  padding: number = 0.02
): ScalePosition {
  const genomeRange = stop - start;
  const paddedStart = start - genomeRange * padding;
  const paddedStop = stop + genomeRange * padding;
  const paddedRange = paddedStop - paddedStart;

  const pixelRange = range[1] - range[0];

  const scale = ((position: number): number => {
    return range[0] + ((position - paddedStart) / paddedRange) * pixelRange;
  }) as ScalePosition;

  scale.invert = (x: number): number => {
    const clampedX = Math.max(Math.min(x, range[1]), range[0]);
    return paddedStart + ((clampedX - range[0]) / pixelRange) * paddedRange;
  };

  return scale;
}
