use anyhow::Result;
use async_trait::async_trait;
use tracing::debug;

use super::VariantBackend;
use crate::models::api::{Gene, SearchResult, Variant, VariantDetails};

/// Two-tier backend: attempts the fast path first, falls back to the slow path
/// if results are empty or if `force_fallback` is set.
///
/// Mirrors the axaou-rust pattern where ClickHouse serves hot-path queries
/// and Hail direct provides full coverage for the long tail.
pub struct TieredBackend {
    pub fast: Box<dyn VariantBackend>,
    pub fallback: Box<dyn VariantBackend>,
}

#[async_trait]
impl VariantBackend for TieredBackend {
    async fn get_gene(&self, gene_id: &str) -> Result<Option<Gene>> {
        match self.fast.get_gene(gene_id).await {
            Ok(Some(gene)) => Ok(Some(gene)),
            Ok(None) => {
                debug!("gene {} not in fast backend, falling back", gene_id);
                self.fallback.get_gene(gene_id).await
            }
            Err(e) => {
                debug!("fast backend error for gene {}: {}, falling back", gene_id, e);
                self.fallback.get_gene(gene_id).await
            }
        }
    }

    async fn get_gene_by_symbol(&self, symbol: &str) -> Result<Option<Gene>> {
        match self.fast.get_gene_by_symbol(symbol).await {
            Ok(Some(gene)) => Ok(Some(gene)),
            Ok(None) => {
                debug!("gene symbol {} not in fast backend, falling back", symbol);
                self.fallback.get_gene_by_symbol(symbol).await
            }
            Err(e) => {
                debug!("fast backend error for symbol {}: {}, falling back", symbol, e);
                self.fallback.get_gene_by_symbol(symbol).await
            }
        }
    }

    async fn search_genes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        match self.fast.search_genes(query, limit).await {
            Ok(results) if !results.is_empty() => Ok(results),
            Ok(_) => {
                debug!("search '{}' empty in fast backend, falling back", query);
                self.fallback.search_genes(query, limit).await
            }
            Err(e) => {
                debug!("fast backend error for search '{}': {}, falling back", query, e);
                self.fallback.search_genes(query, limit).await
            }
        }
    }

    async fn get_variants(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        force_fallback: bool,
    ) -> Result<Vec<Variant>> {
        if force_fallback {
            debug!("force_fallback set, bypassing fast backend for {}:{}-{}", chrom, start, end);
            return self.fallback.get_variants(chrom, start, end, false).await;
        }

        match self.fast.get_variants(chrom, start, end, false).await {
            Ok(variants) if !variants.is_empty() => Ok(variants),
            Ok(_) => {
                debug!("no variants in fast backend for {}:{}-{}, falling back", chrom, start, end);
                self.fallback.get_variants(chrom, start, end, false).await
            }
            Err(e) => {
                debug!("fast backend error for {}:{}-{}: {}, falling back", chrom, start, end, e);
                self.fallback.get_variants(chrom, start, end, false).await
            }
        }
    }

    async fn get_variant_detail(
        &self,
        variant_id: &str,
        force_fallback: bool,
    ) -> Result<Option<VariantDetails>> {
        if force_fallback {
            debug!("force_fallback set, bypassing fast backend for variant {}", variant_id);
            return self.fallback.get_variant_detail(variant_id, false).await;
        }

        match self.fast.get_variant_detail(variant_id, false).await {
            Ok(Some(detail)) => Ok(Some(detail)),
            Ok(None) => {
                debug!("variant {} not in fast backend, falling back", variant_id);
                self.fallback.get_variant_detail(variant_id, false).await
            }
            Err(e) => {
                debug!("fast backend error for variant {}: {}, falling back", variant_id, e);
                self.fallback.get_variant_detail(variant_id, false).await
            }
        }
    }
}
