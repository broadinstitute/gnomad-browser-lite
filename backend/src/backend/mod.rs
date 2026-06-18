pub mod clickhouse;
pub mod duckdb;
pub mod hail;
pub mod postgres;
pub mod tiered;

use anyhow::Result;
use async_trait::async_trait;
use futures::stream::{self, BoxStream, StreamExt};
use serde::Serialize;

use crate::models::api::{Gene, SearchResult, Variant, VariantDetails};

/// Per-request split timing emitted by a backend.
///
/// The benchmark needs to separate raw datastore work (`db_query_ms`: query
/// execution + row transfer) from JSON deserialization (`deserialize_ms`:
/// turning the stored document into the API model). Without this split, Rust's
/// fast `serde_json` would mask the actual database latency — see DESIGN.md
/// "Confounder controls". Backends capture this internally and expose it via
/// `*_timed` methods; the trait methods themselves just log it.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct QueryStats {
    pub db_query_ms: f64,
    pub deserialize_ms: f64,
}

/// Trait defining the contract all data backends must fulfill.
///
/// Each method maps to a REST API endpoint. Implementations exist for
/// DuckDB (local Parquet), and will later include Hail (GCS direct),
/// ClickHouse (production SQL), and TieredBackend (fast + fallback).
#[async_trait]
pub trait VariantBackend: Send + Sync {
    /// Look up a gene by its Ensembl gene ID (e.g., "ENSG00000169174").
    async fn get_gene(&self, gene_id: &str) -> Result<Option<Gene>>;

    /// Look up a gene by its symbol (e.g., "PCSK9"). Case-insensitive.
    async fn get_gene_by_symbol(&self, symbol: &str) -> Result<Option<Gene>>;

    /// Search genes by symbol prefix. Returns up to `limit` results.
    async fn search_genes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>>;

    /// Get variants in a genomic region.
    /// `force_fallback` is reserved for TieredBackend — when true, skip the fast DB
    /// and query the slow-path backend directly.
    async fn get_variants(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        force_fallback: bool,
    ) -> Result<Vec<Variant>>;

    /// Get full variant details by variant ID (e.g., "1-55039447-G-A").
    /// `force_fallback` behaves the same as in `get_variants`.
    async fn get_variant_detail(
        &self,
        variant_id: &str,
        force_fallback: bool,
    ) -> Result<Option<VariantDetails>>;

    /// Stream variants in a genomic region as they are decoded.
    /// If `regions` is provided, only query those sub-regions (e.g., exon intervals).
    /// Default implementation calls `get_variants` and wraps the Vec into a stream.
    async fn stream_variants(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        regions: Option<&[(i64, i64)]>,
    ) -> Result<BoxStream<'static, Result<Variant>>> {
        let _ = regions; // default impl ignores regions, fetches full range
        let variants = self.get_variants(chrom, start, end, false).await?;
        Ok(stream::iter(variants.into_iter().map(Ok)).boxed())
    }

    /// Stream full variant details (no projection) for a genomic region.
    /// Used by background prefetch to populate the variant detail cache.
    /// Default implementation returns an empty stream.
    async fn stream_variant_details(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        regions: Option<&[(i64, i64)]>,
    ) -> Result<BoxStream<'static, Result<VariantDetails>>> {
        let _ = (chrom, start, end, regions);
        Ok(stream::empty().boxed())
    }
}
