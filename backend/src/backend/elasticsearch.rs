//! Elasticsearch backend (benchmark arm `es`) — the prod baseline.
//!
//! Production gnomAD serves variants from Elasticsearch 7.x. This backend runs ES
//! *behind the same Rust REST API* as every other arm so the datastore is the only
//! variable (DESIGN.md "Core principle: one API, many backends"). The point of
//! this arm is to be a **fair representation of prod**: the queries here reproduce
//! the production query DSL, and the documents are read in the exact shape the prod
//! loader produces.
//!
//! ## Document shape (must match prod — fairness-critical)
//!
//! The prod ES export (`data-pipeline/.../elasticsearch_export.py`, config in
//! `datasets_config.py` under `gnomad_v4_variants`) maps each Hail row to:
//!
//! ```text
//! {
//!   document_id, variant_id, rsids, locus: {contig: keyword, position: integer},
//!   gene_id:       <set of transcript_consequences.gene_id>,       // top-level, indexed
//!   transcript_id: <set of transcript_consequences.transcript_id>, // top-level, indexed
//!   value: { ...the full source variant row... }                  // `enabled: false` — stored, not indexed
//! }
//! ```
//!
//! i.e. a small set of `index_fields` are promoted to the top level and indexed
//! (`locus.contig` keyword + `locus.position` integer → Lucene BKD range, plus
//! `variant_id`/`rsids`/`gene_id`/`transcript_id` keyword terms), while the entire
//! record is duplicated under `value` (`_source` only). The genohype ES loader
//! (Phase 2a) must reproduce exactly this shape. Reading `_source.value.*` here —
//! rather than flat columns — is what makes the schema-width benchmark honest: ES
//! decompresses and returns the whole `value` `_source`, the same cost prod pays.
//!
//! ## Query DSL (matches `graphql-api/src/queries/variant-datasets/gnomad-v4-variant-queries.ts`)
//!
//! - **Region** (`get_variants`): `bool.filter` of `term locus.contig` +
//!   `range locus.position {gte,lte}`, `sort locus.position asc`, `size 10000`,
//!   `_source` restricted to the prod gene/region projection
//!   (`getMultiVariantSourceFields`), scrolled to completion (`fetchAllSearchResults`).
//! - **Variant-by-id** (`get_variant_detail`): `bool.filter term variant_id`,
//!   `size 1`, full `_source` → `hit._source.value`.
//!
//! We deliberately do **not** replicate the GraphQL post-processing (the
//! `hasPositiveAC` filter and `shapeVariantSummary`): those run in Node *after* ES
//! has already done its work, so they don't change the datastore latency we're
//! measuring, and dropping them keeps this arm result-equivalent with the DuckDB /
//! Hail reference (see `crate::oracle`), which returns the full range.
//!
//! ## Client
//!
//! Uses the official `elasticsearch` crate (7.x, matching prod's server major).
//! Per DESIGN "ES client parity": **no** `Bottleneck`-style queue in the Rust
//! client — concurrency/saturation is governed by axum so it's comparable across
//! arms. Split timing (`db_query_ms` vs `deserialize_ms`) is captured exactly as in
//! `postgres.rs` so Rust's fast `serde_json` doesn't mask ES latency.

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use elasticsearch::http::transport::Transport;
use elasticsearch::{ClearScrollParts, Elasticsearch, ScrollParts, SearchParts};
use serde_json::{json, Value};
use std::time::Instant;

use super::json_extract::{variant_details_from_data, variant_from_data, json_str};
use super::{QueryStats, VariantBackend};
use crate::models::api::{Gene, SearchResult, Variant, VariantDetails};
use crate::models::db::DuckDbGeneRow;

/// Default index names (match prod conventions; overridable in config).
pub const DEFAULT_VARIANTS_INDEX: &str = "gnomad_v4_variants";
pub const DEFAULT_GENES_INDEX: &str = "genes_grch38";

/// Region pagination size — matches prod's `pageSize`/`size: 10000`.
const SCROLL_PAGE_SIZE: i64 = 10_000;
/// Scroll context keep-alive — matches prod's `'30s'` default in `fetchAllSearchResults`.
const SCROLL_KEEPALIVE: &str = "30s";

