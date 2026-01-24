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
 * base pair size, with visual gaps between regions handled automatically.
 *
 * @param domainRegions - Array of genomic regions (should be merged/non-overlapping)
 * @param range - Pixel range [start, end] for the output
 * @returns Scale function with .invert() method
 */
export function regionViewerScale(
  domainRegions: Region[],
  range: [number, number]
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

  const scale = ((position: number): number => {
    // Calculate how far into the regions this position falls
    const distanceToPosition = domainRegions
      .filter(region => region.start <= position)
      .reduce(
        (acc, region) =>
          region.start <= position && position <= region.stop
            ? acc + position - region.start
            : acc + (region.stop - region.start + 1),
        0
      );

    return range[0] + (range[1] - range[0]) * (distanceToPosition / totalRegionSize);
  }) as ScalePosition;

  scale.invert = (x: number): number => {
    const clampedX = Math.max(Math.min(x, range[1]), range[0]);
    let distanceToPosition = Math.floor(
      totalRegionSize * ((clampedX - range[0]) / (range[1] - range[0]))
    );

    for (let i = 0; i < domainRegions.length; i += 1) {
      const region = domainRegions[i];
      const regionSize = region.stop - region.start + 1;
      if (distanceToPosition < regionSize) {
        return region.start + distanceToPosition;
      }
      distanceToPosition -= regionSize;
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
