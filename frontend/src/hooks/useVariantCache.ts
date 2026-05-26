import { useCallback, useEffect, useRef, useState } from 'react';
import type { Variant } from '../api/types';
import type { Region } from '../utils/coordinates';
import { mergeIntervals, subtractIntervals } from '../utils/intervals';
import { streamRegionVariants, cacheDevBus } from '../api/client';

export interface VariantCache {
  variants: Variant[];
  isLoading: boolean;
  fetchedIntervals: Region[];
  ensureIntervalsCovered: (chrom: string, desired: Region[]) => void;
  reset: () => void;
}

// Module-level cache survives component unmount/remount (navigation)
// Keyed by gene/chrom to avoid stale data across different genes
let moduleChrom = '';
let moduleVariantsMap = new Map<string, Variant>();
let moduleFetchedIntervals: Region[] = [];
let moduleAbortController: AbortController | null = null;

export function useVariantCache(): VariantCache {
  const [variants, setVariants] = useState<Variant[]>(() =>
    Array.from(moduleVariantsMap.values())
  );
  const [isLoading, setIsLoading] = useState(false);
  const [fetchedIntervals, setFetchedIntervals] = useState<Region[]>(moduleFetchedIntervals);

  // Refs that point to module-level state for use in callbacks
  const variantsMapRef = useRef(moduleVariantsMap);
  const fetchedIntervalsRef = useRef(moduleFetchedIntervals);

  // Sync refs with module state on mount
  useEffect(() => {
    variantsMapRef.current = moduleVariantsMap;
    fetchedIntervalsRef.current = moduleFetchedIntervals;
    setVariants(Array.from(moduleVariantsMap.values()));
    setFetchedIntervals(moduleFetchedIntervals);

    // Emit initial state to devtool
    if (moduleVariantsMap.size > 0) {
      cacheDevBus.emit('cache-state', {
        intervalCount: moduleFetchedIntervals.length,
        variantCount: moduleVariantsMap.size,
      });
    }
  }, []);

  const reset = useCallback(() => {
    moduleAbortController?.abort();
    moduleAbortController = null;
    moduleVariantsMap = new Map();
    moduleFetchedIntervals = [];
    moduleChrom = '';
    variantsMapRef.current = moduleVariantsMap;
    fetchedIntervalsRef.current = moduleFetchedIntervals;
    setVariants([]);
    setFetchedIntervals([]);
    setIsLoading(false);
  }, []);

  const ensureIntervalsCovered = useCallback((chrom: string, desired: Region[]) => {
    if (desired.length === 0) return;

    // If chrom changed, reset
    if (chrom !== moduleChrom && moduleChrom !== '') {
      moduleVariantsMap = new Map();
      moduleFetchedIntervals = [];
      variantsMapRef.current = moduleVariantsMap;
      fetchedIntervalsRef.current = moduleFetchedIntervals;
    }
    moduleChrom = chrom;

    const gaps = subtractIntervals(desired, fetchedIntervalsRef.current);
    console.log('[VariantCache] ensureIntervalsCovered', { chrom, desired: desired.length, fetched: fetchedIntervalsRef.current.length, gaps: gaps.length, moduleVariants: moduleVariantsMap.size });
    if (gaps.length === 0) {
      cacheDevBus.emit('cache-log', {
        timestamp: Date.now(),
        url: `frontend-cache://${chrom}/${desired.map(r => `${r.start}-${r.stop}`).join(',')}`,
        layer: 'frontend',
        duration: 0,
      });
      return;
    }

    // Abort any in-flight request
    moduleAbortController?.abort();
    const controller = new AbortController();
    moduleAbortController = controller;

    setIsLoading(true);

    streamRegionVariants(
      chrom,
      gaps,
      {
        onMetadata: () => {
          // metadata received — streaming has begun
        },
        onVariants: (batch) => {
          for (const v of batch) {
            const key = v.variant_id || `${v.chrom}-${v.pos}-${(v.alleles || []).join('-')}`;
            variantsMapRef.current.set(key, v);
          }
          moduleVariantsMap = variantsMapRef.current;
          setVariants(Array.from(variantsMapRef.current.values()));
        },
        onComplete: () => {
          // Merge the newly fetched gaps into our tracked intervals
          const merged = mergeIntervals([
            ...fetchedIntervalsRef.current,
            ...gaps,
          ]);
          fetchedIntervalsRef.current = merged;
          moduleFetchedIntervals = merged;
          setFetchedIntervals(merged);
          setIsLoading(false);
          moduleAbortController = null;
          cacheDevBus.emit('cache-state', {
            intervalCount: merged.length,
            variantCount: variantsMapRef.current.size,
          });
        },
        onError: (err) => {
          if (controller.signal.aborted) return;
          console.error('Variant cache stream error:', err);
          // Still merge what we tried to fetch to avoid re-requesting on error
          const merged = mergeIntervals([
            ...fetchedIntervalsRef.current,
            ...gaps,
          ]);
          fetchedIntervalsRef.current = merged;
          moduleFetchedIntervals = merged;
          setFetchedIntervals(merged);
          setVariants(Array.from(variantsMapRef.current.values()));
          setIsLoading(false);
          moduleAbortController = null;
        },
      },
      controller.signal
    );
  }, []);

  return { variants, isLoading, fetchedIntervals, ensureIntervalsCovered, reset };
}