/// `_source` projection for region/gene variant queries.
///
/// Mirrors `getMultiVariantSourceFields(exomeSubset='all', genomeSubset='all',
/// jointSubset='all')` in `gnomad-v4-variant-queries.ts`. Restricting `_source`
/// the same way prod does keeps the bytes ES must fetch/decompress identical to
/// prod — important for the schema-width dimension.
fn region_source_fields() -> Vec<&'static str> {
    vec![
        "value.exome.freq.all",
        "value.genome.freq.all",
        "value.joint.freq.all",
        "value.exome.filters",
        "value.exome.flags",
        "value.exome.fafmax",
        "value.genome.filters",
        "value.genome.flags",
        "value.joint.filters",
        "value.alleles",
        "value.locus",
        "value.flags",
        "value.rsids",
        "value.transcript_consequences",
        "value.variant_id",
        "value.joint.fafmax",
        "value.in_silico_predictors",
    ]
}

/// Elasticsearch backend querying the prod-shaped variant index.
pub struct ElasticsearchBackend {
    client: Elasticsearch,
    variants_index: String,
    genes_index: String,
}

impl ElasticsearchBackend {
    /// Create a new Elasticsearch backend.
    ///
    /// `url` is a node URL, e.g. `http://localhost:9200`. Construction is
    /// synchronous (matching the other backends' `new`); the transport opens
    /// connections lazily on first request.
    pub fn new(url: &str, variants_index: &str, genes_index: &str) -> Result<Self> {
        let transport = Transport::single_node(url)
            .with_context(|| format!("Failed to build Elasticsearch transport for {url}"))?;
        Ok(Self {
            client: Elasticsearch::new(transport),
            variants_index: variants_index.to_string(),
            genes_index: genes_index.to_string(),
        })
    }

    /// Region query returning the variants plus split timing.
    ///
    /// `db_query_ms` covers the full ES round-trip(s) — the initial search and
    /// every scroll page (query execution + `_source` transfer/decompression);
    /// `deserialize_ms` covers parsing each `_source.value` into `api::Variant`.
    async fn region_variants_timed(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
    ) -> Result<(Vec<Variant>, QueryStats)> {
        // Reproduces fetchVariantsByRegion's DSL. Note: prod's GraphQL receives a
        // bare chrom ("1") and prepends "chr"; our API already carries "chr1"
        // (same convention as duckdb/postgres `locus.contig = ?`), so we filter on
        // `chrom` verbatim.
        let query_body = json!({
            "query": {
                "bool": {
                    "filter": [
                        { "term": { "locus.contig": chrom } },
                        { "range": { "locus.position": { "gte": start, "lte": end } } }
                    ]
                }
            },
            "sort": [ { "locus.position": { "order": "asc" } } ],
            "_source": region_source_fields()
        });

        // --- DB work + per-page deserialize (fetchAllSearchResults) ---
        //
        // Memory-critical: prod genes can have 75k+ variants. Accumulating every
        // raw `_source` hit as `serde_json::Value` and *then* mapping would hold
        // hundreds of MB (multiplied several-fold by serde's in-memory blowup) all
        // at once -> Cloud Run OOM. Instead we map each scroll page to compact
        // `api::Variant` immediately and drop the heavy raw page before fetching the
        // next, so peak memory is ~one page (10k hits) of raw JSON, not all of it.
        //
        // Split timing is preserved: `deserialize_ms` sums the per-page map time and
        // `db_query_ms` is the remaining round-trip/scroll time (total minus deser).
        let t_total = Instant::now();
        let mut deserialize_ms: f64 = 0.0;

        let first = self
            .client
            .search(SearchParts::Index(&[&self.variants_index]))
            .scroll(SCROLL_KEEPALIVE)
            .size(SCROLL_PAGE_SIZE)
            .body(query_body)
            .send()
            .await
            .context("Elasticsearch region search failed")?;
        let mut first_body: Value = first
            .json()
            .await
            .context("Failed to read Elasticsearch region response")?;

        let total = first_body["hits"]["total"]["value"]
            .as_i64()
            .unwrap_or(0);
        let mut scroll_id = first_body["_scroll_id"].as_str().map(str::to_string);

        let mut variants: Vec<Variant> = Vec::with_capacity(total.max(0) as usize);

        // Map the first page, then let its raw `Value` array drop.
        {
            let page = take_hits(&mut first_body);
            let t_de = Instant::now();
            for hit in &page {
                variants.push(variant_from_data(None, hit_value(hit)?)?);
            }
            deserialize_ms += elapsed_ms(t_de);
        }

        // Page through with the scroll API until we've seen `total` hits.
        while (variants.len() as i64) < total {
            let Some(sid) = scroll_id.clone() else { break };
            let resp = self
                .client
                .scroll(ScrollParts::None)
                .body(json!({ "scroll": SCROLL_KEEPALIVE, "scroll_id": sid }))
                .send()
                .await
                .context("Elasticsearch scroll failed")?;
            let mut body: Value = resp
                .json()
                .await
                .context("Failed to read Elasticsearch scroll response")?;
            scroll_id = body["_scroll_id"].as_str().map(str::to_string);
            let page = take_hits(&mut body);
            if page.is_empty() {
                break;
            }
            // Map this page immediately; `page` (raw hits) drops at the loop end.
            let t_de = Instant::now();
            for hit in &page {
                variants.push(variant_from_data(None, hit_value(hit)?)?);
            }
            deserialize_ms += elapsed_ms(t_de);
        }

        // Free the scroll context (matches prod's clearScroll); best-effort.
        if let Some(sid) = scroll_id {
            let _ = self
                .client
                .clear_scroll(ClearScrollParts::None)
                .body(json!({ "scroll_id": [sid] }))
                .send()
                .await;
        }

        // db_query_ms = total elapsed minus the time spent mapping pages, so the
        // route's db-vs-deserialize split stays meaningful even though we interleave.
        let db_query_ms = (elapsed_ms(t_total) - deserialize_ms).max(0.0);

        Ok((
            variants,
            QueryStats {
                db_query_ms,
                deserialize_ms,
            },
        ))
    }

