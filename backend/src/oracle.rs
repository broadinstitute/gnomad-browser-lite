//! Result-equivalence oracle — the cross-cutting correctness backbone.
//!
//! Every benchmark arm must return *the same answer* for the same query; only
//! latency and cost may differ. This module defines a fixed golden set of
//! queries and a backend-agnostic comparison so any two `VariantBackend`s can be
//! asserted result-identical on a data subset (e.g. Postgres vs the DuckDB /
//! Hail reference). It is reused by later backends, loaders, and the workload
//! runner — a new arm is only admitted to the benchmark once it passes here.
//!
//! Comparison is done on a *normalized* projection of each result rather than on
//! the raw structs, because cosmetic differences (JSON key order in pass-through
//! `Value` subtrees, float formatting) are not semantic differences. We compare
//! the browser-visible fields that the API actually serves.
//!
//! ## Running against live backends
//!
//! The unit tests here run with no infrastructure (they exercise normalization
//! on in-memory fixtures). The full cross-backend check is an env-gated
//! integration test — set both to run it:
//!
//! ```bash
//! ORACLE_PG_URL=postgres://localhost/gnomad \
//! ORACLE_DUCKDB_DIR=/path/to/parquet/dir \
//! cargo test --package backend oracle_postgres_vs_duckdb -- --nocapture
//! ```

// The oracle is the reusable correctness backbone for the benchmark: its public
// API is exercised by the tests below and consumed by later phases (the workload
// runner, additional backends). In this binary crate those entry points read as
// "unused" outside `cfg(test)`, so silence dead-code here rather than scattering
// per-item allows.
#![allow(dead_code)]

use anyhow::{bail, Result};

use crate::backend::VariantBackend;
use crate::models::api::{Gene, Variant, VariantDetails};

/// A single golden query whose result must be identical across backends.
#[derive(Debug, Clone)]
pub enum OracleQuery {
    /// Variants overlapping a genomic region (region / gene-view access pattern).
    Variants {
        chrom: String,
        start: i64,
        end: i64,
    },
    /// Full detail for a single variant id (variant-by-id access pattern).
    VariantDetail { variant_id: String },
    /// Gene metadata by Ensembl gene id.
    Gene { gene_id: String },
}

/// The fixed golden set. Coordinates are GRCh38 (gnomAD v4). These live inside
/// the chr21+chr22 *and* the PCSK9 (chr1) subset used for the sizing probe, so
/// they resolve against the subset loaders.
///
/// Keep this list stable: it is the contract every arm is held to. Add to it,
/// don't reorder or mutate existing entries, so historical runs stay comparable.
pub fn golden_queries() -> Vec<OracleQuery> {
    vec![
        // PCSK9 gene body on chr1 (the human-gate spot-check gene).
        OracleQuery::Gene {
            gene_id: "ENSG00000169174".to_string(),
        },
        OracleQuery::Variants {
            chrom: "chr1".to_string(),
            start: 55_039_447,
            end: 55_064_852,
        },
        // A narrow window inside PCSK9 (exercises tight composite-index range).
        OracleQuery::Variants {
            chrom: "chr1".to_string(),
            start: 55_039_447,
            end: 55_040_000,
        },
        // A representative chr21 region (subset coverage).
        OracleQuery::Variants {
            chrom: "chr21".to_string(),
            start: 5_030_000,
            end: 5_040_000,
        },
        // A representative chr22 region (subset coverage).
        OracleQuery::Variants {
            chrom: "chr22".to_string(),
            start: 10_510_000,
            end: 10_520_000,
        },
        // A point lookup for a known PCSK9 variant — exercises the variant-by-id
        // (`get_variant_detail`) access pattern, so the detail path is asserted
        // for parity alongside the region scans. Falls inside the PCSK9 gene-body
        // golden region above, so it resolves against the subset loaders.
        OracleQuery::VariantDetail {
            variant_id: "1-55039847-G-A".to_string(),
        },
    ]
}

// ==================== Normalization ====================

/// Round a frequency to a fixed precision so float formatting differences across
/// backends don't read as semantic mismatches.
fn round_af(af: f64) -> i64 {
    (af * 1e9).round() as i64
}

/// Canonical one-line form of a list-view variant (browser-visible fields only).
fn norm_variant(v: &Variant) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
        v.chrom,
        v.pos,
        v.alleles.join(","),
        v.ac,
        v.an,
        round_af(v.af),
        v.consequence.as_deref().unwrap_or(""),
        v.gene_id.as_deref().unwrap_or(""),
        v.variant_id.as_deref().unwrap_or(""),
    )
}

