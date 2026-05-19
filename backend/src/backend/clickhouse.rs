//! ClickHouse backend for production-scale gnomAD querying.
//!
//! Queries a ClickHouse instance over HTTP using the `clickhouse` crate.
//! Assumes the data has been loaded via `gbl load --target clickhouse` which
//! uses the staging→transform ETL pattern to flatten gnomAD's nested schema.

use anyhow::Result;
use async_trait::async_trait;
use clickhouse::Client;

use super::VariantBackend;
use crate::models::api::{Gene, SearchResult, Variant, VariantDetails};
use crate::models::clickhouse::{ChGeneRow, ChSearchRow, ChVariantDetailRow, ChVariantRow};

/// ClickHouse backend querying flattened gnomAD tables.
pub struct ClickHouseBackend {
    client: Client,
}

impl ClickHouseBackend {
    /// Create a new ClickHouse backend.
    ///
    /// - `url`: ClickHouse HTTP endpoint (e.g., `http://localhost:8123`)
    /// - `database`: ClickHouse database name (e.g., `gnomad`)
    pub fn new(url: &str, database: &str) -> Self {
        let client = Client::default()
            .with_url(url)
            .with_database(database);
        Self { client }
    }
}

#[async_trait]
impl VariantBackend for ClickHouseBackend {
    async fn get_gene(&self, gene_id: &str) -> Result<Option<Gene>> {
        let row = self
            .client
            .query(
                "SELECT gene_id, gencode_symbol, chrom, start, stop, strand, \
                 canonical_transcript_id, transcripts_json \
                 FROM genes WHERE gene_id = ?",
            )
            .bind(gene_id)
            .fetch_optional::<ChGeneRow>()
            .await?;

        match row {
            Some(r) => Ok(Some(r.to_api()?)),
            None => Ok(None),
        }
    }

    async fn get_gene_by_symbol(&self, symbol: &str) -> Result<Option<Gene>> {
        let row = self
            .client
            .query(
                "SELECT gene_id, gencode_symbol, chrom, start, stop, strand, \
                 canonical_transcript_id, transcripts_json \
                 FROM genes WHERE upper(gencode_symbol) = upper(?)",
            )
            .bind(symbol)
            .fetch_optional::<ChGeneRow>()
            .await?;

        match row {
            Some(r) => Ok(Some(r.to_api()?)),
            None => Ok(None),
        }
    }

    async fn search_genes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let pattern = format!("{}%", query);
        let rows = self
            .client
            .query(
                "SELECT gene_id, gencode_symbol AS gene_symbol, chrom, start, stop \
                 FROM genes \
                 WHERE upper(gencode_symbol) LIKE upper(?) \
                 LIMIT ?",
            )
            .bind(pattern.as_str())
            .bind(limit as u64)
            .fetch_all::<ChSearchRow>()
            .await?;

        Ok(rows.into_iter().map(|r| r.to_api()).collect())
    }

    async fn get_variants(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        _force_fallback: bool,
    ) -> Result<Vec<Variant>> {
        let rows = self
            .client
            .query(
                "SELECT chrom, pos, variant_id, alleles, rsids, \
                 ac, an, af, consequence, hgvsc, hgvsp, \
                 gene_id, gene_symbol, transcript_id, lof \
                 FROM variants \
                 WHERE chrom = ? AND pos >= ? AND pos <= ? \
                 ORDER BY pos",
            )
            .bind(chrom)
            .bind(start)
            .bind(end)
            .fetch_all::<ChVariantRow>()
            .await?;

        Ok(rows.into_iter().map(|r| r.to_api()).collect())
    }

    async fn get_variant_detail(
        &self,
        variant_id: &str,
        _force_fallback: bool,
    ) -> Result<Option<VariantDetails>> {
        let row = self
            .client
            .query(
                "SELECT chrom, pos, variant_id, alleles, rsids, caid, \
                 exome_json, genome_json, joint_json, \
                 transcript_consequences_json, in_silico_predictors_json, \
                 coverage_json \
                 FROM variants \
                 WHERE variant_id = ?",
            )
            .bind(variant_id)
            .fetch_optional::<ChVariantDetailRow>()
            .await?;

        match row {
            Some(r) => Ok(Some(r.to_api()?)),
            None => Ok(None),
        }
    }
}
