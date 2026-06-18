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
use sqlx::PgPool;
use std::time::Instant;

use super::{QueryStats, VariantBackend};
use crate::models::api::{Gene, SearchResult, TranscriptConsequence, Variant, VariantDetails};
use crate::models::db::DuckDbGeneRow;

/// Postgres backend querying the JSONB wide-table via `sqlx`.
pub struct PostgresBackend {
    pool: PgPool,
}

impl PostgresBackend {
    /// Create a new Postgres backend.
    ///
    /// Uses `connect_lazy` so construction is synchronous (matching the other
    /// backends' `new`) — the pool establishes connections on first query.
    /// `database_url` is a standard libpq URL, e.g.
    /// `postgres://user:pass@localhost:5432/gnomad`.
    pub fn new(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(16)
            .connect_lazy(database_url)
            .context("Failed to create Postgres connection pool")?;
        Ok(Self { pool })
    }

    /// Region query returning the variants plus split timing.
    ///
    /// `db_query_ms` covers query execution + row transfer (the JSONB is cast to
    /// text in the DB, so de-TOAST cost is attributed to the database); the
    /// `deserialize_ms` covers parsing + mapping into `api::Variant`.
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

        let t_db = Instant::now();
        let rows: Vec<(Option<String>, String)> = sqlx::query_as(
            "SELECT variant_id, data::text \
             FROM variants \
             WHERE contig = $1 AND pos >= $2 AND pos <= $3 \
             ORDER BY pos",
        )
        .bind(chrom)
        .bind(start)
        .bind(end)
        .fetch_all(&self.pool)
        .await
        .context("Postgres region query failed")?;
        let db_query_ms = elapsed_ms(t_db);

