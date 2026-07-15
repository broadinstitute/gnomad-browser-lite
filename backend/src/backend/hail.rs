use anyhow::{Context, Result};
use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use genohype_core::codec::EncodedValue;
use genohype_core::genomic::extract::{as_f64, as_i32, as_string, get_field, get_nested_field};
use genohype_core::metadata::CacheOptions;
use genohype_core::projection::{FieldPath, ProjectionTree};
use genohype_core::query::{IntervalList, QueryEngine};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};
use serde_json::json;
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, info, warn};

/// Pre-computed projection for variant list view — avoids re-parsing on every request.
/// Includes both gnomAD-native fields and VCF+VEP fields for seamless dual-schema support.
static VARIANT_LIST_PROJECTION: LazyLock<Arc<ProjectionTree>> = LazyLock::new(|| {
    Arc::new(ProjectionTree::from_fields(&[
        FieldPath::parse("locus").unwrap(),
        FieldPath::parse("alleles").unwrap(),
        FieldPath::parse("rsids").unwrap(),
        FieldPath::parse("variant_id").unwrap(),
        FieldPath::parse("exome.freq").unwrap(),
        FieldPath::parse("genome.freq").unwrap(),
        FieldPath::parse("transcript_consequences").unwrap(),
        // VCF+VEP fields (ignored gracefully when missing)
        FieldPath::parse("vep").unwrap(),
        FieldPath::parse("info").unwrap(),
        // Flat freq array (e.g. Canadian CGDC schema)
        FieldPath::parse("freq").unwrap(),
        FieldPath::parse("rsid").unwrap(),
    ]))
});

/// Minimal projection for gene symbol lookups — skips massive transcripts/exons arrays.
static GENE_SYMBOL_PROJECTION: LazyLock<Arc<ProjectionTree>> = LazyLock::new(|| {
    Arc::new(ProjectionTree::from_fields(&[
        FieldPath::parse("gene_id").unwrap(),
        FieldPath::parse("symbol").unwrap(),
        FieldPath::parse("gene_symbol").unwrap(),
    ]))
});

/// Projection for gene search results — includes location fields but skips transcripts/exons.
static GENE_SEARCH_PROJECTION: LazyLock<Arc<ProjectionTree>> = LazyLock::new(|| {
    Arc::new(ProjectionTree::from_fields(&[
        FieldPath::parse("gene_id").unwrap(),
        FieldPath::parse("symbol").unwrap(),
        FieldPath::parse("gene_symbol").unwrap(),
        FieldPath::parse("chrom").unwrap(),
        FieldPath::parse("start").unwrap(),
        FieldPath::parse("stop").unwrap(),
        FieldPath::parse("interval").unwrap(),
    ]))
});

/// Projection for constraint table — all fields needed for the full GeneConstraint.
static CONSTRAINT_PROJECTION: LazyLock<Arc<ProjectionTree>> = LazyLock::new(|| {
    Arc::new(ProjectionTree::from_fields(&[
        FieldPath::parse("gene_id").unwrap(),
        FieldPath::parse("canonical").unwrap(),
        FieldPath::parse("mane_select").unwrap(),
        FieldPath::parse("lof").unwrap(),
        FieldPath::parse("mis").unwrap(),
        FieldPath::parse("syn").unwrap(),
        FieldPath::parse("constraint_flags").unwrap(),
    ]))
});

/// Projection for tier-router interval loading — gene bounds *plus* the `exons`
/// array (needed for CDS routing) while still skipping the heavy `transcripts`
/// list. See `load_genes_geometry`.
static GENE_INTERVAL_PROJECTION: LazyLock<Arc<ProjectionTree>> = LazyLock::new(|| {
    Arc::new(ProjectionTree::from_fields(&[
        FieldPath::parse("gene_id").unwrap(),
        FieldPath::parse("chrom").unwrap(),
        FieldPath::parse("start").unwrap(),
        FieldPath::parse("stop").unwrap(),
        FieldPath::parse("interval").unwrap(),
        FieldPath::parse("exons").unwrap(),
    ]))
});

use super::VariantBackend;
use crate::models::api::{
    Exon, Gene, GeneConstraint, SearchResult, Transcript, TranscriptConsequence, Variant,
    VariantDetails,
};

/// Default GCS paths for public gnomAD data
pub const DEFAULT_VARIANTS_PATH: &str =
    "gs://gcp-public-data--gnomad/release/4.1.1/ht/browser/gnomad.browser.v4.1.1.sites.ht";
pub const DEFAULT_GENES_PATH: &str =
    "gs://gcp-public-data--gnomad/resources/grch38/browser/gnomad.genes.GRCh38.GENCODEv39.pext.ht";

pub struct HailBackend {
    variants_engine: Arc<QueryEngine>,
    genes_engine: Arc<RwLock<QueryEngine>>,
    /// symbol (uppercase) → gene_id mapping built at startup
    symbol_to_gene_id: Arc<HashMap<String, String>>,
    /// gene_id → constraint metrics loaded from optional constraint table.
    /// Populated by a background thread so the server can bind the port
    /// immediately; empty until the (slow) constraint scan completes.
    constraint_map: Arc<RwLock<HashMap<String, GeneConstraint>>>,
    variants_path: String,
}

/// Optional VEP annotation config for on-the-fly annotation of VCF sources.
pub struct VepConfig {
    pub gff3: String,
    pub fasta: Option<String>,
}