/// Normalize a variant list into an order-independent, comparable vector.
pub fn normalize_variants(variants: &[Variant]) -> Vec<String> {
    let mut rows: Vec<String> = variants.iter().map(norm_variant).collect();
    rows.sort();
    rows
}

/// Canonical form of a variant detail (summary + cardinality of nested blocks;
/// we don't compare the deep pass-through `Value` subtrees byte-for-byte).
fn norm_variant_detail(d: &VariantDetails) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|tc={}|exome={}|genome={}",
        d.variant_id.as_deref().unwrap_or(""),
        d.chrom,
        d.pos,
        d.ac,
        d.an,
        round_af(d.af),
        d.consequence.as_deref().unwrap_or(""),
        d.transcript_consequences.as_ref().map_or(0, Vec::len),
        d.exome.is_some(),
        d.genome.is_some(),
    )
}

/// Canonical form of a gene (stable identity fields).
fn norm_gene(g: &Gene) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        g.gene_id,
        g.gene_symbol.as_deref().or(g.gencode_symbol.as_deref()).unwrap_or(""),
        g.chrom,
        g.start,
        g.stop,
    )
}

// ==================== Comparison ====================

/// Produce a short human-readable diff of two normalized row sets.
fn first_diff(a: &[String], b: &[String]) -> String {
    if a.len() != b.len() {
        let only_a = a.iter().filter(|x| !b.contains(x)).take(3).cloned().collect::<Vec<_>>();
        let only_b = b.iter().filter(|x| !a.contains(x)).take(3).cloned().collect::<Vec<_>>();
        return format!(
            "count {} vs {}; only-in-a(≤3)={:?}; only-in-b(≤3)={:?}",
            a.len(),
            b.len(),
            only_a,
            only_b
        );
    }
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        if x != y {
            return format!("row {i}: a={x:?} b={y:?}");
        }
    }
    "no difference".to_string()
}

/// Run one golden query against both backends and assert the normalized results
/// are identical. `a` is conventionally the system-under-test (e.g. Postgres),
/// `b` the reference (e.g. DuckDB / Hail).
pub async fn compare_query(
    a: &dyn VariantBackend,
    b: &dyn VariantBackend,
    query: &OracleQuery,
) -> Result<()> {
    match query {
        OracleQuery::Variants { chrom, start, end } => {
            let va = normalize_variants(&a.get_variants(chrom, *start, *end, false).await?);
            let vb = normalize_variants(&b.get_variants(chrom, *start, *end, false).await?);
            if va != vb {
                bail!(
                    "oracle mismatch on Variants({chrom}:{start}-{end}): {}",
                    first_diff(&va, &vb)
                );
            }
        }
        OracleQuery::VariantDetail { variant_id } => {
            let da = a.get_variant_detail(variant_id, false).await?;
            let db = b.get_variant_detail(variant_id, false).await?;
            let na = da.as_ref().map(norm_variant_detail);
            let nb = db.as_ref().map(norm_variant_detail);
            if na != nb {
                bail!("oracle mismatch on VariantDetail({variant_id}): a={na:?} b={nb:?}");
            }
        }
        OracleQuery::Gene { gene_id } => {
            let ga = a.get_gene(gene_id).await?;
            let gb = b.get_gene(gene_id).await?;
            let na = ga.as_ref().map(norm_gene);
            let nb = gb.as_ref().map(norm_gene);
            if na != nb {
                bail!("oracle mismatch on Gene({gene_id}): a={na:?} b={nb:?}");
            }
        }
    }
    Ok(())
}

