//! Shared JSON → API-model extraction for the document-store backends.
//!
//! The Postgres (`postgres.rs`) and Elasticsearch (`elasticsearch.rs`) arms both
//! store the *source* (Hail-shaped) gnomAD variant record as a single JSON
//! document — Postgres in a `JSONB` column, ES under the `_source.value` object
//! (matching prod's `value.*` wrapping, see `elasticsearch_export.py`). Both must
//! extract the browser fields from that document *identically*, otherwise the
//! result-equivalence oracle (`crate::oracle`) — which asserts every arm returns
//! the same answer as the DuckDB / Hail reference — would fail on cosmetic
//! differences. Centralizing the extraction here is what guarantees that parity:
//! the field paths (`locus.contig`, `exome.freq.all.{ac,an}`,
//! `transcript_consequences[0]…`) live in exactly one place and mirror the
//! `to_json(...)` projection `duckdb.rs` reads.

use anyhow::{Context, Result};
use serde_json::Value;

use crate::models::api::{TranscriptConsequence, Variant, VariantDetails};

/// Navigate a nested JSON object by key path, returning the leaf value.
pub fn json_path<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for key in path {
        cur = cur.get(key)?;
    }
    Some(cur)
}

pub fn json_i64(v: &Value, path: &[&str]) -> Option<i64> {
    json_path(v, path).and_then(Value::as_i64)
}

pub fn json_str(v: &Value, path: &[&str]) -> Option<String> {
    json_path(v, path)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// AC/AN from `exome.freq.all.<field>`, falling back to `genome.freq.all.<field>`
/// (mirrors the COALESCE in `duckdb.rs` — gnomAD v4 records are unified, each
/// carrying both exome and genome frequencies).
pub fn coalesce_freq(data: &Value, field: &str) -> Option<i64> {
    json_i64(data, &["exome", "freq", "all", field])
        .or_else(|| json_i64(data, &["genome", "freq", "all", field]))
}

/// Build a list-view `Variant` from a stored source-shaped JSON document.
///
/// `variant_id_col` lets a backend pass an out-of-document id (e.g. a separate
/// indexed/keyword column); when `None` the id is read from the document.
pub fn variant_from_data(variant_id_col: Option<String>, data: &Value) -> Result<Variant> {
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

/// Build a full `VariantDetails` from a stored source-shaped JSON document.
///
/// Mirrors `DuckDbVariantDetailRow::to_api` (`models/db.rs`): the deeply nested
/// `exome` / `genome` / `joint` / `coverage` / `in_silico_predictors` subtrees
/// are passed through as raw `Value`, while `transcript_consequences` is typed.
pub fn variant_details_from_data(
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
        assert_eq!(d.transcript_consequences.as_ref().map(Vec::len), Some(1));
        assert_eq!(d.gene_symbol.as_deref(), Some("PCSK9"));
    }

    #[test]
    fn missing_locus_is_an_error() {
        let doc = json!({ "alleles": ["A", "C"] });
        assert!(variant_from_data(None, &doc).is_err());
    }
}