/// Scan the constraint Hail table and build a gene_id → constraint metrics map.
/// Extracted so it can run on a background thread off the startup path.
fn load_constraint_map(constraint_path: &str) -> Result<HashMap<String, GeneConstraint>> {
    let constraint_engine = QueryEngine::open_path_cached(constraint_path, Some(CacheOptions::default()))
        .context("Failed to open constraint table")?;
    let projection = Arc::clone(&CONSTRAINT_PROJECTION);
    let mut map = HashMap::new();
    for row_result in constraint_engine.query_iter_with_projection(&[], None, Some(projection))? {
        let row = match row_result {
            Ok(r) => r,
            Err(_) => continue,
        };
        // Only include canonical transcripts
        let is_canonical = get_field(&row, "canonical")
            .and_then(|v| match v {
                EncodedValue::Boolean(b) => Some(*b),
                _ => None,
            })
            .unwrap_or(false);
        if !is_canonical {
            continue;
        }
        let gene_id = match get_field(&row, "gene_id").and_then(as_string) {
            Some(id) => id,
            None => continue,
        };
        // Skip if already in the map (one entry per gene)
        if map.contains_key(&gene_id) {
            continue;
        }
        let as_opt_i64 = |v: Option<&EncodedValue>| -> Option<i64> {
            v.and_then(|val| match val {
                EncodedValue::Int32(i) => Some(*i as i64),
                EncodedValue::Int64(i) => Some(*i),
                EncodedValue::Float64(f) => Some(*f as i64),
                _ => None,
            })
        };

        let exp_lof = get_nested_field(&row, "lof.exp").and_then(as_f64);
        let exp_mis = get_nested_field(&row, "mis.exp").and_then(as_f64);
        let exp_syn = get_nested_field(&row, "syn.exp").and_then(as_f64);
        let obs_lof = as_opt_i64(get_nested_field(&row, "lof.obs"));
        let obs_mis = as_opt_i64(get_nested_field(&row, "mis.obs"));
        let obs_syn = as_opt_i64(get_nested_field(&row, "syn.obs"));
        let oe_lof = get_nested_field(&row, "lof.oe").and_then(as_f64);
        let oe_lof_lower = get_nested_field(&row, "lof.oe_ci.lower").and_then(as_f64);
        let oe_lof_upper = get_nested_field(&row, "lof.oe_ci.upper").and_then(as_f64);
        let oe_mis = get_nested_field(&row, "mis.oe").and_then(as_f64);
        let oe_mis_lower = get_nested_field(&row, "mis.oe_ci.lower").and_then(as_f64);
        let oe_mis_upper = get_nested_field(&row, "mis.oe_ci.upper").and_then(as_f64);
        let oe_syn = get_nested_field(&row, "syn.oe").and_then(as_f64);
        let oe_syn_lower = get_nested_field(&row, "syn.oe_ci.lower").and_then(as_f64);
        let oe_syn_upper = get_nested_field(&row, "syn.oe_ci.upper").and_then(as_f64);
        let lof_z = get_nested_field(&row, "lof.z_score").and_then(as_f64);
        let mis_z = get_nested_field(&row, "mis.z_score").and_then(as_f64);
        let syn_z = get_nested_field(&row, "syn.z_score").and_then(as_f64);
        let pli = get_nested_field(&row, "lof.pLI").and_then(as_f64);
        let loeuf = oe_lof_upper;
        let flags = get_field(&row, "constraint_flags").and_then(|v| {
            if let EncodedValue::Array(arr) = v {
                let strs: Vec<String> = arr.iter().filter_map(|a| a.as_string()).collect();
                if strs.is_empty() { None } else { Some(strs) }
            } else {
                None
            }
        });
        map.insert(gene_id, GeneConstraint {
            exp_lof, exp_mis, exp_syn,
            obs_lof, obs_mis, obs_syn,
            oe_lof, oe_lof_lower, oe_lof_upper,
            oe_mis, oe_mis_lower, oe_mis_upper,
            oe_syn, oe_syn_lower, oe_syn_upper,
            lof_z, mis_z, syn_z,
            pli, loeuf, flags,
        });
    }
    Ok(map)
}