    /// Variant-by-id detail lookup returning the detail plus split timing.
    ///
    /// Reproduces `fetchVariantById`: `term variant_id`, `size 1`, full `_source`.
    async fn point_variant_detail_timed(
        &self,
        variant_id: &str,
    ) -> Result<(Option<VariantDetails>, QueryStats)> {
        let id_field = id_field_for(variant_id);
        let query_body = json!({
            "query": { "bool": { "filter": { "term": { id_field: variant_id } } } }
        });

        let t_db = Instant::now();
        let resp = self
            .client
            .search(SearchParts::Index(&[&self.variants_index]))
            .size(1)
            .body(query_body)
            .send()
            .await
            .context("Elasticsearch variant-detail search failed")?;
        let mut body: Value = resp
            .json()
            .await
            .context("Failed to read Elasticsearch variant-detail response")?;
        let db_query_ms = elapsed_ms(t_db);

        let t_de = Instant::now();
        let detail = match take_hits(&mut body).first() {
            Some(hit) => Some(variant_details_from_data(None, hit_value(hit)?)?),
            None => None,
        };
        let deserialize_ms = elapsed_ms(t_de);

        Ok((
            detail,
            QueryStats {
                db_query_ms,
                deserialize_ms,
            },
        ))
    }

    /// Run a single-hit gene search and build the API `Gene` from `_source.value`.
    async fn fetch_gene(&self, filter: Value) -> Result<Option<Gene>> {
        let resp = self
            .client
            .search(SearchParts::Index(&[&self.genes_index]))
            .size(1)
            .body(json!({ "query": { "bool": { "filter": filter } } }))
            .send()
            .await
            .context("Elasticsearch gene search failed")?;
        let mut body: Value = resp
            .json()
            .await
            .context("Failed to read Elasticsearch gene response")?;

        match take_hits(&mut body).first() {
            Some(hit) => Ok(Some(gene_from_value(hit_value(hit)?)?)),
            None => Ok(None),
        }
    }
}

#[async_trait]
impl VariantBackend for ElasticsearchBackend {
    async fn get_gene(&self, gene_id: &str) -> Result<Option<Gene>> {
        self.fetch_gene(json!({ "term": { "gene_id": gene_id } })).await
    }

    async fn get_gene_by_symbol(&self, symbol: &str) -> Result<Option<Gene>> {
        // Prod genes index indexes `symbol_upper_case` (see datasets_config.py).
        self.fetch_gene(json!({ "term": { "symbol_upper_case": symbol.to_uppercase() } }))
            .await
    }