        let t_de = Instant::now();
        let mut variants = Vec::with_capacity(rows.len());
        for (variant_id, data_text) in rows {
            let data: Value =
                serde_json::from_str(&data_text).context("Failed to parse variant JSONB")?;
            variants.push(variant_from_data(variant_id, &data)?);
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
    async fn point_variant_detail_timed(
        &self,
        variant_id: &str,
    ) -> Result<(Option<VariantDetails>, QueryStats)> {
        let t_db = Instant::now();
        let row: Option<(Option<String>, String)> = sqlx::query_as(
            "SELECT variant_id, data::text FROM variants WHERE variant_id = $1",
        )
        .bind(variant_id)
        .fetch_optional(&self.pool)
        .await
        .context("Postgres variant-detail query failed")?;
        let db_query_ms = elapsed_ms(t_db);

        let t_de = Instant::now();
        let detail = match row {
            Some((vid, data_text)) => {
                let data: Value = serde_json::from_str(&data_text)
                    .context("Failed to parse variant JSONB")?;
                Some(variant_details_from_data(vid, &data)?)
            }
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

/// Navigate a nested JSON object by key path, returning the leaf value.
fn json_path<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for key in path {
        cur = cur.get(key)?;
    }
    Some(cur)
}

fn json_i64(v: &Value, path: &[&str]) -> Option<i64> {
    json_path(v, path).and_then(Value::as_i64)
}

fn json_str(v: &Value, path: &[&str]) -> Option<String> {
    json_path(v, path)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// AC from `exome.freq.all.ac`, falling back to `genome.freq.all.ac` (mirrors
/// the COALESCE in `duckdb.rs` — gnomAD v4 records are unified).
fn coalesce_freq(data: &Value, field: &str) -> Option<i64> {
    json_i64(data, &["exome", "freq", "all", field])
        .or_else(|| json_i64(data, &["genome", "freq", "all", field]))
}

/// Build a list-view `Variant` from a stored source-shaped JSONB document.
fn variant_from_data(variant_id_col: Option<String>, data: &Value) -> Result<Variant> {
    let chrom = json_str(data, &["locus", "contig"])
        .or_else(|| json_str(data, &["chrom"]))
        .context("variant JSON missing locus.contig")?;
    let pos = json_i64(data, &["locus", "position"])
        .or_else(|| json_i64(data, &["pos"]))
        .context("variant JSON missing locus.position")?;

    let alleles: Vec<String> = json_path(data, &["alleles"])
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .context("Failed to parse alleles")?
        .unwrap_or_default();

    let rsids: Option<Vec<String>> = json_path(data, &["rsids"])
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .context("Failed to parse rsids")?;

    let ac = coalesce_freq(data, "ac").unwrap_or(0);
    let an = coalesce_freq(data, "an").unwrap_or(0);
    let af = if an > 0 { ac as f64 / an as f64 } else { 0.0 };

    // First transcript consequence supplies the summary fields (1st element,
    // matching duckdb's `transcript_consequences[1]`).
    let tc0 = json_path(data, &["transcript_consequences"])
        .and_then(|v| v.as_array())
        .and_then(|a| a.first());

    let variant_id = variant_id_col.or_else(|| json_str(data, &["variant_id"]));

    Ok(Variant {
        variant_id,
        pos,
        chrom,
        alleles,
        rsids,
        consequence: tc0.and_then(|tc| json_str(tc, &["major_consequence"])),
        hgvsc: tc0.and_then(|tc| json_str(tc, &["hgvsc"])),
        hgvsp: tc0.and_then(|tc| json_str(tc, &["hgvsp"])),
        gene_id: tc0.and_then(|tc| json_str(tc, &["gene_id"])),
        gene_symbol: tc0.and_then(|tc| json_str(tc, &["gene_symbol"])),
        transcript_id: tc0.and_then(|tc| json_str(tc, &["transcript_id"])),
        lof: tc0.and_then(|tc| json_str(tc, &["lof"])),
        ac,
        an,
        af,
        allele_freq: af,
    })
}

/// Build a full `VariantDetails` from a stored source-shaped JSONB document.
///
/// Mirrors `DuckDbVariantDetailRow::to_api` (`models/db.rs`): the deeply nested
/// `exome` / `genome` / `joint` / `coverage` / `in_silico_predictors` subtrees
/// are passed through as raw `Value`, while `transcript_consequences` is typed.
fn variant_details_from_data(
    variant_id_col: Option<String>,
    data: &Value,
) -> Result<VariantDetails> {
    let chrom = json_str(data, &["locus", "contig"])
        .or_else(|| json_str(data, &["chrom"]))
        .context("variant JSON missing locus.contig")?;
    let pos = json_i64(data, &["locus", "position"])
        .or_else(|| json_i64(data, &["pos"]))
        .context("variant JSON missing locus.position")?;

    let alleles: Vec<String> = json_path(data, &["alleles"])
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .context("Failed to parse alleles")?
        .unwrap_or_default();

    let rsids: Option<Vec<String>> = json_path(data, &["rsids"])
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .context("Failed to parse rsids")?;

    let take = |key: &str| -> Option<Value> {
        json_path(data, &[key]).filter(|v| !v.is_null()).cloned()
    };

    let transcript_consequences: Option<Vec<TranscriptConsequence>> =
        json_path(data, &["transcript_consequences"])
            .filter(|v| !v.is_null())
            .map(|v| serde_json::from_value(v.clone()))
            .transpose()
            .context("Failed to parse transcript_consequences")?;

    let first_tc = transcript_consequences.as_ref().and_then(|tcs| tcs.first());

    let ac = coalesce_freq(data, "ac").unwrap_or(0);
    let an = coalesce_freq(data, "an").unwrap_or(0);
    let af = if an > 0 { ac as f64 / an as f64 } else { 0.0 };

    Ok(VariantDetails {
        variant_id: variant_id_col.or_else(|| json_str(data, &["variant_id"])),
        pos,
        chrom,
        alleles,
        rsids,
        consequence: first_tc.map(|tc| tc.major_consequence.clone()),
        hgvsc: first_tc.and_then(|tc| tc.hgvsc.clone()),
        hgvsp: first_tc.and_then(|tc| tc.hgvsp.clone()),
        gene_id: first_tc.map(|tc| tc.gene_id.clone()),
        gene_symbol: first_tc.map(|tc| tc.gene_symbol.clone()),
        transcript_id: first_tc.map(|tc| tc.transcript_id.clone()),
        ac,
        an,
        af,
        allele_freq: af,
        caid: json_str(data, &["caid"]),
        exome: take("exome"),
        genome: take("genome"),
        joint: take("joint"),
        transcript_consequences,
        in_silico_predictors: take("in_silico_predictors"),
        coverage: take("coverage"),
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_variant_doc() -> Value {
        json!({
            "variant_id": "1-55039847-G-A",
            "locus": { "contig": "chr1", "position": 55039847 },
            "alleles": ["G", "A"],
            "rsids": ["rs12345"],
            "exome": { "freq": { "all": { "ac": 3, "an": 1000 } } },
            "genome": { "freq": { "all": { "ac": 9, "an": 2000 } } },
            "transcript_consequences": [
                {
                    "gene_id": "ENSG00000169174",
                    "gene_symbol": "PCSK9",
                    "transcript_id": "ENST00000302118",
                    "major_consequence": "missense_variant",
                    "hgvsc": "c.1A>G",
                    "hgvsp": "p.Met1Val",
                    "lof": null
                }
            ]
        })
    }

    #[test]
    fn variant_from_data_extracts_browser_fields() {
        let doc = sample_variant_doc();
        let v = variant_from_data(None, &doc).unwrap();
        assert_eq!(v.chrom, "chr1");
        assert_eq!(v.pos, 55039847);
        assert_eq!(v.alleles, vec!["G", "A"]);
        assert_eq!(v.variant_id.as_deref(), Some("1-55039847-G-A"));
        // exome.freq.all takes precedence over genome.freq.all
        assert_eq!(v.ac, 3);
        assert_eq!(v.an, 1000);
        assert!((v.af - 0.003).abs() < 1e-9);
        assert_eq!(v.consequence.as_deref(), Some("missense_variant"));
        assert_eq!(v.gene_symbol.as_deref(), Some("PCSK9"));
    }

    #[test]
    fn variant_from_data_falls_back_to_genome_freq() {
        let doc = json!({
            "locus": { "contig": "chr1", "position": 100 },
            "alleles": ["C", "T"],
            "genome": { "freq": { "all": { "ac": 5, "an": 500 } } }
        });
        let v = variant_from_data(Some("1-100-C-T".into()), &doc).unwrap();
        assert_eq!(v.ac, 5);
        assert_eq!(v.an, 500);
        assert_eq!(v.consequence, None);
    }

    #[test]
    fn variant_details_passes_through_nested() {
        let doc = sample_variant_doc();
        let d = variant_details_from_data(None, &doc).unwrap();
        assert_eq!(d.pos, 55039847);
        assert_eq!(d.ac, 3);
        assert!(d.exome.is_some());
        assert!(d.genome.is_some());
        assert_eq!(
            d.transcript_consequences.as_ref().map(Vec::len),
            Some(1)
        );
        assert_eq!(d.gene_symbol.as_deref(), Some("PCSK9"));
    }

    #[test]
    fn missing_locus_is_an_error() {
        let doc = json!({ "alleles": ["A", "C"] });
        assert!(variant_from_data(None, &doc).is_err());
    }
}
