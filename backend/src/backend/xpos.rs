//! Shared `xpos` global-coordinate utilities.
//!
//! `xpos` packs `(contig, position)` into a single `i64` so a scalar primary
//! key / B-tree can prune region scans (and narrow point lookups to one
//! granule). Every backend store materializes an `xpos` column at load time
//! (ClickHouse `ORDER BY (xpos, alleles)`, parquet sorted by `xpos`, Postgres
//! `xpos BIGINT` + btree); the queries here turn a `(contig, start, end)`
//! region or a `variant_id` point lookup into the matching `xpos` bound(s).
//!
//! Formula (canonical gnomAD style, copied from
//! `axaou-rust/axaou-server/src/clickhouse/xpos.rs`):
//! `xpos = contig_number * 1_000_000_000 + position`, with X=23, Y=24,
//! M/MT=25, autosomes = the number, stripping any leading `chr`.

use anyhow::{anyhow, Result};

/// Multiplier that shifts the contig number into the high part of the i64.
const CONTIG_MULTIPLIER: i64 = 1_000_000_000;

/// Map a contig label to its numeric code (1..=22, X=23, Y=24, M/MT=25),
/// stripping any leading `chr`. Returns `0` for an unrecognized contig (callers
/// treat `xpos == 0` as "invalid", matching the reference impl).
fn contig_number(contig: &str) -> i64 {
    let normalized = contig.trim_start_matches("chr");
    match normalized.to_uppercase().as_str() {
        "X" => 23,
        "Y" => 24,
        "M" | "MT" => 25,
        _ => normalized.parse::<i64>().unwrap_or(0),
    }
}

/// Convert `(contig, position)` to `xpos` (legacy gnomAD style i64).
///
/// `xpos = contig_number * 1_000_000_000 + position`. Returns `0` for an
/// invalid/unknown contig (so an out-of-range query degrades to an empty
/// region rather than matching real rows).
pub fn compute_xpos(contig: &str, position: i64) -> i64 {
    let num = contig_number(contig);
    if num == 0 {
        return 0;
    }
    num * CONTIG_MULTIPLIER + position
}

/// Parse a `variant_id` (`contig-pos-ref-alt`, e.g. `1-12345-A-G` or
/// `chr1-12345-A-G`) and compute its `xpos`. Used to add an `xpos = ?` equality
/// to point lookups so the scalar primary index narrows to a single granule.
pub fn variant_id_to_xpos(variant_id: &str) -> Result<i64> {
    let parts: Vec<&str> = variant_id.split('-').collect();
    if parts.len() != 4 {
        return Err(anyhow!(
            "Invalid variant ID format '{variant_id}'. Expected contig-pos-ref-alt"
        ));
    }
    let contig = parts[0];
    let pos: i64 = parts[1]
        .parse()
        .map_err(|_| anyhow!("Invalid position in variant ID '{variant_id}': {}", parts[1]))?;
    let xpos = compute_xpos(contig, pos);
    if xpos == 0 {
        return Err(anyhow!("Invalid chromosome in variant ID '{variant_id}': {contig}"));
    }
    Ok(xpos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_xpos_matches_reference() {
        assert_eq!(compute_xpos("chr1", 12345), 1_000_012_345);
        assert_eq!(compute_xpos("1", 12345), 1_000_012_345);
        assert_eq!(compute_xpos("chr22", 1000), 22_000_001_000);
        assert_eq!(compute_xpos("X", 5000), 23_000_005_000);
        assert_eq!(compute_xpos("chrX", 5000), 23_000_005_000);
        assert_eq!(compute_xpos("Y", 100), 24_000_000_100);
        assert_eq!(compute_xpos("MT", 1), 25_000_000_001);
        assert_eq!(compute_xpos("M", 1), 25_000_000_001);
    }

    #[test]
    fn compute_xpos_invalid_contig_is_zero() {
        assert_eq!(compute_xpos("chrZ", 100), 0);
        assert_eq!(compute_xpos("", 100), 0);
    }

    #[test]
    fn variant_id_to_xpos_parses_both_prefixes() {
        assert_eq!(variant_id_to_xpos("1-12345-A-G").unwrap(), 1_000_012_345);
        assert_eq!(variant_id_to_xpos("chr1-12345-A-T").unwrap(), 1_000_012_345);
        assert_eq!(variant_id_to_xpos("22-1000-ACGT-G").unwrap(), 22_000_001_000);
        assert_eq!(variant_id_to_xpos("X-5000-C-G").unwrap(), 23_000_005_000);
    }

    #[test]
    fn variant_id_to_xpos_rejects_bad_input() {
        assert!(variant_id_to_xpos("1-12345-A").is_err()); // too few parts
        assert!(variant_id_to_xpos("1-notapos-A-G").is_err()); // bad position
        assert!(variant_id_to_xpos("Z-12345-A-G").is_err()); // bad contig
    }
}
