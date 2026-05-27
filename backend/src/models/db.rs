use anyhow::{Context, Result};

use super::api;

/// Raw gene row from DuckDB
pub struct DuckDbGeneRow {
    pub gene_id: String,
    pub gencode_symbol: Option<String>,
    pub chrom: String,
    pub start: i64,
    pub stop: i64,
    pub strand: Option<String>,
    pub canonical_transcript_id: Option<String>,
    pub transcripts_json: Option<String>,
}

impl DuckDbGeneRow {
    pub fn to_api(self) -> Result<api::Gene> {
        let transcripts: Option<Vec<api::Transcript>> = self
            .transcripts_json
            .as_deref()
            .filter(|s| !s.is_empty() && *s != "null")
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
            constraint: None,
        })
    }
}

/// Raw variant row from DuckDB (list view — lightweight fields only)
pub struct DuckDbVariantRow {
    pub variant_id: Option<String>,
    pub chrom: String,
    pub pos: i64,
    pub alleles_json: String,
    pub rsids_json: Option<String>,
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

impl DuckDbVariantRow {
    pub fn to_api(self) -> Result<api::Variant> {
        let alleles: Vec<String> = serde_json::from_str(&self.alleles_json)
            .context("Failed to parse alleles JSON")?;

        let rsids: Option<Vec<String>> = self
            .rsids_json
            .as_deref()
            .filter(|s| !s.is_empty() && *s != "null")
            .map(|s| serde_json::from_str(s))
            .transpose()
            .context("Failed to parse rsids JSON")?;

        Ok(api::Variant {
            variant_id: self.variant_id,
            pos: self.pos,
            chrom: self.chrom,
            alleles,
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
        })
    }
}

/// Raw variant detail row from DuckDB (full nested data via to_json())
pub struct DuckDbVariantDetailRow {
    pub variant_id: Option<String>,
    pub chrom: String,
    pub pos: i64,
    pub alleles_json: String,
    pub rsids_json: Option<String>,
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
        .map(|s| serde_json::from_str(s).with_context(|| format!("Failed to parse {} JSON", field_name)))
        .transpose()
}

impl DuckDbVariantDetailRow {
    pub fn to_api(self) -> Result<api::VariantDetails> {
        let alleles: Vec<String> = serde_json::from_str(&self.alleles_json)
            .context("Failed to parse alleles JSON")?;

        let rsids: Option<Vec<String>> =
            parse_optional_json(self.rsids_json.as_deref(), "rsids")?;

        // Parse deeply nested structures as generic JSON (pass-through to frontend)
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

        // Parse transcript_consequences with strict types (used for summary fields)
        let transcript_consequences: Option<Vec<api::TranscriptConsequence>> =
            parse_optional_json(self.transcript_consequences_json.as_deref(), "transcript_consequences")?;

        // Extract first transcript consequence for summary fields
        let first_tc = transcript_consequences.as_ref().and_then(|tcs| tcs.first());

        // Compute AC/AN/AF from exome or genome freq
        let ac = exome.as_ref()
            .and_then(|e| e.get("freq")?.get("all")?.get("ac")?.as_i64())
            .or_else(|| genome.as_ref()?.get("freq")?.get("all")?.get("ac")?.as_i64())
            .unwrap_or(0);
        let an = exome.as_ref()
            .and_then(|e| e.get("freq")?.get("all")?.get("an")?.as_i64())
            .or_else(|| genome.as_ref()?.get("freq")?.get("all")?.get("an")?.as_i64())
            .unwrap_or(0);
        let af = if an > 0 { ac as f64 / an as f64 } else { 0.0 };

        Ok(api::VariantDetails {
            variant_id: self.variant_id,
            pos: self.pos,
            chrom: self.chrom,
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
