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
  // Flattened locus fields from backend
  pos: number;
  chrom: string;
  // Legacy nested locus (may still exist)
  locus?: Locus;
  alleles: string[];
  // rsIDs from backend (array)
  rsids?: string[];
  // Legacy single rsid
  rsid?: string;
  consequence?: string;
  hgvsc?: string;
  hgvsp?: string;
  gene_id?: string;
  gene_symbol?: string;
  transcript_id?: string;
  // Frequency data (flattened from backend)
  ac: number;
  an: number;
  af: number;
  allele_freq: number;  // Alias for toolkit compatibility
  // Legacy nested frequency
  freq?: {
    AC?: number;
    AN?: number;
    AF?: number;
    homozygote_count?: number;
  };
  // For highlighting in track/table sync
  isHighlighted?: boolean;
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
