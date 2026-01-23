// Types for gnomAD Browser Lite

export interface Gene {
  gene_id: string;
  gene_symbol?: string;
  gencode_symbol?: string;
  chrom: string;
  start: number;
  stop: number;
  strand?: string;
  canonical_transcript_id?: string;
}

// Helper to get gene symbol (handles both field names)
export function getGeneSymbol(gene: Gene): string {
  return gene.gene_symbol || gene.gencode_symbol || gene.gene_id;
}

export interface Locus {
  contig: string;
  position: number;
}

export interface Variant {
  variant_id?: string;
  locus: Locus;
  alleles: string[];
  rsid?: string;
  consequence?: string;
  hgvsc?: string;
  hgvsp?: string;
  gene_id?: string;
  gene_symbol?: string;
  transcript_id?: string;
  // Frequency data
  freq?: {
    AC?: number;
    AN?: number;
    AF?: number;
    homozygote_count?: number;
  };
  // Simplified frequency fields (flattened)
  ac?: number;
  an?: number;
  af?: number;
  // Raw data from API
  [key: string]: unknown;
}

export interface GeneResponse extends Gene {
  transcripts?: unknown[];
}

export interface GeneVariantsResponse {
  gene: Gene;
  variants: Variant[];
  total: number;
}

export interface RegionVariantsResponse {
  region: {
    chrom: string;
    start: number;
    end: number;
  };
  variants: Variant[];
  total: number;
}

export interface SearchResult {
  gene_id: string;
  gene_symbol: string;
  chrom?: string;
  start?: number;
  stop?: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total: number;
}
