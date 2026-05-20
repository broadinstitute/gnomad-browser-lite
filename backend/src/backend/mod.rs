pub mod clickhouse;
pub mod duckdb;
pub mod hail;
pub mod tiered;

use anyhow::Result;
use async_trait::async_trait;
use futures::stream::{self, BoxStream, StreamExt};

use crate::models::api::{Gene, SearchResult, Variant, VariantDetails};

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
    /// Default implementation calls `get_variants` and wraps the Vec into a stream.
    async fn stream_variants(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
    ) -> Result<BoxStream<'static, Result<Variant>>> {
        let variants = self.get_variants(chrom, start, end, false).await?;
        Ok(stream::iter(variants.into_iter().map(Ok)).boxed())
    }
}
