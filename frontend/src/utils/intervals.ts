/**
 * Interval math utilities for the variant cache.
 * Operates on Region[] (from coordinates.ts) to compute gaps and merges.
 */
import type { Region } from './coordinates';

/**
 * Merge overlapping or adjacent intervals into non-overlapping sorted intervals.
 * Re-exports the same logic as coordinates.ts mergeOverlappingRegions but
 * named to match the cache API.
 */
export function mergeIntervals(intervals: Region[]): Region[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Region[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.stop + 1) {
      prev.stop = Math.max(prev.stop, cur.stop);
    } else {
      merged.push({ ...cur });
    }
  }

  return merged;
}

/**
 * Subtract a set of intervals from a set of target intervals.
 * Returns the portions of `targets` not covered by `subtract`.
 * Both inputs should be sorted & merged for best results, but this
 * function will merge them internally to be safe.
 */
export function subtractIntervals(targets: Region[], subtract: Region[]): Region[] {
  if (targets.length === 0) return [];
  if (subtract.length === 0) return mergeIntervals(targets);

  const mergedTargets = mergeIntervals(targets);
  const mergedSubtract = mergeIntervals(subtract);

  const result: Region[] = [];

  for (const target of mergedTargets) {
    let current = target.start;

    for (const sub of mergedSubtract) {
      if (sub.stop < current) continue;
      if (sub.start > target.stop) break;

      // There's a gap before this subtraction region
      if (sub.start > current) {
        result.push({ start: current, stop: sub.start - 1 });
      }
      current = Math.max(current, sub.stop + 1);
    }

    // Remaining portion after all subtractions
    if (current <= target.stop) {
      result.push({ start: current, stop: target.stop });
    }
  }

  return result;
}

/**
 * Total base-pair size of a set of intervals.
 */
export function getTotalSize(intervals: Region[]): number {
  return intervals.reduce((sum, r) => sum + (r.stop - r.start + 1), 0);
}
