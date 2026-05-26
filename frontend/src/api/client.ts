// API client for gnomAD Browser Lite backend

import type {
  Gene,
  Variant,
  GeneResponse,
  GeneVariantsResponse,
  RegionVariantsResponse,
  SearchResponse,
  Exon,
  VariantDetails,
} from './types';

const GNOMAD_API_URL = 'https://gnomad.broadinstitute.org/api';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ==================== Cache Dev Event Bus ====================

export type CacheLayer = 'frontend' | 'moka' | 'miss' | 'prefetch';

export interface CacheLogEntry {
  timestamp: number;
  url: string;
  layer: CacheLayer;
  duration: number;
}

export interface CacheStateUpdate {
  intervalCount: number;
  variantCount: number;
}

type CacheEventMap = {
  'cache-log': CacheLogEntry;
  'cache-state': CacheStateUpdate;
};

type CacheEventHandler<K extends keyof CacheEventMap> = (data: CacheEventMap[K]) => void;

class CacheDevBus {
  private listeners: { [K in keyof CacheEventMap]?: Set<CacheEventHandler<K>> } = {};

  on<K extends keyof CacheEventMap>(event: K, handler: CacheEventHandler<K>) {
    if (!this.listeners[event]) {
      (this.listeners[event] as Set<CacheEventHandler<K>>) = new Set();
    }
    (this.listeners[event] as Set<CacheEventHandler<K>>).add(handler);
    return () => (this.listeners[event] as Set<CacheEventHandler<K>>).delete(handler);
  }

  emit<K extends keyof CacheEventMap>(event: K, data: CacheEventMap[K]) {
    const handlers = this.listeners[event] as Set<CacheEventHandler<K>> | undefined;
    if (handlers) {
      for (const handler of handlers) handler(data);
    }
  }
}

export const cacheDevBus = new CacheDevBus();

// ==================== Fetch helpers ====================

async function fetchJson<T>(url: string): Promise<T> {
  const start = performance.now();
  const response = await fetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  const xcache = response.headers.get('x-cache');
  const layer: CacheLayer = xcache === 'moka-hit' ? 'moka' : 'miss';
  const result = await response.json();
  cacheDevBus.emit('cache-log', {
    timestamp: Date.now(),
    url,
    layer,
    duration: performance.now() - start,
  });
  return result;
}

export const api = {
  /**
   * Get gene by ID or symbol
   */
  async getGene(geneIdOrSymbol: string): Promise<GeneResponse> {
    return fetchJson<GeneResponse>(`${API_BASE}/api/gene/${encodeURIComponent(geneIdOrSymbol)}`);
  },

  /**
   * Get variants for a gene
   */
  async getGeneVariants(geneIdOrSymbol: string): Promise<GeneVariantsResponse> {
    return fetchJson<GeneVariantsResponse>(
      `${API_BASE}/api/gene/${encodeURIComponent(geneIdOrSymbol)}/variants`
    );
  },

  /**
   * Get variants in a genomic region
   * @param region - Format: chr1-55039000-55065000 or chr1:55039000-55065000
   */
  async getRegionVariants(region: string): Promise<RegionVariantsResponse> {
    return fetchJson<RegionVariantsResponse>(
      `${API_BASE}/api/region/${encodeURIComponent(region)}`
    );
  },

  /**
   * Get detailed variant data by variant ID
   * @param variantId - Format: chr17-43044003-C-T
   */
  async getVariant(variantId: string): Promise<VariantDetails> {
    return fetchJson<VariantDetails>(
      `${API_BASE}/api/variant/${encodeURIComponent(variantId)}`
    );
  },

  /**
   * Search genes by symbol prefix
   */
  async searchGenes(query: string, limit = 10): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return fetchJson<SearchResponse>(`${API_BASE}/api/search?${params}`);
  },

  /**
   * Health check
   */
  async health(): Promise<{ status: string; service: string }> {
    return fetchJson<{ status: string; service: string }>(`${API_BASE}/api/health`);
  },

  /**
   * Fetch exon data from gnomAD public API for a gene's canonical transcript
   * This supplements our local data with transcript/exon information
   */
  async fetchExonsFromGnomAD(
    geneSymbolOrId: string,
    canonicalTranscriptId?: string
  ): Promise<Exon[]> {
    const query = `
      query GeneExons($geneSymbol: String, $geneId: String) {
        gene(gene_symbol: $geneSymbol, gene_id: $geneId, reference_genome: GRCh38) {
          gene_id
          symbol
          canonical_transcript_id
          transcripts {
            transcript_id
            exons {
              feature_type
              start
              stop
            }
          }
        }
      }
    `;

    // Determine if input is gene ID (starts with ENSG) or symbol
    const isGeneId = geneSymbolOrId.startsWith('ENSG');
    const variables = isGeneId
      ? { geneId: geneSymbolOrId, geneSymbol: null }
      : { geneSymbol: geneSymbolOrId, geneId: null };

    try {
      const response = await fetch(GNOMAD_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        console.warn('Failed to fetch exons from gnomAD:', response.status);
        return [];
      }

      const data = await response.json();
      const gene = data?.data?.gene;

      if (!gene || !gene.transcripts) {
        return [];
      }

      // Find the canonical transcript or use the provided transcript ID
      const targetTranscriptId = canonicalTranscriptId || gene.canonical_transcript_id;
      const transcript = gene.transcripts.find(
        (t: { transcript_id: string }) => t.transcript_id === targetTranscriptId
      );

      if (!transcript || !transcript.exons) {
        // Fallback to first transcript if canonical not found
        return gene.transcripts[0]?.exons || [];
      }

      return transcript.exons as Exon[];
    } catch (error) {
      console.warn('Error fetching exons from gnomAD:', error);
      return [];
    }
  },
};