impl HailBackend {
    pub fn new(variants_path: &str, genes_path: &str, constraint_path: Option<&str>, vep: Option<VepConfig>) -> Result<Self> {
        let cache_opts = Some(CacheOptions::default());
        #[cfg_attr(not(feature = "vep"), allow(unused_mut))]
        let mut variants_engine = QueryEngine::open_path_cached(variants_path, cache_opts.clone())
            .context("Failed to open variants table")?;

        // Wrap with AnnotatingDataSource for on-the-fly VEP annotation. The benchmark
        // serves precomputed consequences, so the default build omits the `vep`
        // feature (and fastVEP); a VEP config is only honored when built with it.
        if let Some(vep_cfg) = vep {
            #[cfg(feature = "vep")]
            {
                use genohype_core::datasource::annotating::VepInitOptions;
                info!("Enabling on-the-fly VEP annotation (GFF3: {}, LOFTEE: enabled)", vep_cfg.gff3);
                let options = VepInitOptions {
                    gff3: vep_cfg.gff3,
                    fasta: vep_cfg.fasta,
                    sa_dir: None,
                    distance: 5000,
                    pick: false,
                    loftee: true,
                };
                variants_engine = variants_engine.with_vep(options)
                    .context("Failed to initialize VEP annotation wrapper")?;
            }
            #[cfg(not(feature = "vep"))]
            {
                let _ = vep_cfg;
                anyhow::bail!(
                    "VEP annotation was requested (vep_gff3 set) but this binary was built \
                     without the `vep` feature; rebuild with --features vep"
                );
            }
        }

        let genes_engine = QueryEngine::open_path_cached(genes_path, cache_opts)
            .context("Failed to open genes table")?;

        // Build symbol → gene_id index at startup (projected scan, skips transcripts/exons)
        let projection = Arc::clone(&GENE_SYMBOL_PROJECTION);
        let mut symbol_map = HashMap::new();
        for row_result in genes_engine.query_iter_with_projection(&[], None, Some(projection))? {
            let row = match row_result {
                Ok(r) => r,
                Err(_) => continue,
            };
            let gene_id = match get_field(&row, "gene_id").and_then(as_string) {
                Some(id) => id,
                None => continue,
            };
            if let Some(sym) = get_field(&row, "symbol").and_then(as_string) {
                symbol_map.insert(sym.to_uppercase(), gene_id.clone());
            }
            if let Some(sym) = get_field(&row, "gene_symbol").and_then(as_string) {
                symbol_map.insert(sym.to_uppercase(), gene_id.clone());
            }
            if let Some(sym) = get_field(&row, "gencode_symbol").and_then(as_string) {
                symbol_map.insert(sym.to_uppercase(), gene_id);
            }
        }
        info!("Built gene symbol index: {} symbols", symbol_map.len());

        // Load constraint metrics in the background if a path is provided. The
        // constraint scan (974 partitions over GCS, ~100s) previously ran
        // synchronously here, holding the port closed for the full boot. Now we
        // bind immediately and fill the map in on a detached thread; genes
        // served before it's ready simply come back with `constraint: None`.
        let constraint_map: Arc<RwLock<HashMap<String, GeneConstraint>>> =
            Arc::new(RwLock::new(HashMap::new()));
        if let Some(cp) = constraint_path {
            let cp = cp.to_string();
            let target = Arc::clone(&constraint_map);
            std::thread::spawn(move || {
                info!("Loading constraint metrics from {} (background)", cp);
                match load_constraint_map(&cp) {
                    Ok(map) => {
                        let n = map.len();
                        match target.write() {
                            Ok(mut guard) => *guard = map,
                            Err(e) => {
                                warn!("Constraint map lock poisoned, skipping: {}", e);
                                return;
                            }
                        }
                        info!("Loaded constraint metrics for {} genes (background)", n);
                    }
                    Err(e) => warn!("Failed to load constraint metrics (constraint panel will be empty): {:#}", e),
                }
            });
        }

        Ok(Self {
            variants_engine: Arc::new(variants_engine),
            genes_engine: Arc::new(RwLock::new(genes_engine)),
            symbol_to_gene_id: Arc::new(symbol_map),
            constraint_map,
            variants_path: variants_path.to_string(),
        })
    }

    /// Return metadata about the data source for UI display.
    pub fn source_info(&self) -> serde_json::Value {
        json!({
            "type": "hail",
            "path": self.variants_path,
            "total_partitions": self.variants_engine.num_partitions(),
        })
    }

    pub fn with_defaults() -> Result<Self> {
        Self::new(DEFAULT_VARIANTS_PATH, DEFAULT_GENES_PATH, None, None)
    }
}

// ============================================================================
// Gene extraction from gnomAD genes table
// ============================================================================

/// Load gene geometry (chrom, bounds, and `exons` incl. CDS feature types) from
/// a gnomAD genes Hail table, for the tiered router's hot-interval tree.
///
/// Reuses [`extract_gene`] but with [`GENE_INTERVAL_PROJECTION`], which pulls the
/// `exons` array (CDS routing needs per-exon feature types) while skipping the
/// heavy `transcripts` list. Runs a single projected full-table scan; intended
/// to be called once at startup (see `build_backend` for the Tiered arm).
pub fn load_genes_geometry(genes_path: &str) -> Result<Vec<Gene>> {
    let engine = QueryEngine::open_path_cached(genes_path, Some(CacheOptions::default()))
        .context("Failed to open genes table for tier-router interval loading")?;
    let projection = Arc::clone(&GENE_INTERVAL_PROJECTION);
    let mut genes = Vec::new();
    for row_result in engine.query_iter_with_projection(&[], None, Some(projection))? {
        let row = match row_result {
            Ok(r) => r,
            Err(_) => continue,
        };
        if let Some(gene) = extract_gene(&row) {
            genes.push(gene);
        }
    }
    info!("Loaded geometry for {} genes (tier routing)", genes.len());
    Ok(genes)
}

