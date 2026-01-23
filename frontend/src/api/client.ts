// API client for gnomAD Browser Lite backend

import type {
  GeneResponse,
  GeneVariantsResponse,
  RegionVariantsResponse,
  SearchResponse,
} from './types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
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
};

export default api;
