use serde::{Deserialize, Serialize};
use serde_json::Value;

// ==================== Gene Types ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Exon {
    pub feature_type: String,
    pub start: i64,
    pub stop: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transcript {
    pub transcript_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<i64>,
    pub exons: Vec<Exon>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Gene {
    pub gene_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gene_symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gencode_symbol: Option<String>,
    pub chrom: String,
    pub start: i64,
    pub stop: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strand: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_transcript_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcripts: Option<Vec<Transcript>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exons: Option<Vec<Exon>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub gene_id: String,
    pub gene_symbol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chrom: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<i64>,
}

// ==================== Variant Types ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variant {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant_id: Option<String>,
    pub pos: i64,
    pub chrom: String,
    pub alleles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rsids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consequence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hgvsc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hgvsp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gene_symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lof: Option<String>,
    pub ac: i64,
    pub an: i64,
    pub af: f64,
    pub allele_freq: f64,
}

// ==================== Variant Detail Types ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Population {
    pub id: String,
    pub ac: i64,
    pub an: i64,
    pub homozygote_count: i64,
    pub hemizygote_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptConsequence {
    pub gene_id: String,
    pub gene_symbol: String,
    pub transcript_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consequence_terms: Option<Vec<String>>,
    pub major_consequence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hgvsc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hgvsp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_canonical: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_mane_select: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_mane_select_version: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lof: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lof_filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lof_flags: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refseq_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub biotype: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaddPrediction {
    pub phred: f64,
    pub raw_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InSilicoPredictors {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cadd: Option<CaddPrediction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revel_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spliceai_ds_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pangolin_largest_ds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phylop: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sift_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polyphen_max: Option<f64>,
}

// ==================== Variant Details (extends Variant) ====================
//
// The deeply nested structures (exome, genome, joint, coverage) are passed through
// as serde_json::Value because the Hail table schema uses mixed casing (e.g., grpmax
// has uppercase AC/AF/AN) and contains many fields beyond what the frontend TypeScript
// types declare. Using Value here avoids brittle deserialization while the outer
// Variant/Gene types enforce the compile-time contract.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariantDetails {
    // Base variant fields (flattened, not nested)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant_id: Option<String>,
    pub pos: i64,
    pub chrom: String,
    pub alleles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rsids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consequence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hgvsc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hgvsp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gene_symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_id: Option<String>,
    pub ac: i64,
    pub an: i64,
    pub af: f64,
    pub allele_freq: f64,

    // Detail-specific fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exome: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genome: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub joint: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_consequences: Option<Vec<TranscriptConsequence>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_silico_predictors: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<Value>,
}

// ==================== Response Wrappers ====================

#[derive(Debug, Clone, Serialize)]
pub struct GeneVariantsResponse {
    pub gene: Gene,
    pub variants: Vec<Variant>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegionVariantsResponse {
    pub region: RegionInfo,
    pub variants: Vec<Variant>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegionInfo {
    pub chrom: String,
    pub start: i64,
    pub end: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub query: String,
    pub results: Vec<SearchResult>,
    pub total: usize,
}