fn extract_gene(row: &EncodedValue) -> Option<Gene> {
    let gene_id = get_field(row, "gene_id").and_then(as_string)?;
    let gene_symbol = get_field(row, "symbol")
        .or_else(|| get_field(row, "gene_symbol"))
        .and_then(as_string);
    let gencode_symbol = get_field(row, "gencode_symbol").and_then(as_string);

    let chrom = get_field(row, "chrom")
        .and_then(as_string)
        .or_else(|| get_nested_field(row, "interval.start.contig").and_then(as_string))?;
    let start = get_field(row, "start")
        .and_then(as_i32)
        .or_else(|| get_nested_field(row, "interval.start.position").and_then(as_i32))
        .unwrap_or(0) as i64;
    let stop = get_field(row, "stop")
        .and_then(as_i32)
        .or_else(|| get_nested_field(row, "interval.end.position").and_then(as_i32))
        .unwrap_or(0) as i64;

    let strand = get_field(row, "strand").and_then(as_string);
    let canonical_transcript_id = get_field(row, "canonical_transcript_id")
        .and_then(as_string)
        .or_else(|| get_field(row, "mane_select_transcript_id").and_then(as_string));

    let transcripts = extract_array(row, "transcripts", extract_transcript);
    let exons = extract_array(row, "exons", extract_exon);

    Some(Gene {
        gene_id,
        gene_symbol,
        gencode_symbol,
        chrom,
        start,
        stop,
        strand,
        canonical_transcript_id,
        transcripts,
        exons,
        constraint: None,
    })
}

fn extract_transcript(v: &EncodedValue) -> Option<Transcript> {
    let transcript_id = get_field(v, "transcript_id").and_then(as_string)?;
    let start = get_field(v, "start").and_then(as_i32).map(|i| i as i64);
    let stop = get_field(v, "stop").and_then(as_i32).map(|i| i as i64);
    let exons = extract_array(v, "exons", extract_exon).unwrap_or_default();

    Some(Transcript {
        transcript_id,
        start,
        stop,
        exons,
    })
}

fn extract_exon(v: &EncodedValue) -> Option<Exon> {
    let feature_type = get_field(v, "feature_type")
        .and_then(as_string)
        .unwrap_or_else(|| "exon".to_string());
    let start = get_field(v, "start").and_then(as_i32)? as i64;
    let stop = get_field(v, "stop").and_then(as_i32)? as i64;
    Some(Exon {
        feature_type,
        start,
        stop,
    })
}

fn extract_array<T>(
    row: &EncodedValue,
    field: &str,
    f: fn(&EncodedValue) -> Option<T>,
) -> Option<Vec<T>> {
    if let Some(EncodedValue::Array(arr)) = get_field(row, field) {
        let items: Vec<T> = arr.iter().filter_map(f).collect();
        if items.is_empty() {
            None
        } else {
            Some(items)
        }
    } else {
        None
    }
}

// ============================================================================
// Variant extraction from gnomAD browser sites table
// ============================================================================

fn extract_variant(row: &EncodedValue) -> Option<Variant> {
    let locus = get_field(row, "locus")?;
    let contig = as_string(get_field(locus, "contig")?)?;
    let pos = as_i32(get_field(locus, "position")?)? as i64;

    let alleles = extract_alleles(row)?;
    // Synthesize variant_id from locus+alleles if missing (VCF sources)
    let variant_id = get_field(row, "variant_id")
        .and_then(as_string)
        .or_else(|| synthesize_variant_id(&contig, pos, &alleles));
    let rsids = extract_string_array(row, "rsids")
        .or_else(|| get_field(row, "rsid").and_then(as_string).map(|s| vec![s]));

    let (consequence, hgvsc, hgvsp, gene_id, gene_symbol, transcript_id, lof) =
        extract_canonical_consequence(row);
    let (ac, an, af) = extract_freq(row);

    Some(Variant {
        variant_id,
        pos,
        chrom: contig,
        alleles,
        rsids,
        consequence,
        hgvsc,
        hgvsp,
        gene_id,
        gene_symbol,
        transcript_id,
        lof,
        ac,
        an,
        af,
        allele_freq: af,
    })
}

fn extract_variant_details(row: &EncodedValue) -> Option<VariantDetails> {
    let locus = get_field(row, "locus")?;
    let contig = as_string(get_field(locus, "contig")?)?;
    let pos = as_i32(get_field(locus, "position")?)? as i64;

    let alleles = extract_alleles(row)?;
    let variant_id = get_field(row, "variant_id")
        .and_then(as_string)
        .or_else(|| synthesize_variant_id(&contig, pos, &alleles));
    let rsids = extract_string_array(row, "rsids")
        .or_else(|| get_field(row, "rsid").and_then(as_string).map(|s| vec![s]));
    let caid = get_field(row, "caid").and_then(as_string);

    let (consequence, hgvsc, hgvsp, gene_id, gene_symbol, transcript_id, _lof) =
        extract_canonical_consequence(row);
    let (ac, an, af) = extract_freq(row);

    // Pass through deeply nested structures as JSON
    let exome = get_field(row, "exome").and_then(encoded_to_json);
    let genome = get_field(row, "genome").and_then(encoded_to_json);
    let joint = get_field(row, "joint").and_then(encoded_to_json);
    let in_silico_predictors = get_field(row, "in_silico_predictors").and_then(encoded_to_json);
    let coverage = get_field(row, "coverage").and_then(encoded_to_json);
    let transcript_consequences = extract_transcript_consequences(row);

    Some(VariantDetails {
        variant_id,
        pos,
        chrom: contig,
        alleles,
        rsids,
        consequence,
        hgvsc,
        hgvsp,
        gene_id,
        gene_symbol,
        transcript_id,
        ac,
        an,
        af,
        allele_freq: af,
        caid,
        exome,
        genome,
        joint,
        transcript_consequences,
        in_silico_predictors,
        coverage,
    })
}

