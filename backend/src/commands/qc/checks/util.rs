//! Shared helpers for checks. Keep these allocation-light: they run on the hot
//! path (once per variant record).

use genohype_core::codec::EncodedValue;
use genohype_core::genomic::{as_i32, as_string, get_field, get_nested_field};

/// Build a `chr-pos-ref-alt` variant id from a sites row, for bounded examples.
///
/// Falls back to `"?"` components when a field is missing so a malformed row still
/// yields a usable, non-panicking id.
pub fn variant_id(row: &EncodedValue) -> String {
    let contig = get_nested_field(row, "locus.contig")
        .and_then(as_string)
        .unwrap_or_else(|| "?".to_string());
    let position = get_nested_field(row, "locus.position")
        .and_then(as_i32)
        .map(|p| p.to_string())
        .unwrap_or_else(|| "?".to_string());

    let (ref_allele, alt_allele) = match get_field(row, "alleles") {
        Some(EncodedValue::Array(alleles)) => (
            alleles.first().and_then(as_string).unwrap_or_default(),
            alleles.get(1).and_then(as_string).unwrap_or_default(),
        ),
        _ => (String::new(), String::new()),
    };

    format!("{}-{}-{}-{}", contig, position, ref_allele, alt_allele)
}
