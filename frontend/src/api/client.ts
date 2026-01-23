// API client for gnomAD Browser Lite backend

import type {
  GeneResponse,
  GeneVariantsResponse,
  RegionVariantsResponse,
  SearchResponse,
  Exon,
  VariantDetails,
} from './types';

const GNOMAD_API_URL = 'https://gnomad.broadinstitute.org/api';

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

export default api;