fn extract_alleles(row: &EncodedValue) -> Option<Vec<String>> {
    if let Some(EncodedValue::Array(arr)) = get_field(row, "alleles") {
        let alleles: Vec<String> = arr.iter().filter_map(|a| a.as_string()).collect();
        if alleles.is_empty() {
            None
        } else {
            Some(alleles)
        }
    } else {
        None
    }
}

fn extract_string_array(row: &EncodedValue, field: &str) -> Option<Vec<String>> {
    if let Some(EncodedValue::Array(arr)) = get_field(row, field) {
        let strings: Vec<String> = arr.iter().filter_map(|a| a.as_string()).collect();
        if strings.is_empty() {
            None
        } else {
            Some(strings)
        }
    } else {
        None
    }
}

fn encoded_to_json(value: &EncodedValue) -> Option<serde_json::Value> {
    serde_json::to_value(value).ok()
}

/// Create interval strings with both chr-prefixed and bare contig forms,
/// so queries match both HT (chr1) and VCF (1) sources.
fn dual_contig_intervals(chrom: &str, intervals: &[(i32, i32)]) -> Vec<String> {
    let alt_chrom = if chrom.starts_with("chr") {
        chrom.strip_prefix("chr").unwrap().to_string()
    } else {
        format!("chr{}", chrom)
    };
    let mut result = Vec::with_capacity(intervals.len() * 2);
    for (start, end) in intervals {
        result.push(format!("{}:{}-{}", chrom, start, end));
        result.push(format!("{}:{}-{}", alt_chrom, start, end));
    }
    result
}

/// Strip transcript prefix from HGVS notation: "ENST00000302118.5:c.-180T>G" → "c.-180T>G"
fn strip_hgvs_prefix(hgvs: Option<String>) -> Option<String> {
    hgvs.map(|s| match s.rfind(':') {
        Some(i) => s[i + 1..].to_string(),
        None => s,
    })
}

/// Synthesize a variant_id from locus+alleles (for VCF sources that lack variant_id).
/// Strips `chr` prefix to match gnomAD-style IDs: "1-55039447-G-A".
fn synthesize_variant_id(contig: &str, pos: i64, alleles: &[String]) -> Option<String> {
    if alleles.len() < 2 {
        return None;
    }
    let chrom = contig.strip_prefix("chr").unwrap_or(contig);
    Some(format!("{}-{}-{}", chrom, pos, alleles.join("-")))
}

/// Extract a number from an EncodedValue, handling both scalar and array (Number=A) VCF INFO fields.
fn get_first_number(v: &EncodedValue) -> Option<f64> {
    match v {
        EncodedValue::Int32(i) => Some(*i as f64),
        EncodedValue::Int64(i) => Some(*i as f64),
        EncodedValue::Float32(f) => Some(*f as f64),
        EncodedValue::Float64(f) => Some(*f),
        EncodedValue::Array(arr) => arr.first().and_then(get_first_number),
        _ => None,
    }
}

/// Extract frequency data from the variant. Prefer exome/genome, fall back to VCF INFO AC/AN/AF.
fn extract_freq(row: &EncodedValue) -> (i64, i64, f64) {
    // Try gnomAD-native exome/genome freq first
    for dataset in &["exome", "genome"] {
        if let Some(dataset_val) = get_field(row, dataset) {
            if let Some(freq) = get_field(dataset_val, "freq") {
                // Try "all" ancestry group first
                if let Some(all_freq) = get_field(freq, "all") {
                    if let Some(result) = get_ac_an_af(all_freq) {
                        return result;
                    }
                }
                // Fall back to freq struct directly
                if let Some(result) = get_ac_an_af(freq) {
                    return result;
                }
            }
        }
    }

    // Fallback: flat freq array (e.g. Canadian CGDC schema: freq[0].AC/AF/AN)
    if let Some(EncodedValue::Array(freq_arr)) = get_field(row, "freq") {
        if let Some(first) = freq_arr.first() {
            if let Some(result) = get_ac_an_af(first) {
                return result;
            }
        }
    }

    // Fallback: extract AC/AN/AF from VCF INFO field
    if let Some(info) = get_field(row, "info") {
        let ac = get_field(info, "AC")
            .and_then(get_first_number)
            .map(|v| v as i64)
            .unwrap_or(0);
        let an = get_field(info, "AN")
            .and_then(get_first_number)
            .map(|v| v as i64)
            .unwrap_or(0);
        let af = get_field(info, "AF")
            .and_then(get_first_number)
            .unwrap_or_else(|| if an > 0 { ac as f64 / an as f64 } else { 0.0 });
        if ac > 0 || an > 0 {
            return (ac, an, af);
        }
    }

    (0, 0, 0.0)
}

fn get_ac_an_af(freq_val: &EncodedValue) -> Option<(i64, i64, f64)> {
    let ac = get_field(freq_val, "ac")
        .or_else(|| get_field(freq_val, "AC"))
        .and_then(|v| match v {
            EncodedValue::Int32(i) => Some(*i as i64),
            EncodedValue::Int64(i) => Some(*i),
            EncodedValue::Float64(f) => Some(*f as i64),
            _ => None,
        })?;
    let an = get_field(freq_val, "an")
        .or_else(|| get_field(freq_val, "AN"))
        .and_then(|v| match v {
            EncodedValue::Int32(i) => Some(*i as i64),
            EncodedValue::Int64(i) => Some(*i),
            EncodedValue::Float64(f) => Some(*f as i64),
            _ => None,
        })?;
    let af = if an > 0 {
        ac as f64 / an as f64
    } else {
        0.0
    };
    Some((ac, an, af))
}