    async fn search_genes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        // Prefix match on the indexed `search_terms` (matches the prod gene-search
        // `prefix: { search_terms: ... }`), reading identity fields from `value`.
        let resp = self
            .client
            .search(SearchParts::Index(&[&self.genes_index]))
            .size(limit as i64)
            .body(json!({
                "query": { "bool": { "filter": {
                    "prefix": { "search_terms": query.to_uppercase() }
                } } }
            }))
            .send()
            .await
            .context("Elasticsearch gene-search failed")?;
        let mut body: Value = resp
            .json()
            .await
            .context("Failed to read Elasticsearch gene-search response")?;

        let mut results = Vec::new();
        for hit in take_hits(&mut body) {
            let value = hit_value(&hit)?;
            let Some(gene_id) = json_str(value, &["gene_id"]) else {
                continue;
            };
            results.push(SearchResult {
                gene_id,
                gene_symbol: gene_symbol_of(value).unwrap_or_default(),
                chrom: json_str(value, &["chrom"]),
                start: value.get("start").and_then(Value::as_i64),
                stop: value.get("stop").and_then(Value::as_i64),
            });
        }
        Ok(results)
    }

    async fn get_variants(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        _force_fallback: bool,
    ) -> Result<Vec<Variant>> {
        let (variants, stats) = self.region_variants_timed(chrom, start, end).await?;
        tracing::debug!(
            chrom,
            start,
            end,
            n = variants.len(),
            db_query_ms = stats.db_query_ms,
            deserialize_ms = stats.deserialize_ms,
            "elasticsearch get_variants"
        );
        Ok(variants)
    }

    async fn get_variant_detail(
        &self,
        variant_id: &str,
        _force_fallback: bool,
    ) -> Result<Option<VariantDetails>> {
        let (detail, stats) = self.point_variant_detail_timed(variant_id).await?;
        tracing::debug!(
            variant_id,
            db_query_ms = stats.db_query_ms,
            deserialize_ms = stats.deserialize_ms,
            "elasticsearch get_variant_detail"
        );
        Ok(detail)
    }

    async fn get_variants_timed(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        _force_fallback: bool,
    ) -> Result<(Vec<Variant>, QueryStats)> {
        self.region_variants_timed(chrom, start, end).await
    }

    async fn get_variant_detail_timed(
        &self,
        variant_id: &str,
        _force_fallback: bool,
    ) -> Result<(Option<VariantDetails>, QueryStats)> {
        self.point_variant_detail_timed(variant_id).await
    }
}

// ==================== Response helpers ====================

fn elapsed_ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// Choose the term field for a variant-id lookup, mirroring prod's `chooseIdField`:
/// rsIDs match on `rsids`, everything else on `variant_id`. (VRS/`allele_id` is not
/// part of this backend's golden path.)
fn id_field_for(variant_id: &str) -> &'static str {
    let suffix = variant_id.strip_prefix("rs");
    match suffix {
        Some(digits) if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) => "rsids",
        _ => "variant_id",
    }
}

/// Move `hits.hits` out of an owned response body as `Vec<Value>` **without
/// cloning each hit**. The body is owned per-request, so we take the array out
/// (replacing it with `Null`) rather than deep-cloning via `.as_array().cloned()`
/// — that roughly halves per-page peak memory on large scroll pages.
fn take_hits(body: &mut Value) -> Vec<Value> {
    match body.get_mut("hits").and_then(|h| h.get_mut("hits")) {
        Some(hits) => match hits.take() {
            Value::Array(arr) => arr,
            _ => Vec::new(),
        },
        None => Vec::new(),
    }
}

/// Extract the stored source record from a hit: `hit._source.value` (prod wraps
/// the row under `value`), falling back to a bare `_source` for indices that don't
/// wrap (keeps the extractor robust to a simpler loader output).
fn hit_value(hit: &Value) -> Result<&Value> {
    let source = hit
        .get("_source")
        .ok_or_else(|| anyhow!("Elasticsearch hit missing _source"))?;
    Ok(source.get("value").unwrap_or(source))
}

/// Prefer `gencode_symbol` (duckdb/postgres convention), then prod's `symbol`.
fn gene_symbol_of(value: &Value) -> Option<String> {
    json_str(value, &["gencode_symbol"]).or_else(|| json_str(value, &["symbol"]))
}

