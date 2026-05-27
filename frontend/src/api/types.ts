// Types for gnomAD Browser Lite

// ==================== Branding / White-label Types ====================

export interface ExternalLink {
  label: string;
  url: string;
}

export interface BrandingConfig {
  name: string;
  short_name?: string;
  full_title?: string;
  navbar_color?: string;
  navbar_text_color?: string;
  accent_color?: string;
  logo_url?: string;
  favicon_url?: string;
  homepage_content?: string;
  about_content?: string;
  terms_content?: string;
  external_links?: ExternalLink[];
}

// ==================== Data Types ====================

export interface Exon {
  feature_type: 'CDS' | 'UTR' | 'exon';
  start: number;
  stop: number;
}

export interface Transcript {
  transcript_id: string;
  start?: number;
  stop?: number;
  exons: Exon[];
}

export interface GeneConstraint {
  exp_lof?: number;
  exp_mis?: number;
  exp_syn?: number;
  obs_lof?: number;
  obs_mis?: number;
  obs_syn?: number;
  oe_lof?: number;
  oe_lof_lower?: number;
  oe_lof_upper?: number;
  oe_mis?: number;
  oe_mis_lower?: number;
  oe_mis_upper?: number;
  oe_syn?: number;
  oe_syn_lower?: number;
  oe_syn_upper?: number;
  lof_z?: number;
  mis_z?: number;
  syn_z?: number;
  pli?: number;
  loeuf?: number;
  flags?: string[];
}

export interface Gene {
  gene_id: string;
  gene_symbol?: string;
  gencode_symbol?: string;
  chrom: string;
  start: number;
  stop: number;
  strand?: string;
  canonical_transcript_id?: string;
  transcripts?: Transcript[];
  // Convenience: canonical transcript exons (populated from gnomAD API)
  exons?: Exon[];
  constraint?: GeneConstraint;
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
  lof?: string;
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

// ==================== Variant Detail Types ====================

export interface Population {
  id: string;
  ac: number;
  an: number;
  homozygote_count: number;
  hemizygote_count: number;
}

export interface TranscriptConsequence {
  gene_id: string;
  gene_symbol: string;
  transcript_id: string;
  transcript_version?: string;
  consequence_terms: string[];
  major_consequence: string;
  hgvsc?: string;
  hgvsp?: string;
  is_canonical?: boolean;
  is_mane_select?: boolean;
  is_mane_select_version?: boolean;
  lof?: string;
  lof_filter?: string;
  lof_flags?: string;
  domains?: string[];
  refseq_id?: string;
  biotype?: string;
}

export interface InSilicoPredictors {
  cadd?: { phred: number; raw_score: number };
  revel_max?: number;
  spliceai_ds_max?: number;
  pangolin_largest_ds?: number;
  phylop?: number;
  sift_max?: number;
  polyphen_max?: number;
}

// ==================== Quality Metrics Types ====================

export interface SiteQualityMetric {
  metric: string;
  value: number | null;
}

export interface HistogramData {
  bin_edges: number[];
  bin_freq: number[];
  n_larger?: number;
  n_smaller?: number;
}

export interface HistogramSet {
  all?: HistogramData;
  alt?: HistogramData;
  all_adj?: HistogramData;
  all_raw?: HistogramData;
  alt_adj?: HistogramData;
  alt_raw?: HistogramData;
}

export interface VariantQualityMetrics {
  allele_balance?: HistogramSet;
  genotype_depth?: HistogramSet;
  genotype_quality?: HistogramSet;
  site_quality_metrics?: SiteQualityMetric[];
}

export interface SequencingTypeData {
  ac?: number;
  an?: number;
  homozygote_count?: number;
  hemizygote_count?: number;
  quality_metrics?: VariantQualityMetrics;
}

export interface VariantDetails extends Variant {
  caid?: string;

  // Joint frequencies structure from Parquet
  joint?: {
    freq?: {
      all?: {
        ac: number;
        an: number;
        homozygote_count: number;
        hemizygote_count: number;
        ancestry_groups?: Population[];
      };
    };
    grpmax?: {
      ac: number;
      an: number;
      af?: number;
      gen_anc: string;
    };
    fafmax?: {
      faf95_max: number;
      faf95_max_gen_anc: string;
    };
    flags?: string[];
  };

  transcript_consequences?: TranscriptConsequence[];
  in_silico_predictors?: InSilicoPredictors;

  coverage?: {
    genome?: {
      mean?: number;
      median_approx?: number;
      over_1?: number;
      over_5?: number;
      over_10?: number;
      over_15?: number;
      over_20?: number;
      over_25?: number;
      over_30?: number;
      over_50?: number;
      over_100?: number;
    };
  };

  // Sequencing type data (exome/genome) with quality metrics
  exome?: SequencingTypeData | null;
  genome?: SequencingTypeData | null;
}
