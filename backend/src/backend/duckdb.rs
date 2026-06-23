use anyhow::{Context, Result};
use async_trait::async_trait;
use duckdb::{params, Connection};
use std::path::Path;
use std::sync::{Arc, Mutex};

use super::xpos::{compute_xpos, variant_id_to_xpos};
use super::VariantBackend;
use crate::models::api::{Gene, SearchResult, Variant, VariantDetails};
use crate::models::db::{DuckDbGeneRow, DuckDbVariantDetailRow, DuckDbVariantRow};

/// DuckDB backend reading from local Parquet files via SQL views.
pub struct DuckDbBackend {
    conn: Arc<Mutex<Connection>>,
}

impl DuckDbBackend {
    /// Create a new DuckDB backend with in-memory connection and register Parquet views.
    pub fn new(data_dir: &Path) -> Result<Self> {
        let conn = Connection::open_in_memory()
            .context("Failed to open in-memory DuckDB connection")?;

        let variants_path = data_dir.join("variants.parquet");
        let genes_path = data_dir.join("genes.parquet");

        if variants_path.exists() {
            let sql = format!(
                "CREATE OR REPLACE VIEW variants AS SELECT * FROM '{}'",
                variants_path.display()
            );
            conn.execute(&sql, [])
                .context("Failed to create variants view")?;
            tracing::info!("Registered variants view from {}", variants_path.display());
        } else {
            tracing::warn!("Variants parquet not found at {}", variants_path.display());
        }

        if genes_path.exists() {
            let sql = format!(
                "CREATE OR REPLACE VIEW genes AS SELECT * FROM '{}'",
                genes_path.display()
            );
            conn.execute(&sql, [])
                .context("Failed to create genes view")?;
            tracing::info!("Registered genes view from {}", genes_path.display());
        } else {
            tracing::warn!("Genes parquet not found at {}", genes_path.display());
        }

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Get schema information for a table (debugging).
    pub fn get_schema(&self, table: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("DESCRIBE {}", table);
        let mut stmt = conn.prepare(&sql).context("Failed to prepare describe query")?;
        let mut rows = stmt.query([]).context("Failed to execute describe")?;

        let mut schema = Vec::new();
        while let Some(row) = rows.next().context("Failed to fetch schema row")? {
            let name: String = row.get(0)?;
            let dtype: String = row.get(1)?;
            schema.push((name, dtype));
        }
        Ok(schema)
    }
}

/// Extract a gene row from DuckDB query result.
fn extract_gene_row(row: &duckdb::Row<'_>) -> duckdb::Result<DuckDbGeneRow> {
    Ok(DuckDbGeneRow {
        gene_id: row.get("gene_id")?,
        gencode_symbol: row.get("gencode_symbol").ok(),
        chrom: row.get("chrom")?,
        start: row.get("start")?,
        stop: row.get("stop")?,
        strand: row.get("strand").ok(),
        canonical_transcript_id: row.get("canonical_transcript_id").ok(),
        transcripts_json: row.get("transcripts").ok(),
    })
}

const GENE_SELECT: &str = r#"
    SELECT gene_id, gencode_symbol, chrom, start, stop, strand,
           canonical_transcript_id, to_json(transcripts) AS transcripts
    FROM genes
"#;

#[async_trait]
impl VariantBackend for DuckDbBackend {
    async fn get_gene(&self, gene_id: &str) -> Result<Option<Gene>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE gene_id = ?", GENE_SELECT);
        let mut stmt = conn.prepare(&sql).context("Failed to prepare gene query")?;

        let result = stmt.query_row(params![gene_id], |row| extract_gene_row(row));

        match result {
            Ok(db_row) => Ok(Some(db_row.to_api()?)),
            Err(duckdb::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("Gene query error: {}", e)),
        }
    }

    async fn get_gene_by_symbol(&self, symbol: &str) -> Result<Option<Gene>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE UPPER(gencode_symbol) = UPPER(?)", GENE_SELECT);
        let mut stmt = conn.prepare(&sql).context("Failed to prepare gene symbol query")?;

