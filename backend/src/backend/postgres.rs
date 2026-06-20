//! Postgres backend over a JSONB wide-table (benchmark arm `postgres`).
//!
//! This is the `postgres` arm of gnomad-bench. Variants live in one wide table
//! whose nested gnomAD record is stored as a single `JSONB` column; the browser
//! fields are extracted from that document in Rust after the row is fetched.
//! This keeps the *schema-width* benchmark dimension honest: `data` is the full
//! (or projected) document the store must de-TOAST on every read, exactly the
//! cost prod ES pays for `_source`.
//!
//! Expected schema (created by the Phase 2b loader, `genohype export postgres`):
//!
//! ```sql
//! CREATE TABLE variants (
//!     contig     TEXT,
//!     pos        INT,
//!     variant_id TEXT,
//!     ref        TEXT,
//!     alt        TEXT,
//!     data       JSONB
//! ) PARTITION BY LIST (contig);
//! -- composite B-tree drives region / gene scans (the index we benchmark):
//! CREATE INDEX variants_contig_pos_idx ON variants (contig, pos);
//! -- point lookups for variant-by-id:
//! CREATE INDEX variants_variant_id_idx ON variants (variant_id);
//!
//! CREATE TABLE genes (
//!     gene_id                 TEXT,
//!     gencode_symbol          TEXT,
//!     chrom                   TEXT,
//!     start                   INT,
//!     stop                    INT,
//!     strand                  TEXT,
//!     canonical_transcript_id TEXT,
//!     data                    JSONB   -- holds `transcripts` (+ anything else)
//! );
//! ```
//!
//! `variants.data` holds the *source* (Hail-shaped) variant record — the same
//! shape `duckdb.rs` reads — so the browser fields are extracted identically
//! (`locus.contig`, `locus.position`, `exome.freq.all.{ac,an}`,
//! `transcript_consequences[0]...`). Matching that extraction is what lets the
//! result-equivalence oracle (`crate::oracle`) assert byte-for-byte parity with
//! the DuckDB / Hail backends.

use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::types::Json;
use sqlx::PgPool;
use sqlx::Row;
use std::time::Instant;

use super::json_extract::variant_details_from_data;
use super::{QueryStats, VariantBackend};
use crate::models::api::{Gene, SearchResult, Variant, VariantDetails};
use crate::models::db::DuckDbGeneRow;

/// How `get_variants` projects the browser-list scalar fields out of the
/// Postgres `variants` table. Selects the two benchmark sub-arms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PgQueryMode {
    /// `postgres` arm: storage is the wide JSONB `data` document, but the
    /// browser-list scalars are extracted **in SQL** via JSONB path operators
    /// (`data->'locus'->>'contig'`, `(data->'exome'->'freq'->'all'->>'ac')`,
    /// `data->'transcript_consequences'->0->>'major_consequence'`, …). Postgres
    /// still de-TOASTs the whole `data` document to evaluate the paths (the
    /// honest document-store cost), but the API layer decodes typed scalar
    /// columns directly — no `data::text` round-trip and no full
    /// `serde_json::from_str` reparse of the ~25 KB blob in Rust.
    #[default]
    Jsonb,
    /// `postgres-typed` arm: the browser-minimal scalar leaves were
    /// materialized into STORED generated columns at load time, so the list
    /// query reads typed columns directly with zero JSONB extraction — what a
    /// competent Postgres deployment would do. The detail view still reads the
    /// full `data` JSONB.
    Typed,
}

/// Postgres backend querying the JSONB wide-table via `sqlx`.
pub struct PostgresBackend {
    pool: PgPool,
    query_mode: PgQueryMode,
}

/// A region-list row decoded straight from typed SQL columns.
///
/// Whether the scalars come from in-SQL JSONB extraction (`Jsonb` mode) or from
/// pre-materialized generated columns (`Typed` mode), the row shape is identical,
/// so a single decoder keeps both modes byte-for-byte equal to the DuckDB path.
struct PgVariantRow {
    variant_id: Option<String>,
    contig: Option<String>,
    pos: Option<i64>,
    alleles: Json<Vec<String>>,
    rsids: Option<Json<Vec<String>>>,
    ac: Option<i64>,
    an: Option<i64>,
    consequence: Option<String>,
    hgvsc: Option<String>,
    hgvsp: Option<String>,
    gene_id: Option<String>,
    gene_symbol: Option<String>,
    transcript_id: Option<String>,
    lof: Option<String>,
}

impl PgVariantRow {
    /// Map to `api::Variant`, mirroring `json_extract::variant_from_data` exactly
    /// (same coalesce/AF math, same null handling) so the equivalence oracle
    /// stays green.
    fn into_api(self) -> Result<Variant> {
        let chrom = self.contig.context("variant row missing locus.contig")?;
        let pos = self.pos.context("variant row missing locus.position")?;
        let ac = self.ac.unwrap_or(0);
        let an = self.an.unwrap_or(0);
        let af = if an > 0 { ac as f64 / an as f64 } else { 0.0 };
        Ok(Variant {
            variant_id: self.variant_id,
            pos,
            chrom,
            alleles: self.alleles.0,
            rsids: self.rsids.map(|r| r.0),
            consequence: self.consequence,
            hgvsc: self.hgvsc,
            hgvsp: self.hgvsp,
            gene_id: self.gene_id,
            gene_symbol: self.gene_symbol,
            transcript_id: self.transcript_id,
            lof: self.lof,
            ac,
            an,
            af,
            allele_freq: af,
        })
    }
}

