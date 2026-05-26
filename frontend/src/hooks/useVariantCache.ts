import { useCallback, useRef, useState } from 'react';
import type { Variant } from '../api/types';
import type { Region } from '../utils/coordinates';
import { mergeIntervals, subtractIntervals } from '../utils/intervals';
import { streamRegionVariants } from '../api/client';

export interface VariantCache {
  variants: Variant[];
  isLoading: boolean;
  fetchedIntervals: Region[];
  ensureIntervalsCovered: (chrom: string, desired: Region[]) => void;
  reset: () => void;
}

export function useVariantCache(): VariantCache {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fetchedIntervals, setFetchedIntervals] = useState<Region[]>([]);

  const variantsMapRef = useRef<Map<string, Variant>>(new Map());
  const fetchedIntervalsRef = useRef<Region[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    variantsMapRef.current = new Map();
    fetchedIntervalsRef.current = [];
    setVariants([]);
    setFetchedIntervals([]);
    setIsLoading(false);
  }, []);

  const ensureIntervalsCovered = useCallback((chrom: string, desired: Region[]) => {
    if (desired.length === 0) return;

    const gaps = subtractIntervals(desired, fetchedIntervalsRef.current);
    if (gaps.length === 0) return;

    // Abort any in-flight request
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

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
          setVariants(Array.from(variantsMapRef.current.values()));
        },
        onComplete: () => {
          // Merge the newly fetched gaps into our tracked intervals
          fetchedIntervalsRef.current = mergeIntervals([
            ...fetchedIntervalsRef.current,
            ...gaps,
          ]);
          setFetchedIntervals(fetchedIntervalsRef.current);
          setIsLoading(false);
          abortControllerRef.current = null;
        },
        onError: (err) => {
          if (controller.signal.aborted) return;
          console.error('Variant cache stream error:', err);
          // Still merge what we tried to fetch to avoid re-requesting on error
          fetchedIntervalsRef.current = mergeIntervals([
            ...fetchedIntervalsRef.current,
            ...gaps,
          ]);
          setFetchedIntervals(fetchedIntervalsRef.current);
          setVariants(Array.from(variantsMapRef.current.values()));
          setIsLoading(false);
          abortControllerRef.current = null;
        },
      },
      controller.signal
    );
  }, []);

  return { variants, isLoading, fetchedIntervals, ensureIntervalsCovered, reset };
}