/// Build the API `Gene` from a gene index `_source.value`, reusing `DuckDbGeneRow`
/// so transcripts-JSON parsing stays identical to the DuckDB / Postgres paths.
fn gene_from_value(value: &Value) -> Result<Gene> {
    let gene_id = json_str(value, &["gene_id"]).context("gene JSON missing gene_id")?;
    let chrom = json_str(value, &["chrom"]).context("gene JSON missing chrom")?;
    let start = value
        .get("start")
        .and_then(Value::as_i64)
        .context("gene JSON missing start")?;
    let stop = value
        .get("stop")
        .and_then(Value::as_i64)
        .context("gene JSON missing stop")?;

    let transcripts_json = value
        .get("transcripts")
        .filter(|v| !v.is_null())
        .map(serde_json::to_string)
        .transpose()
        .context("Failed to re-serialize gene transcripts")?;

    let db_row = DuckDbGeneRow {
        gene_id,
        gencode_symbol: gene_symbol_of(value),
        chrom,
        start,
        stop,
        strand: json_str(value, &["strand"]),
        canonical_transcript_id: json_str(value, &["canonical_transcript_id"]),
        transcripts_json,
    };
    db_row.to_api()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn id_field_distinguishes_rsids() {
        assert_eq!(id_field_for("rs12345"), "rsids");
        assert_eq!(id_field_for("1-55039847-G-A"), "variant_id");
        assert_eq!(id_field_for("rs"), "variant_id"); // no digits -> not an rsID
    }

    #[test]
    fn hit_value_unwraps_prod_value_wrapper() {
        let hit = json!({ "_source": { "value": { "variant_id": "1-1-A-C" } } });
        assert_eq!(hit_value(&hit).unwrap()["variant_id"], "1-1-A-C");
    }

    #[test]
    fn hit_value_falls_back_to_bare_source() {
        let hit = json!({ "_source": { "variant_id": "1-1-A-C" } });
        assert_eq!(hit_value(&hit).unwrap()["variant_id"], "1-1-A-C");
    }

    #[test]
    fn take_hits_handles_missing() {
        assert!(take_hits(&mut json!({})).is_empty());
        let mut body = json!({ "hits": { "hits": [ {"_id": "a"}, {"_id": "b"} ] } });
        let hits = take_hits(&mut body);
        assert_eq!(hits.len(), 2);
        // The array was moved out, leaving `hits.hits` null (no deep clone).
        assert!(body["hits"]["hits"].is_null());
    }

    #[test]
    fn gene_from_value_builds_api_gene() {
        let value = json!({
            "gene_id": "ENSG00000169174",
            "gencode_symbol": "PCSK9",
            "chrom": "chr1",
            "start": 55039447,
            "stop": 55064852,
            "strand": "+",
            "canonical_transcript_id": "ENST00000302118",
            "transcripts": [
                { "transcript_id": "ENST00000302118", "exons": [] }
            ]
        });
        let gene = gene_from_value(&value).unwrap();
        assert_eq!(gene.gene_id, "ENSG00000169174");
        assert_eq!(gene.gene_symbol.as_deref(), Some("PCSK9"));
        assert_eq!(gene.gencode_symbol.as_deref(), Some("PCSK9"));
        assert_eq!(gene.chrom, "chr1");
        assert_eq!(gene.start, 55039447);
        assert_eq!(gene.stop, 55064852);
        assert_eq!(gene.transcripts.as_ref().map(Vec::len), Some(1));
    }

    #[test]
    fn gene_from_value_prefers_gencode_then_symbol() {
        let value = json!({
            "gene_id": "ENSG0", "symbol": "FALLBACK",
            "chrom": "chr1", "start": 1, "stop": 2
        });
        let gene = gene_from_value(&value).unwrap();
        assert_eq!(gene.gene_symbol.as_deref(), Some("FALLBACK"));
    }

    #[test]
    fn region_source_fields_matches_prod_projection() {
        let fields = region_source_fields();
        // The exact set prod requests in getMultiVariantSourceFields.
        assert!(fields.contains(&"value.genome.freq.all"));
        assert!(fields.contains(&"value.locus"));
        assert!(fields.contains(&"value.transcript_consequences"));
        assert!(fields.contains(&"value.variant_id"));
        assert_eq!(fields.len(), 17);
    }
}