impl PostgresBackend {
    /// Create a new Postgres backend (default `Jsonb` query mode).
    ///
    /// Uses `connect_lazy` so construction is synchronous (matching the other
    /// backends' `new`) — the pool establishes connections on first query.
    /// `database_url` is a standard libpq URL, e.g.
    /// `postgres://user:pass@localhost:5432/gnomad`.
    pub fn new(database_url: &str) -> Result<Self> {
        Self::new_with_mode(database_url, PgQueryMode::Jsonb)
    }

    /// Create a new Postgres backend with an explicit list-query projection mode.
    pub fn new_with_mode(database_url: &str, query_mode: PgQueryMode) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(16)
            .connect_lazy(database_url)
            .context("Failed to create Postgres connection pool")?;
        Ok(Self { pool, query_mode })
    }

    /// SELECT-list for the region query, per projection mode.
    ///
    /// Both modes return the *same* 14 columns in the same order/types, so the
    /// row decoder (`PgVariantRow`) is shared. `Jsonb` extracts the leaves from
    /// the `data` document with JSONB path operators (mirroring the json paths in
    /// `json_extract.rs`); `Typed` reads the pre-materialized generated columns.
    fn region_select_list(&self) -> &'static str {
        match self.query_mode {
            // NOTE: AC/AN COALESCE exome→genome exactly like
            // `json_extract::coalesce_freq` / duckdb's COALESCE. The first
            // transcript consequence (`->0`, the JSON array's element 0 = duckdb
            // `transcript_consequences[1]`) supplies the summary scalars.
            PgQueryMode::Jsonb => {
                "variant_id, \
                 data->'locus'->>'contig' AS contig, \
                 (data->'locus'->>'position')::bigint AS pos, \
                 COALESCE(data->'alleles', '[]'::jsonb) AS alleles, \
                 NULLIF(data->'rsids', 'null'::jsonb) AS rsids, \
                 COALESCE((data->'exome'->'freq'->'all'->>'ac')::bigint, \
                          (data->'genome'->'freq'->'all'->>'ac')::bigint) AS ac, \
                 COALESCE((data->'exome'->'freq'->'all'->>'an')::bigint, \
                          (data->'genome'->'freq'->'all'->>'an')::bigint) AS an, \
                 data->'transcript_consequences'->0->>'major_consequence' AS consequence, \
                 data->'transcript_consequences'->0->>'hgvsc' AS hgvsc, \
                 data->'transcript_consequences'->0->>'hgvsp' AS hgvsp, \
                 data->'transcript_consequences'->0->>'gene_id' AS gene_id, \
                 data->'transcript_consequences'->0->>'gene_symbol' AS gene_symbol, \
                 data->'transcript_consequences'->0->>'transcript_id' AS transcript_id, \
                 data->'transcript_consequences'->0->>'lof' AS lof"
            }
            // Typed: read the materialized generated columns directly (no JSONB
            // touch at all). `t_alleles`/`t_rsids` are jsonb generated columns so
            // the decoder's `Json<Vec<String>>` binding is unchanged.
            PgQueryMode::Typed => {
                "variant_id, \
                 t_contig AS contig, \
                 t_pos::bigint AS pos, \
                 COALESCE(t_alleles, '[]'::jsonb) AS alleles, \
                 t_rsids AS rsids, \
                 t_ac AS ac, \
                 t_an AS an, \
                 t_consequence AS consequence, \
                 t_hgvsc AS hgvsc, \
                 t_hgvsp AS hgvsp, \
                 t_gene_id AS gene_id, \
                 t_gene_symbol AS gene_symbol, \
                 t_transcript_id AS transcript_id, \
                 t_lof AS lof"
            }
        }
    }

    /// Region query returning the variants plus split timing.
    ///
    /// `db_query_ms` covers query execution + row transfer (the JSONB document is
    /// de-TOASTed in the DB to evaluate the scalar projections, so that cost is
    /// honestly attributed to the database); `deserialize_ms` covers decoding the
    /// already-typed sqlx columns into `api::Variant` — no full-blob reparse.
    async fn region_variants_timed(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
    ) -> Result<(Vec<Variant>, QueryStats)> {
        // `pos` is INT (int4) in the table; bind i32 so the planner uses the
        // (contig, pos) composite index instead of promoting the column to int8.
        let start = clamp_pos(start);
        let end = clamp_pos(end);

        let sql = format!(
            "SELECT {} FROM variants \
             WHERE contig = $1 AND pos >= $2 AND pos <= $3 \
             ORDER BY pos",
            self.region_select_list()
        );

        let t_db = Instant::now();
        let rows = sqlx::query(&sql)
            .bind(chrom)
            .bind(start)
            .bind(end)
            .fetch_all(&self.pool)
            .await
            .context("Postgres region query failed")?;
        let db_query_ms = elapsed_ms(t_db);

        let t_de = Instant::now();
        let mut variants = Vec::with_capacity(rows.len());
        for row in rows {
            let pg_row = PgVariantRow {
                variant_id: row.try_get("variant_id")?,
                contig: row.try_get("contig")?,
                pos: row.try_get("pos")?,
                alleles: row.try_get("alleles")?,
                rsids: row.try_get("rsids")?,
                ac: row.try_get("ac")?,
                an: row.try_get("an")?,
                consequence: row.try_get("consequence")?,
                hgvsc: row.try_get("hgvsc")?,
                hgvsp: row.try_get("hgvsp")?,
                gene_id: row.try_get("gene_id")?,
                gene_symbol: row.try_get("gene_symbol")?,
                transcript_id: row.try_get("transcript_id")?,
                lof: row.try_get("lof")?,
            };
            variants.push(pg_row.into_api()?);
        }
        let deserialize_ms = elapsed_ms(t_de);

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
    /// The detail view reads the full `data` JSONB in both modes (the nested
    /// exome/genome/joint/coverage subtrees are passed through wholesale), but we
    /// fetch the document as native `jsonb` and let sqlx hand us a parsed
    /// `serde_json::Value` rather than casting to `::text` and reparsing the blob
    /// ourselves.
    async fn point_variant_detail_timed(
        &self,
        variant_id: &str,
    ) -> Result<(Option<VariantDetails>, QueryStats)> {
        let t_db = Instant::now();
        let row: Option<(Option<String>, Json<Value>)> = sqlx::query_as(
            "SELECT variant_id, data FROM variants WHERE variant_id = $1",
        )
        .bind(variant_id)
        .fetch_optional(&self.pool)
        .await
        .context("Postgres variant-detail query failed")?;
        let db_query_ms = elapsed_ms(t_db);

        let t_de = Instant::now();
        let detail = match row {
            Some((vid, data)) => Some(variant_details_from_data(vid, &data.0)?),
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

#[async_trait]
impl VariantBackend for PostgresBackend {
    async fn get_gene(&self, gene_id: &str) -> Result<Option<Gene>> {
        let row: Option<(String, Option<String>, String, i32, i32, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as(
                "SELECT gene_id, gencode_symbol, chrom, start, stop, strand, \
                 canonical_transcript_id, (data->'transcripts')::text \
                 FROM genes WHERE gene_id = $1",
            )
            .bind(gene_id)
            .fetch_optional(&self.pool)
            .await
            .context("Postgres gene query failed")?;
        gene_row_to_api(row)
    }

    async fn get_gene_by_symbol(&self, symbol: &str) -> Result<Option<Gene>> {
        let row: Option<(String, Option<String>, String, i32, i32, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as(
                "SELECT gene_id, gencode_symbol, chrom, start, stop, strand, \
                 canonical_transcript_id, (data->'transcripts')::text \
                 FROM genes WHERE upper(gencode_symbol) = upper($1)",
            )
            .bind(symbol)
            .fetch_optional(&self.pool)
            .await
            .context("Postgres gene-by-symbol query failed")?;
        gene_row_to_api(row)
    }

    async fn search_genes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let pattern = format!("{}%", query);
        let rows: Vec<(String, String, Option<String>, Option<i32>, Option<i32>)> = sqlx::query_as(
            "SELECT gene_id, gencode_symbol, chrom, start, stop \
             FROM genes \
             WHERE upper(gencode_symbol) LIKE upper($1) \
             LIMIT $2",
        )
        .bind(pattern)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .context("Postgres gene-search query failed")?;

        Ok(rows
            .into_iter()
            .map(|(gene_id, gene_symbol, chrom, start, stop)| SearchResult {
                gene_id,
                gene_symbol,
                chrom,
                start: start.map(i64::from),
                stop: stop.map(i64::from),
            })
            .collect())
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
            "postgres get_variants"
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
            "postgres get_variant_detail"
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

// ==================== JSON extraction helpers ====================

fn elapsed_ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// gnomAD positions are positive and well within i32; clamp defensively so an
/// out-of-range query degrades to an empty result rather than panicking.
fn clamp_pos(p: i64) -> i32 {
    p.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

type GeneRowTuple = (
    String,
    Option<String>,
    String,
    i32,
    i32,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Convert a fetched gene row into the API `Gene`, reusing `DuckDbGeneRow` so the
/// transcripts-JSON parsing stays identical to the DuckDB path.
fn gene_row_to_api(row: Option<GeneRowTuple>) -> Result<Option<Gene>> {
    let Some((gene_id, gencode_symbol, chrom, start, stop, strand, canonical, transcripts_json)) =
        row
    else {
        return Ok(None);
    };

    let db_row = DuckDbGeneRow {
        gene_id,
        gencode_symbol,
        chrom,
        start: i64::from(start),
        stop: i64::from(stop),
        strand,
        canonical_transcript_id: canonical,
        transcripts_json,
    };
    Ok(Some(db_row.to_api()?))
}
