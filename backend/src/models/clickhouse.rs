//! ClickHouse row models for gnomAD data
//!
//! These structs map to ClickHouse table schemas after the staging→transform ETL.
//! The gnomAD nested schema is flattened for ClickHouse performance. Each struct
//! derives `clickhouse::Row` for native deserialization and implements `.to_api()`
//! to reconstruct the nested API models expected by the frontend.

use anyhow::{Context, Result};
use clickhouse::Row;
use serde::Deserialize;

use super::api;

/// Flattened gene row from the `genes` ClickHouse table.
#[derive(Debug, Clone, Deserialize, Row)]
pub struct ChGeneRow {
    pub gene_id: String,
    pub gencode_symbol: Option<String>,
    pub chrom: String,
    pub start: i64,
    pub stop: i64,
    pub strand: Option<String>,
    pub canonical_transcript_id: Option<String>,
    /// Transcripts stored as JSON string in ClickHouse
    pub transcripts_json: Option<String>,
}

impl ChGeneRow {
    pub fn to_api(self) -> Result<api::Gene> {
        let transcripts: Option<Vec<api::Transcript>> = self
            .transcripts_json
            .as_deref()
            .filter(|s| !s.is_empty() && *s != "null" && *s != "[]")
            .map(|s| serde_json::from_str(s))
            .transpose()
            .context("Failed to parse transcripts JSON")?;

        Ok(api::Gene {
            gene_id: self.gene_id,
            gene_symbol: self.gencode_symbol.clone(),
            gencode_symbol: self.gencode_symbol,
            chrom: self.chrom,
            start: self.start,
            stop: self.stop,
            strand: self.strand,
            canonical_transcript_id: self.canonical_transcript_id,
            transcripts,
            exons: None,
        })
    }
}

/// Flattened variant row from the `variants` ClickHouse table (list view).
///
/// Only lightweight fields needed for the variant table/list display.
/// The ETL flattens `transcript_consequences[canonical]` and `exome.freq.all`
/// into top-level columns.
#[derive(Debug, Clone, Deserialize, Row)]
pub struct ChVariantRow {
    pub chrom: String,
    pub pos: i64,
    pub variant_id: Option<String>,
    pub alleles: Vec<String>,
    pub rsids: Vec<String>,
    pub ac: i64,
    pub an: i64,
    pub af: f64,
    pub consequence: Option<String>,
    pub hgvsc: Option<String>,
    pub hgvsp: Option<String>,
    pub gene_id: Option<String>,
    pub gene_symbol: Option<String>,
    pub transcript_id: Option<String>,
    pub lof: Option<String>,
}

impl ChVariantRow {
    pub fn to_api(self) -> api::Variant {
        let rsids = if self.rsids.is_empty() {
            None
        } else {
            Some(self.rsids)
        };

        api::Variant {
            variant_id: self.variant_id,
            pos: self.pos,
            chrom: self.chrom,
            alleles: self.alleles,
            rsids,
            consequence: self.consequence,
            hgvsc: self.hgvsc,
            hgvsp: self.hgvsp,
            gene_id: self.gene_id,
            gene_symbol: self.gene_symbol,
            transcript_id: self.transcript_id,
            lof: self.lof,
            ac: self.ac,
            an: self.an,
            af: self.af,
            allele_freq: self.af,
        }
    }
}

/// Full variant detail row from ClickHouse.
///
/// Deeply nested structures (exome, genome, joint, coverage, in_silico_predictors)
/// are stored as JSON strings in ClickHouse and passed through to the frontend.
#[derive(Debug, Clone, Deserialize, Row)]
pub struct ChVariantDetailRow {
    pub chrom: String,
    pub pos: i64,
    pub variant_id: Option<String>,
    pub alleles: Vec<String>,
    pub rsids: Vec<String>,
    pub caid: Option<String>,
    pub exome_json: Option<String>,
    pub genome_json: Option<String>,
    pub joint_json: Option<String>,
    pub transcript_consequences_json: Option<String>,
    pub in_silico_predictors_json: Option<String>,
    pub coverage_json: Option<String>,
}

/// Helper to parse optional JSON string into a typed value
fn parse_optional_json<T: serde::de::DeserializeOwned>(
    json_str: Option<&str>,
    field_name: &str,
) -> Result<Option<T>> {
    json_str
        .filter(|s| !s.is_empty() && *s != "null")
        .map(|s| {
            serde_json::from_str(s)
                .with_context(|| format!("Failed to parse {} JSON", field_name))
        })
        .transpose()
}

impl ChVariantDetailRow {
    pub fn to_api(self) -> Result<api::VariantDetails> {
        let rsids = if self.rsids.is_empty() {
            None
        } else {
            Some(self.rsids)
        };

        let exome: Option<serde_json::Value> =
            parse_optional_json(self.exome_json.as_deref(), "exome")?;
        let genome: Option<serde_json::Value> =
            parse_optional_json(self.genome_json.as_deref(), "genome")?;
        let joint: Option<serde_json::Value> =
            parse_optional_json(self.joint_json.as_deref(), "joint")?;
        let in_silico_predictors: Option<serde_json::Value> =
            parse_optional_json(self.in_silico_predictors_json.as_deref(), "in_silico_predictors")?;
        let coverage: Option<serde_json::Value> =
            parse_optional_json(self.coverage_json.as_deref(), "coverage")?;

        let transcript_consequences: Option<Vec<api::TranscriptConsequence>> =
            parse_optional_json(
                self.transcript_consequences_json.as_deref(),
                "transcript_consequences",
            )?;

        let first_tc = transcript_consequences.as_ref().and_then(|tcs| tcs.first());

        // Compute AC/AN/AF from exome or genome freq
        let ac = exome
            .as_ref()
            .and_then(|e| e.get("freq")?.get("all")?.get("ac")?.as_i64())
            .or_else(|| {
                genome
                    .as_ref()?
                    .get("freq")?
                    .get("all")?
                    .get("ac")?
                    .as_i64()
            })
            .unwrap_or(0);
        let an = exome
            .as_ref()
            .and_then(|e| e.get("freq")?.get("all")?.get("an")?.as_i64())
            .or_else(|| {
                genome
                    .as_ref()?
                    .get("freq")?
                    .get("all")?
                    .get("an")?
                    .as_i64()
            })
            .unwrap_or(0);
        let af = if an > 0 { ac as f64 / an as f64 } else { 0.0 };

        Ok(api::VariantDetails {
            variant_id: self.variant_id,
            pos: self.pos,
            chrom: self.chrom,
            alleles: self.alleles,
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
            caid: self.caid,
            exome,
            genome,
            joint,
            transcript_consequences,
            in_silico_predictors,
            coverage,
        })
    }
}

/// Search result row from ClickHouse gene search.
#[derive(Debug, Clone, Deserialize, Row)]
pub struct ChSearchRow {
    pub gene_id: String,
    pub gene_symbol: String,
    pub chrom: Option<String>,
    pub start: Option<i64>,
    pub stop: Option<i64>,
}

impl ChSearchRow {
    pub fn to_api(self) -> api::SearchResult {
        api::SearchResult {
            gene_id: self.gene_id,
            gene_symbol: self.gene_symbol,
            chrom: self.chrom,
            start: self.start,
            stop: self.stop,
        }
    }
}