export interface StreamSource {
  type: string;
  path: string;
  total_partitions: number;
}

export interface StreamCallbacks {
  onMetadata: (gene: Gene, total?: number, source?: StreamSource) => void;
  onVariants: (batch: Variant[]) => void;
  onComplete: () => void;
  onError: (err: Error) => void;
}

/**
 * Stream gene variants via NDJSON endpoint.
 * First line is {"gene": ...}, subsequent lines are {"variant": ...}.
 * Batches variants and delivers them via onVariants callback.
 */
export interface StreamOptions {
  mode?: 'exons' | 'full';
  /** Which exon feature types to include (default: CDS only). Ignored when mode=full. */
  includeFeatureTypes?: string[];
}

export async function streamGeneVariants(
  geneId: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  options?: StreamOptions
): Promise<void> {
  const params = new URLSearchParams();
  if (options?.mode === 'full') {
    params.set('mode', 'full');
  } else if (options?.includeFeatureTypes && options.includeFeatureTypes.length > 0) {
    params.set('include', options.includeFeatureTypes.join(','));
  }
  const qs = params.toString();
  const url = `${API_BASE}/api/gene/${encodeURIComponent(geneId)}/variants/stream${qs ? '?' + qs : ''}`;

  const start = performance.now();
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted) return;
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    callbacks.onError(new Error(error.error || `HTTP ${response.status}`));
    return;
  }

  const xcache = response.headers.get('x-cache');
  cacheDevBus.emit('cache-log', {
    timestamp: Date.now(),
    url,
    layer: xcache === 'moka-hit' ? 'moka' : 'miss',
    duration: performance.now() - start,
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let metadataReceived = false;
  let batch: Variant[] = [];

  const flushBatch = () => {
    if (batch.length > 0) {
      callbacks.onVariants(batch);
      batch = [];
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        buffer += decoder.decode(value, { stream: true });

        // Extract complete lines
        const lines = buffer.split('\n');
        // Keep incomplete last element in buffer
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const obj = JSON.parse(trimmed);
            if (!metadataReceived && obj.gene) {
              metadataReceived = true;
              callbacks.onMetadata(obj.gene, obj.total ?? undefined, obj.source ?? undefined);
            } else if (obj.summary) {
              if (obj.summary.prefetch_eligible) {
                cacheDevBus.emit('cache-log', {
                  timestamp: Date.now(),
                  url,
                  layer: 'prefetch',
                  duration: 0,
                });
              }
            } else if (obj.variant) {
              batch.push(obj.variant);
              // Flush every 200 variants to avoid holding too many in batch
              if (batch.length >= 200) {
                flushBatch();
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      if (done) {
        flushBatch();
        callbacks.onComplete();
        return;
      }
    }
  } catch (err) {
    if (signal?.aborted) return;
    flushBatch();
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export interface RegionStreamCallbacks {
  onMetadata: (meta: { chrom: string; intervals: number; bounding_start: number; bounding_end: number }) => void;
  onVariants: (batch: Variant[]) => void;
  onComplete: () => void;
  onError: (err: Error) => void;
}

/**
 * Stream variants for explicit genomic intervals via NDJSON.
 * First line is metadata, subsequent lines are {"variant": ...}.
 */
export async function streamRegionVariants(
  chrom: string,
  intervals: { start: number; stop: number }[],
  callbacks: RegionStreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const intervalStr = intervals.map(r => `${r.start}-${r.stop}`).join(',');
  const params = new URLSearchParams({ chrom, intervals: intervalStr });
  const url = `${API_BASE}/api/variants/stream?${params}`;

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted) return;
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    callbacks.onError(new Error(error.error || `HTTP ${response.status}`));
    return;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let metadataReceived = false;
  let batch: Variant[] = [];

  const flushBatch = () => {
    if (batch.length > 0) {
      callbacks.onVariants(batch);
      batch = [];
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const obj = JSON.parse(trimmed);
            if (!metadataReceived && obj.chrom) {
              metadataReceived = true;
              callbacks.onMetadata(obj);
            } else if (obj.variant) {
              batch.push(obj.variant);
              if (batch.length >= 200) {
                flushBatch();
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      if (done) {
        flushBatch();
        callbacks.onComplete();
        return;
      }
    }
  } catch (err) {
    if (signal?.aborted) return;
    flushBatch();
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export default api;