/// Assert two backends are result-equivalent across the entire golden set.
pub async fn assert_equivalent(a: &dyn VariantBackend, b: &dyn VariantBackend) -> Result<()> {
    for query in golden_queries() {
        compare_query(a, b, &query).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::api::Variant;

    fn variant(chrom: &str, pos: i64, ac: i64, an: i64) -> Variant {
        let af = if an > 0 { ac as f64 / an as f64 } else { 0.0 };
        Variant {
            variant_id: Some(format!("{chrom}-{pos}-A-C")),
            pos,
            chrom: chrom.to_string(),
            alleles: vec!["A".into(), "C".into()],
            rsids: None,
            consequence: Some("missense_variant".into()),
            hgvsc: None,
            hgvsp: None,
            gene_id: Some("ENSG0".into()),
            gene_symbol: Some("FAKE".into()),
            transcript_id: None,
            lof: None,
            ac,
            an,
            af,
            allele_freq: af,
        }
    }

    #[test]
    fn golden_set_is_non_empty_and_stable() {
        let q = golden_queries();
        assert!(!q.is_empty());
        // The first entry is the PCSK9 gene — the human-gate spot-check anchor.
        match &q[0] {
            OracleQuery::Gene { gene_id } => assert_eq!(gene_id, "ENSG00000169174"),
            other => panic!("expected PCSK9 gene first, got {other:?}"),
        }
    }

    #[test]
    fn normalization_is_order_independent() {
        let a = vec![variant("chr1", 200, 1, 100), variant("chr1", 100, 2, 100)];
        let b = vec![variant("chr1", 100, 2, 100), variant("chr1", 200, 1, 100)];
        assert_eq!(normalize_variants(&a), normalize_variants(&b));
    }

    #[test]
    fn normalization_detects_value_differences() {
        let a = vec![variant("chr1", 100, 2, 100)];
        let b = vec![variant("chr1", 100, 3, 100)]; // different AC
        assert_ne!(normalize_variants(&a), normalize_variants(&b));
    }

    #[test]
    fn first_diff_reports_count_mismatch() {
        let a = normalize_variants(&[variant("chr1", 100, 1, 10)]);
        let b = normalize_variants(&[]);
        assert!(first_diff(&a, &b).contains("count 1 vs 0"));
    }

    /// Full cross-backend equivalence check. Skips (passes) when the two backends
    /// aren't configured via env, so `cargo test` is green without infra.
    #[tokio::test]
    async fn oracle_postgres_vs_duckdb() -> Result<()> {
        use crate::backend::duckdb::DuckDbBackend;
        use crate::backend::postgres::PostgresBackend;
        use std::path::Path;

        let (Ok(pg_url), Ok(duck_dir)) = (
            std::env::var("ORACLE_PG_URL"),
            std::env::var("ORACLE_DUCKDB_DIR"),
        ) else {
            eprintln!(
                "oracle_postgres_vs_duckdb: skipped (set ORACLE_PG_URL and ORACLE_DUCKDB_DIR to run)"
            );
            return Ok(());
        };

        let pg = PostgresBackend::new(&pg_url)?;
        let duck = DuckDbBackend::new(Path::new(&duck_dir))?;
        assert_equivalent(&pg, &duck).await
    }

    /// Full cross-backend equivalence check for the `es` arm. Skips (passes) when
    /// the backends aren't configured via env, so `cargo test` is green without
    /// infra. Run against a loaded ES (Phase 2a) + the DuckDB reference with:
    ///
    /// ```bash
    /// ORACLE_ES_URL=http://localhost:9200 \
    /// ORACLE_ES_VARIANTS_INDEX=gnomad_v4_variants \
    /// ORACLE_ES_GENES_INDEX=genes_grch38 \
    /// ORACLE_DUCKDB_DIR=/path/to/parquet/dir \
    /// cargo test --package backend oracle_elasticsearch_vs_duckdb -- --nocapture
    /// ```
    #[tokio::test]
    async fn oracle_elasticsearch_vs_duckdb() -> Result<()> {
        use crate::backend::duckdb::DuckDbBackend;
        use crate::backend::elasticsearch::{
            ElasticsearchBackend, DEFAULT_GENES_INDEX, DEFAULT_VARIANTS_INDEX,
        };
        use std::path::Path;

        let (Ok(es_url), Ok(duck_dir)) = (
            std::env::var("ORACLE_ES_URL"),
            std::env::var("ORACLE_DUCKDB_DIR"),
        ) else {
            eprintln!(
                "oracle_elasticsearch_vs_duckdb: skipped (set ORACLE_ES_URL and ORACLE_DUCKDB_DIR to run)"
            );
            return Ok(());
        };

        let variants_index = std::env::var("ORACLE_ES_VARIANTS_INDEX")
            .unwrap_or_else(|_| DEFAULT_VARIANTS_INDEX.to_string());
        let genes_index = std::env::var("ORACLE_ES_GENES_INDEX")
            .unwrap_or_else(|_| DEFAULT_GENES_INDEX.to_string());

        let es = ElasticsearchBackend::new(&es_url, &variants_index, &genes_index)?;
        let duck = DuckDbBackend::new(Path::new(&duck_dir))?;
        assert_equivalent(&es, &duck).await
    }
}
