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

/// Read a count-like INFO value (`AC`/`AN`/`nhomalt`-family), returning the integer
/// whether VCF encoded it as a scalar (`Number=1`, e.g. `AN`) or a one-element array
/// (`Number=A` on a biallelic row, e.g. `AC`). Use this instead of `as_i32`, which
/// matches only the scalar and returns `None` on the array form. A multi-element array
/// (a true multiallelic `Number=A`) returns `None` — out of scope for the biallelic
/// aggregate model, and left for the caller rather than collapsed to its first element.
pub fn count_value(value: &EncodedValue) -> Option<i32> {
    match value {
        EncodedValue::Array(items) if items.len() == 1 => as_i32(&items[0]),
        other => as_i32(other),
    }
}

/// Human label for a per-stratum INFO key suffix: `""` -> `"global"`,
/// `"_afr_XX"` -> `"afr_XX"`. Used by the per-stratum arithmetic checks that pair
/// `AC[_<suffix>]` with a sibling `AN`/`nhomalt` field.
///
/// Total for any `&str` on purpose: callers only ever pass `""` or a `_`-prefixed
/// suffix (so `strip_prefix('_')` matches in practice), but the `unwrap_or` keeps
/// it correct and panic-free rather than coupling it to a caller's guard.
pub fn stratum_label(suffix: &str) -> &str {
    if suffix.is_empty() {
        "global"
    } else {
        suffix.strip_prefix('_').unwrap_or(suffix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_value_reads_scalar_and_number_a() {
        // `Number=1` (e.g. AN): plain scalar.
        assert_eq!(count_value(&EncodedValue::Int32(120)), Some(120));
        // `Number=A` on a biallelic row (e.g. AC): one-element array.
        assert_eq!(
            count_value(&EncodedValue::Array(vec![EncodedValue::Int32(7)])),
            Some(7)
        );
        // The trap this helper exists to avoid: bare `as_i32` on that same array.
        assert_eq!(as_i32(&EncodedValue::Array(vec![EncodedValue::Int32(7)])), None);
        // Multiallelic `Number=A` is out of scope, not silently truncated.
        assert_eq!(
            count_value(&EncodedValue::Array(vec![
                EncodedValue::Int32(7),
                EncodedValue::Int32(3),
            ])),
            None
        );
    }

    #[test]
    fn stratum_label_maps_suffix_to_label() {
        assert_eq!(stratum_label(""), "global");
        assert_eq!(stratum_label("_afr"), "afr");
        assert_eq!(stratum_label("_afr_XX"), "afr_XX");
    }
}