fn extract_canonical_consequence(
    row: &EncodedValue,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    // Try gnomAD-native transcript_consequences first
    if let Some(EncodedValue::Array(tcs)) = get_field(row, "transcript_consequences") {
        let canonical = tcs.iter().find(|tc| {
            get_field(tc, "is_canonical")
                .and_then(|v| match v {
                    EncodedValue::Boolean(b) => Some(*b),
                    _ => None,
                })
                .unwrap_or(false)
        });

        let tc = canonical.or_else(|| tcs.first());

        if let Some(tc) = tc {
            return (
                get_field(tc, "major_consequence").and_then(as_string),
                get_field(tc, "hgvsc").and_then(as_string),
                get_field(tc, "hgvsp").and_then(as_string),
                get_field(tc, "gene_id").and_then(as_string),
                get_field(tc, "gene_symbol").and_then(as_string),
                get_field(tc, "transcript_id").and_then(as_string),
                get_field(tc, "lof").and_then(as_string),
            );
        }
    }

    // Fallback: extract from fastVEP `vep` array
    if let Some(EncodedValue::Array(veps)) = get_field(row, "vep") {
        let canonical = veps.iter().find(|v| {
            get_field(v, "canonical")
                .and_then(|val| match val {
                    EncodedValue::Boolean(b) => Some(*b),
                    _ => None,
                })
                .unwrap_or(false)
        });

        let entry = canonical.or_else(|| veps.first());

        if let Some(entry) = entry {
            return (
                get_field(entry, "consequence").and_then(as_string),
                strip_hgvs_prefix(get_field(entry, "hgvsc").and_then(as_string)),
                strip_hgvs_prefix(get_field(entry, "hgvsp").and_then(as_string)),
                get_field(entry, "gene_id").and_then(as_string),
                get_field(entry, "gene_symbol").and_then(as_string),
                get_field(entry, "transcript_id").and_then(as_string),
                get_field(entry, "lof").and_then(as_string),
            );
        }
    }

    (None, None, None, None, None, None, None)
}

fn extract_transcript_consequences(row: &EncodedValue) -> Option<Vec<TranscriptConsequence>> {
    // Try gnomAD-native transcript_consequences first
    if let Some(EncodedValue::Array(tcs)) = get_field(row, "transcript_consequences") {
        let results: Vec<TranscriptConsequence> = tcs
            .iter()
            .filter_map(|tc| {
                let gene_id = get_field(tc, "gene_id").and_then(as_string)?;
                let gene_symbol = get_field(tc, "gene_symbol").and_then(as_string)?;
                let transcript_id = get_field(tc, "transcript_id").and_then(as_string)?;
                let major_consequence = get_field(tc, "major_consequence").and_then(as_string)?;

                Some(TranscriptConsequence {
                    gene_id,
                    gene_symbol,
                    transcript_id,
                    transcript_version: get_field(tc, "transcript_version").and_then(as_string),
                    consequence_terms: extract_string_array(tc, "consequence_terms"),
                    major_consequence,
                    hgvsc: get_field(tc, "hgvsc").and_then(as_string),
                    hgvsp: get_field(tc, "hgvsp").and_then(as_string),
                    is_canonical: get_field(tc, "is_canonical").and_then(|v| match v {
                        EncodedValue::Boolean(b) => Some(*b),
                        _ => None,
                    }),
                    is_mane_select: get_field(tc, "is_mane_select").and_then(|v| match v {
                        EncodedValue::Boolean(b) => Some(*b),
                        _ => None,
                    }),
                    is_mane_select_version: get_field(tc, "is_mane_select_version")
                        .and_then(|v| match v {
                            EncodedValue::Boolean(b) => Some(*b),
                            _ => None,
                        }),
                    lof: get_field(tc, "lof").and_then(as_string),
                    lof_filter: get_field(tc, "lof_filter").and_then(as_string),
                    lof_flags: get_field(tc, "lof_flags").and_then(as_string),
                    domains: extract_string_array(tc, "domains"),
                    refseq_id: get_field(tc, "refseq_id").and_then(as_string),
                    biotype: get_field(tc, "biotype").and_then(as_string),
                })
            })
            .collect();
        if !results.is_empty() {
            return Some(results);
        }
    }

    // Fallback: map fastVEP `vep` array to TranscriptConsequence structs
    if let Some(EncodedValue::Array(veps)) = get_field(row, "vep") {
        let results: Vec<TranscriptConsequence> = veps
            .iter()
            .filter_map(|entry| {
                let gene_id = get_field(entry, "gene_id").and_then(as_string)?;
                let gene_symbol = get_field(entry, "gene_symbol").and_then(as_string)?;
                let transcript_id = get_field(entry, "transcript_id").and_then(as_string)?;
                let consequence = get_field(entry, "consequence").and_then(as_string)?;

                // Split "&"-joined consequences into terms
                let consequence_terms: Vec<String> =
                    consequence.split('&').map(|s| s.to_string()).collect();

                Some(TranscriptConsequence {
                    gene_id,
                    gene_symbol,
                    transcript_id,
                    transcript_version: None,
                    consequence_terms: Some(consequence_terms),
                    major_consequence: consequence,
                    hgvsc: get_field(entry, "hgvsc").and_then(as_string),
                    hgvsp: get_field(entry, "hgvsp").and_then(as_string),
                    is_canonical: get_field(entry, "canonical").and_then(|v| match v {
                        EncodedValue::Boolean(b) => Some(*b),
                        _ => None,
                    }),
                    is_mane_select: get_field(entry, "mane_select")
                        .and_then(as_string)
                        .map(|_| true),
                    is_mane_select_version: None,
                    lof: get_field(entry, "lof").and_then(as_string),
                    lof_filter: get_field(entry, "lof_filter").and_then(as_string),
                    lof_flags: get_field(entry, "lof_flags").and_then(as_string),
                    domains: None,
                    refseq_id: None,
                    biotype: get_field(entry, "biotype").and_then(as_string),
                })
            })
            .collect();
        if !results.is_empty() {
            return Some(results);
        }
    }

    None
}