        let result = stmt.query_row(params![symbol], |row| extract_gene_row(row));

        match result {
            Ok(db_row) => Ok(Some(db_row.to_api()?)),
            Err(duckdb::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("Gene symbol query error: {}", e)),
        }
    }

    async fn search_genes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let conn = self.conn.lock().unwrap();
        let sql = r#"
            SELECT gene_id, gencode_symbol AS gene_symbol, chrom, start, stop
            FROM genes
            WHERE UPPER(gencode_symbol) LIKE UPPER(? || '%')
            LIMIT ?
        "#;

        let mut stmt = conn.prepare(sql).context("Failed to prepare search query")?;
        let mut rows = stmt
            .query(params![query, limit as i64])
            .context("Failed to execute search query")?;

        let mut results = Vec::new();
        while let Some(row) = rows.next().context("Failed to fetch row")? {
            results.push(SearchResult {
                gene_id: row.get("gene_id")?,
                gene_symbol: row.get("gene_symbol")?,
                chrom: row.get("chrom").ok(),
                start: row.get("start").ok(),
                stop: row.get("stop").ok(),
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
        let conn = self.conn.lock().unwrap();

        // Range-prune on the materialized `xpos` column (the parquet is sorted by
        // xpos, so DuckDB's zonemaps skip row-groups). `xpos` encodes the contig
        // (X=23/Y=24/M=25/autosome=number), so a single [start_xpos, end_xpos]
        // window is exactly the `chrom:start-end` region.
        let xpos_start = compute_xpos(chrom, start);
        let xpos_end = compute_xpos(chrom, end);

        let sql = r#"
            SELECT
                locus.contig AS chrom,
                locus.position AS pos,
                to_json(alleles) AS alleles,
                to_json(rsids) AS rsids,
                COALESCE(exome.freq."all".ac, genome.freq."all".ac, 0) AS ac,
                COALESCE(exome.freq."all".an, genome.freq."all".an, 0) AS an,
                CASE
                    WHEN COALESCE(exome.freq."all".an, genome.freq."all".an, 0) > 0 THEN
                        CAST(COALESCE(exome.freq."all".ac, genome.freq."all".ac, 0) AS DOUBLE) /
                        CAST(COALESCE(exome.freq."all".an, genome.freq."all".an, 0) AS DOUBLE)
                    ELSE 0.0
                END AS af,
                variant_id,
                transcript_consequences[1].major_consequence AS consequence,
                transcript_consequences[1].hgvsc AS hgvsc,
                transcript_consequences[1].hgvsp AS hgvsp,
                transcript_consequences[1].gene_id AS gene_id,
                transcript_consequences[1].gene_symbol AS gene_symbol,
                transcript_consequences[1].transcript_id AS transcript_id,
                transcript_consequences[1].lof AS lof
            FROM variants
            WHERE xpos >= ?
            AND xpos <= ?
            ORDER BY xpos
        "#;

        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => {
                // Fallback: try flat column names (still xpos-ranged).
                let fallback_sql = r#"
                    SELECT
                        contig AS chrom,
                        position AS pos,
                        to_json(alleles) AS alleles,
                        to_json(rsids) AS rsids,
                        COALESCE(ac, 0) AS ac,
                        COALESCE(an, 0) AS an,
                        CASE WHEN COALESCE(an, 0) > 0
                            THEN CAST(COALESCE(ac, 0) AS DOUBLE) / CAST(an AS DOUBLE)
                            ELSE 0.0
                        END AS af,
                        variant_id,
                        NULL AS consequence,
                        NULL AS hgvsc,
                        NULL AS hgvsp,
                        NULL AS gene_id,
                        NULL AS gene_symbol,
                        NULL AS transcript_id,
                        NULL AS lof
                    FROM variants
                    WHERE xpos >= ?
                    AND xpos <= ?
                    ORDER BY xpos
                "#;
                conn.prepare(fallback_sql)
                    .context("Failed to prepare variants query")?
            }
        };

        let mut rows = stmt
            .query(params![xpos_start, xpos_end])
            .context("Failed to execute variants query")?;

        let mut results = Vec::new();
        while let Some(row) = rows.next().context("Failed to fetch row")? {
            let db_row = DuckDbVariantRow {
                variant_id: row.get("variant_id").ok(),
                chrom: row.get("chrom")?,
                pos: row.get("pos")?,
                alleles_json: row.get("alleles")?,
                rsids_json: row.get("rsids").ok(),
                ac: row.get("ac")?,
                an: row.get("an")?,
                af: row.get("af")?,
                consequence: row.get("consequence").ok(),
                hgvsc: row.get("hgvsc").ok(),
                hgvsp: row.get("hgvsp").ok(),
                gene_id: row.get("gene_id").ok(),
                gene_symbol: row.get("gene_symbol").ok(),
                transcript_id: row.get("transcript_id").ok(),
                lof: row.get("lof").ok(),
            };
            results.push(db_row.to_api()?);
        }
        Ok(results)
    }

    async fn get_variant_detail(
        &self,
        variant_id: &str,
        _force_fallback: bool,
    ) -> Result<Option<VariantDetails>> {
        let conn = self.conn.lock().unwrap();

        // Point lookup: add an `xpos = ?` equality (derived from the variant_id)
        // so the xpos-sorted parquet's zonemaps prune to the one row-group for
        // that locus instead of scanning every group for `variant_id`. Keep
        // `variant_id = ?` for exactness. If the id can't be parsed, fall back to
        // the variant_id-only lookup so results are unchanged.
        let xpos = variant_id_to_xpos(variant_id).ok();

        let sql = r#"
            SELECT
                variant_id,
                locus.contig AS chrom,
                locus.position AS pos,
                to_json(alleles) AS alleles,
                to_json(rsids) AS rsids,
                caid,
                to_json(exome) AS exome,
                to_json(genome) AS genome,
                to_json(transcript_consequences) AS transcript_consequences,
                to_json(in_silico_predictors) AS in_silico_predictors,
                to_json(joint) AS joint,
                to_json(coverage) AS coverage
            FROM variants
            WHERE xpos = ? AND variant_id = ?
        "#;
        let sql_fallback = r#"
            SELECT
                variant_id,
                locus.contig AS chrom,
                locus.position AS pos,
                to_json(alleles) AS alleles,
                to_json(rsids) AS rsids,
                caid,
                to_json(exome) AS exome,
                to_json(genome) AS genome,
                to_json(transcript_consequences) AS transcript_consequences,
                to_json(in_silico_predictors) AS in_silico_predictors,
                to_json(joint) AS joint,
                to_json(coverage) AS coverage
            FROM variants
            WHERE variant_id = ?
        "#;

        let mut stmt = conn
            .prepare(if xpos.is_some() { sql } else { sql_fallback })
            .context("Failed to prepare variant detail query")?;

        let extract = |row: &duckdb::Row<'_>| -> duckdb::Result<DuckDbVariantDetailRow> {
            Ok(DuckDbVariantDetailRow {
                variant_id: row.get("variant_id").ok(),
                chrom: row.get("chrom")?,
                pos: row.get("pos")?,
                alleles_json: row.get("alleles")?,
                rsids_json: row.get("rsids").ok(),
                caid: row.get("caid").ok(),
                exome_json: row.get("exome").ok(),
                genome_json: row.get("genome").ok(),
                joint_json: row.get("joint").ok(),
                transcript_consequences_json: row.get("transcript_consequences").ok(),
                in_silico_predictors_json: row.get("in_silico_predictors").ok(),
                coverage_json: row.get("coverage").ok(),
            })
        };

        let result = match xpos {
            Some(x) => stmt.query_row(params![x, variant_id], extract),
            None => stmt.query_row(params![variant_id], extract),
        };

        match result {
            Ok(db_row) => Ok(Some(db_row.to_api()?)),
            Err(duckdb::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("Variant detail query error: {}", e)),
        }
    }
}
