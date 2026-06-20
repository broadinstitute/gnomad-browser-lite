//! ClickHouse backend for production-scale gnomAD querying.
//!
//! Queries a ClickHouse instance over HTTP using the `clickhouse` crate.
//!
//! The `variants` table carries the **native nested** gnomAD schema that
//! `genohype export clickhouse` writes directly (locus `Tuple(contig, position)`,
//! `exome`/`genome` structs, `transcript_consequences Array(Tuple(...))`) — the
//! same nested layout the DuckDB arm reads. No flatten/ETL step is required:
//! the nested columns are projected to the flat `api::Variant` shape **in SQL**
//! (mirroring `duckdb.rs`), so every arm returns the identical response. The
//! `genes` lookup table is the flat table produced by `genohype export
//! genes-clickhouse` (gene_id, gencode_symbol, …, transcripts_json).

use anyhow::Result;
use async_trait::async_trait;
use clickhouse::Client;
use std::time::Instant;

use super::{QueryStats, VariantBackend};
use crate::models::api::{Gene, SearchResult, Variant, VariantDetails};
use crate::models::clickhouse::{ChGeneRow, ChSearchRow, ChVariantDetailRow, ChVariantRow};

fn elapsed_ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

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
        force_fallback: bool,
    ) -> Result<Vec<Variant>> {
        let (variants, _stats) = self
            .get_variants_timed(chrom, start, end, force_fallback)
            .await?;
        Ok(variants)
    }

    /// Benchmarked region path with split timing. The `clickhouse` crate fuses
    /// network fetch + RowBinary decode in `fetch_all`, so that whole cost is
    /// attributed to `db_query_ms` (DB execution + row transfer + native decode);
    /// `deserialize_ms` covers the `ChVariantRow -> api::Variant` mapping.
    async fn get_variants_timed(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        _force_fallback: bool,
    ) -> Result<(Vec<Variant>, QueryStats)> {
        // Project the native nested schema down to the flat `api::Variant`
        // shape entirely in SQL (mirrors `duckdb.rs`). `locus` is a
        // Tuple(contig, position); `exome`/`genome.freq.all` carry ac/an;
        // `transcript_consequences[1]` is the lead consequence. `alleles`/`rsids`
        // are Array(Nullable(String)) in storage — drop NULLs so they decode into
        // the `Vec<String>` the row model expects.
        let t_db = Instant::now();
        let rows = self
            .client
            .query(
                "SELECT \
                   locus.1 AS chrom, \
                   toInt64(locus.2) AS pos, \
                   variant_id, \
                   arrayMap(x -> assumeNotNull(x), arrayFilter(x -> x IS NOT NULL, alleles)) AS alleles, \
                   arrayMap(x -> assumeNotNull(x), arrayFilter(x -> x IS NOT NULL, rsids)) AS rsids, \
                   toInt64(coalesce(exome.freq.`all`.ac, genome.freq.`all`.ac, 0)) AS ac, \
                   toInt64(coalesce(exome.freq.`all`.an, genome.freq.`all`.an, 0)) AS an, \
                   if(coalesce(exome.freq.`all`.an, genome.freq.`all`.an, 0) > 0, \
                      toFloat64(coalesce(exome.freq.`all`.ac, genome.freq.`all`.ac, 0)) \
                      / toFloat64(coalesce(exome.freq.`all`.an, genome.freq.`all`.an, 0)), 0.0) AS af, \
                   transcript_consequences[1].major_consequence AS consequence, \
                   transcript_consequences[1].hgvsc AS hgvsc, \
                   transcript_consequences[1].hgvsp AS hgvsp, \
                   transcript_consequences[1].gene_id AS gene_id, \
                   transcript_consequences[1].gene_symbol AS gene_symbol, \
                   transcript_consequences[1].transcript_id AS transcript_id, \
                   transcript_consequences[1].lof AS lof \
                 FROM variants \
                 WHERE locus.1 = ? AND locus.2 >= ? AND locus.2 <= ? \
                 ORDER BY locus.2",
            )
            .bind(chrom)
            .bind(start)
            .bind(end)
            .fetch_all::<ChVariantRow>()
            .await?;
        let db_query_ms = elapsed_ms(t_db);

        let t_de = Instant::now();
        let variants: Vec<Variant> = rows.into_iter().map(|r| r.to_api()).collect();
        let deserialize_ms = elapsed_ms(t_de);

        Ok((
            variants,
            QueryStats {
                db_query_ms,
                deserialize_ms,
            },
        ))
    }

    async fn get_variant_detail(
        &self,
        variant_id: &str,
        force_fallback: bool,
    ) -> Result<Option<VariantDetails>> {
        let (detail, _stats) = self
            .get_variant_detail_timed(variant_id, force_fallback)
            .await?;
        Ok(detail)
    }

    /// Variant-by-id detail with split timing. `db_query_ms` is the fused
    /// fetch+decode; `deserialize_ms` covers the JSON-string -> nested
    /// `api::VariantDetails` mapping in `ChVariantDetailRow::to_api`.
    async fn get_variant_detail_timed(
        &self,
        variant_id: &str,
        _force_fallback: bool,
    ) -> Result<(Option<VariantDetails>, QueryStats)> {
        // Flatten locus/alleles like the list query; serialize the deeply nested
        // structs to JSON strings with `toJSONString` so the row model can pass
        // them through to the frontend (matches duckdb.rs's `to_json(...)`).
        // Wrap in `toNullable` so the non-nullable `String` from `toJSONString`
        // matches the row model's `Option<String>` RowBinary decode.
        let t_db = Instant::now();
        let row = self
            .client
            .query(
                "SELECT \
                   locus.1 AS chrom, \
                   toInt64(locus.2) AS pos, \
                   variant_id, \
                   arrayMap(x -> assumeNotNull(x), arrayFilter(x -> x IS NOT NULL, alleles)) AS alleles, \
                   arrayMap(x -> assumeNotNull(x), arrayFilter(x -> x IS NOT NULL, rsids)) AS rsids, \
                   caid, \
                   toNullable(toJSONString(exome)) AS exome_json, \
                   toNullable(toJSONString(genome)) AS genome_json, \
                   toNullable(toJSONString(joint)) AS joint_json, \
                   toNullable(toJSONString(transcript_consequences)) AS transcript_consequences_json, \
                   toNullable(toJSONString(in_silico_predictors)) AS in_silico_predictors_json, \
                   toNullable(toJSONString(coverage)) AS coverage_json \
                 FROM variants \
                 WHERE variant_id = ?",
            )
            .bind(variant_id)
            .fetch_optional::<ChVariantDetailRow>()
            .await?;
        let db_query_ms = elapsed_ms(t_db);

        let t_de = Instant::now();
        let detail = match row {
            Some(r) => Some(r.to_api()?),
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
}