// ============================================================================
// VariantBackend implementation
// ============================================================================

#[async_trait]
impl VariantBackend for HailBackend {
    async fn get_gene(&self, gene_id: &str) -> Result<Option<Gene>> {
        let genes_engine = Arc::clone(&self.genes_engine);
        let constraint_map = Arc::clone(&self.constraint_map);
        let gene_id = gene_id.to_string();

        tokio::task::spawn_blocking(move || -> Result<Option<Gene>> {
            let mut engine = genes_engine.write().map_err(|e| anyhow::anyhow!("Lock poisoned: {}", e))?;

            // The genes table is keyed by gene_id — use a point lookup
            let key = EncodedValue::Struct(vec![(
                "gene_id".to_string(),
                EncodedValue::Binary(gene_id.as_bytes().to_vec()),
            )]);

            match engine.lookup(&key)? {
                Some(row) => {
                    let mut gene = match extract_gene(&row) {
                        Some(g) => g,
                        None => return Ok(None),
                    };
                    gene.constraint = constraint_map
                        .read()
                        .ok()
                        .and_then(|m| m.get(&gene.gene_id).cloned());
                    Ok(Some(gene))
                }
                None => Ok(None),
            }
        })
        .await?
    }

    async fn get_gene_by_symbol(&self, symbol: &str) -> Result<Option<Gene>> {
        let symbol_upper = symbol.to_uppercase();
        let gene_id = match self.symbol_to_gene_id.get(&symbol_upper) {
            Some(id) => id.clone(),
            None => return Ok(None),
        };
        self.get_gene(&gene_id).await
    }

    async fn search_genes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let genes_engine = Arc::clone(&self.genes_engine);
        let query = query.to_uppercase();

        tokio::task::spawn_blocking(move || -> Result<Vec<SearchResult>> {
            let engine = genes_engine.read().map_err(|e| anyhow::anyhow!("Lock poisoned: {}", e))?;
            let projection = Arc::clone(&GENE_SEARCH_PROJECTION);

            let mut results = Vec::new();

            for row_result in engine.query_iter_with_projection(&[], None, Some(projection))? {
                let row = match row_result {
                    Ok(r) => r,
                    Err(_) => continue,
                };

                let gene_id = match get_field(&row, "gene_id").and_then(as_string) {
                    Some(id) => id,
                    None => continue,
                };
                let gene_symbol = get_field(&row, "symbol")
                    .or_else(|| get_field(&row, "gene_symbol"))
                    .and_then(as_string)
                    .unwrap_or_default();

                if gene_symbol.to_uppercase().starts_with(&query)
                    || gene_id.to_uppercase().starts_with(&query)
                {
                    let chrom = get_field(&row, "chrom").and_then(as_string).or_else(|| {
                        get_nested_field(&row, "interval.start.contig").and_then(as_string)
                    });
                    let start = get_field(&row, "start")
                        .and_then(as_i32)
                        .or_else(|| {
                            get_nested_field(&row, "interval.start.position").and_then(as_i32)
                        })
                        .map(|i| i as i64);
                    let stop = get_field(&row, "stop")
                        .and_then(as_i32)
                        .or_else(|| {
                            get_nested_field(&row, "interval.end.position").and_then(as_i32)
                        })
                        .map(|i| i as i64);

                    results.push(SearchResult {
                        gene_id,
                        gene_symbol,
                        chrom,
                        start,
                        stop,
                    });

                    if results.len() >= limit {
                        break;
                    }
                }
            }

            Ok(results)
        })
        .await?
    }

    async fn get_variants(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        _force_fallback: bool,
    ) -> Result<Vec<Variant>> {
        let variants_engine = Arc::clone(&self.variants_engine);
        let chrom = chrom.to_string();
        let start_i32 = start as i32;
        let end_i32 = end as i32;

        tokio::task::spawn_blocking(move || -> Result<Vec<Variant>> {
            debug!(
                "Querying variants for {}:{}-{} (with projection)",
                chrom, start_i32, end_i32
            );

            // Use IntervalList with both contig forms (chr1 and 1) for HT/VCF compatibility
            let interval_strs = dual_contig_intervals(&chrom, &[(start_i32, end_i32)]);
            let intervals = IntervalList::from_strings(&interval_strs)
                .context("Failed to parse interval")?;

            let projection = Arc::clone(&VARIANT_LIST_PROJECTION);

            let variants: Vec<Variant> = variants_engine
                .query_iter_with_projection(&[], Some(Arc::new(intervals)), Some(projection))?
                .filter_map(|res| res.ok().and_then(|r| extract_variant(&r)))
                .collect();

            debug!("Extracted {} variants", variants.len());

            Ok(variants)
        })
        .await?
    }

    async fn get_variant_detail(
        &self,
        variant_id: &str,
        _force_fallback: bool,
    ) -> Result<Option<VariantDetails>> {
        let variants_engine = Arc::clone(&self.variants_engine);

        // Parse variant_id: "chr1-55039447-G-A" or "1-55039447-G-A"
        let parts: Vec<&str> = variant_id.split('-').collect();
        if parts.len() < 4 {
            anyhow::bail!("Invalid variant ID format: {}", variant_id);
        }

        let raw_chrom = parts[0].to_string();
        let pos: i32 = parts[1]
            .parse()
            .context("Invalid position in variant ID")?;
        let ref_allele = parts[2].to_string();
        let alt_allele = parts[3..].join("-");

        tokio::task::spawn_blocking(move || -> Result<Option<VariantDetails>> {
            // Try both contig forms (chr1 and 1) to handle HT vs VCF sources
            let interval_strs = dual_contig_intervals(&raw_chrom, &[(pos, pos)]);
            let intervals = IntervalList::from_strings(&interval_strs)
                .context("Failed to parse variant interval")?;

            for row_result in variants_engine
                .query_iter_with_intervals(&[], Some(Arc::new(intervals)))?
            {
                let row = match row_result {
                    Ok(r) => r,
                    Err(_) => continue,
                };

                // Filter by alleles to find exact variant match
                if let Some(alleles) = extract_alleles(&row) {
                    if alleles.len() >= 2
                        && alleles[0] == ref_allele
                        && alleles[1] == alt_allele
                    {
                        return Ok(extract_variant_details(&row));
                    }
                }
            }

            Ok(None)
        })
        .await?
    }

    async fn stream_variants(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        regions: Option<&[(i64, i64)]>,
    ) -> Result<BoxStream<'static, Result<Variant>>> {
        let variants_engine = Arc::clone(&self.variants_engine);
        let chrom = chrom.to_string();
        let start_i32 = start as i32;
        let end_i32 = end as i32;

        // Build interval strings with both contig forms for HT/VCF compatibility
        let interval_strs: Vec<String> = match regions {
            Some(r) => {
                let pairs: Vec<(i32, i32)> = r.iter().map(|(s, e)| (*s as i32, *e as i32)).collect();
                dual_contig_intervals(&chrom, &pairs)
            }
            None => dual_contig_intervals(&chrom, &[(start_i32, end_i32)]),
        };

        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Variant>>(16);

        tokio::task::spawn_blocking(move || {
            debug!(
                "Streaming variants for {} intervals (with projection)",
                interval_strs.len()
            );

            let intervals = match IntervalList::from_strings(&interval_strs) {
                Ok(i) => i,
                Err(e) => {
                    let _ = tx.blocking_send(Err(e.into()));
                    return;
                }
            };

            let projection = Arc::clone(&VARIANT_LIST_PROJECTION);

            let iter = match variants_engine.query_iter_with_projection(
                &[],
                Some(Arc::new(intervals)),
                Some(projection),
            ) {
                Ok(i) => i,
                Err(e) => {
                    let _ = tx.blocking_send(Err(e.into()));
                    return;
                }
            };

            for row_result in iter {
                if let Some(variant) = row_result.ok().and_then(|r| extract_variant(&r)) {
                    if tx.blocking_send(Ok(variant)).is_err() {
                        // Receiver dropped (client disconnected)
                        debug!("Stream receiver dropped, stopping iteration");
                        return;
                    }
                }
            }
        });

        Ok(ReceiverStream::new(rx).boxed())
    }

    async fn stream_variant_details(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        regions: Option<&[(i64, i64)]>,
    ) -> Result<BoxStream<'static, Result<VariantDetails>>> {
        let variants_engine = Arc::clone(&self.variants_engine);
        let chrom = chrom.to_string();
        let start_i32 = start as i32;
        let end_i32 = end as i32;

        let interval_strs: Vec<String> = match regions {
            Some(r) => {
                let pairs: Vec<(i32, i32)> = r.iter().map(|(s, e)| (*s as i32, *e as i32)).collect();
                dual_contig_intervals(&chrom, &pairs)
            }
            None => dual_contig_intervals(&chrom, &[(start_i32, end_i32)]),
        };

        let (tx, rx) = tokio::sync::mpsc::channel::<Result<VariantDetails>>(16);

        tokio::task::spawn_blocking(move || {
            debug!(
                "Streaming variant details for {} intervals (no projection)",
                interval_strs.len()
            );

            let intervals = match IntervalList::from_strings(&interval_strs) {
                Ok(i) => i,
                Err(e) => {
                    let _ = tx.blocking_send(Err(e.into()));
                    return;
                }
            };

            let iter = match variants_engine.query_iter_with_intervals(
                &[],
                Some(Arc::new(intervals)),
            ) {
                Ok(i) => i,
                Err(e) => {
                    let _ = tx.blocking_send(Err(e.into()));
                    return;
                }
            };

            for row_result in iter {
                if let Some(detail) = row_result.ok().and_then(|r| extract_variant_details(&r)) {
                    if tx.blocking_send(Ok(detail)).is_err() {
                        debug!("Detail stream receiver dropped, stopping iteration");
                        return;
                    }
                }
            }
        });

        Ok(ReceiverStream::new(rx).boxed())
    }
}
