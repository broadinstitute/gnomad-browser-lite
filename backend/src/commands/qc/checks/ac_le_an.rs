//! `arith.ac-le-an` — flag any stratum with `AC > AN` or a negative `AC`/`AN`.
//!
//! `0 <= AC <= AN` is a mathematical guarantee of a correct callstats computation
//! (there cannot be more alternate alleles than total called alleles, and neither
//! count can be negative). A violation is never biological — it fingerprints a
//! broken upstream merge/aggregation, a sign/overflow bug, or a mislabeled stratum,
//! so any violation is a hard **FAIL**.
//!
//! On a sites-only VCF each stratum's counts are flat `info.AC[_<suffix>]` /
//! `info.AN[_<suffix>]` fields (global = bare `AC`/`AN`), so this reads them inline
//! and needs no globals. See `docs/spec/qc/06-ac-le-an.md` §5 for why `needs` is
//! empty rather than `globals`.

use genohype_core::codec::EncodedValue;
use genohype_core::genomic::get_field;
use serde_json::json;

use super::util::{count_value, variant_id};
use crate::commands::qc::context::ScanContext;
use crate::commands::qc::framework::{Check, CheckConfig, CheckMeta, CheckResult, Status};

pub const META: CheckMeta = CheckMeta {
    id: "arith.ac-le-an",
    name: "AC <= AN",
    tier: 1,
    category: "arithmetic",
    description: "Every stratum has 0 <= AC <= AN (no impossible allele counts).",
    needs: &[],
};

/// Running state: a per-record violation count and a bounded sample of offending
/// records. O(max_examples) memory regardless of dataset size.
pub struct AcLeAnState {
    n_violations: u64,
    examples: Vec<serde_json::Value>,
    max_examples: usize,
}

impl AcLeAnState {
    pub fn new(cfg: &CheckConfig) -> Self {
        Self {
            n_violations: 0,
            examples: Vec::new(),
            max_examples: cfg.max_examples,
        }
    }

    /// Push an example while under the cap. Bounding here (and in `merge`) keeps
    /// memory O(checks), not O(variants).
    fn record_example(&mut self, example: serde_json::Value) {
        if self.examples.len() < self.max_examples {
            self.examples.push(example);
        }
    }
}

/// Human label for a stratum from an `AC` key's suffix: `""` -> `"global"`,
/// `"_afr_XX"` -> `"afr_XX"`.
///
/// Total for any `&str` on purpose: the caller only ever passes `""` or a
/// `_`-prefixed suffix (so `strip_prefix('_')` always matches in practice), but
/// the `unwrap_or` keeps the helper correct and panic-free if that ever changes,
/// rather than coupling it to the caller's guard.
fn stratum_label(suffix: &str) -> &str {
    if suffix.is_empty() {
        "global"
    } else {
        suffix.strip_prefix('_').unwrap_or(suffix)
    }
}

/// Why a stratum violates, if it does. `an` is `None` when the sibling `AN` field
/// is absent (a `fields.required` concern) — then only `AC < 0` is checkable.
fn violation(ac: i32, an: Option<i32>) -> Option<&'static str> {
    if ac < 0 {
        return Some("AC < 0");
    }
    match an {
        Some(an) if an < 0 => Some("AN < 0"),
        Some(an) if ac > an => Some("AC > AN"),
        _ => None,
    }
}

impl Check for AcLeAnState {
    fn process_row(&mut self, row: &EncodedValue, _ctx: &ScanContext) {
        // Sites-VCF layout: per-stratum counts are flat fields of the `info` struct.
        let Some(EncodedValue::Struct(info)) = get_field(row, "info") else {
            return;
        };

        // Scan every AC-family field, pairing it with its matching AN field. A
        // record is counted once, on its first offending stratum.
        for (key, value) in info {
            // "AC" (global) or "AC_<suffix>"; skip unrelated keys like "AC0".
            let Some(suffix) = key.strip_prefix("AC") else {
                continue;
            };
            if !suffix.is_empty() && !suffix.starts_with('_') {
                continue;
            }
            let Some(ac) = count_value(value) else { continue };

            // Matching AN key = "AN" + the same suffix; found without allocating.
            let an = info
                .iter()
                .find_map(|(k, v)| (k.strip_prefix("AN") == Some(suffix)).then(|| count_value(v)))
                .flatten();

            if let Some(reason) = violation(ac, an) {
                self.n_violations += 1;
                self.record_example(json!({
                    "variant_id": variant_id(row),
                    "stratum": stratum_label(suffix),
                    "reason": reason,
                    "ac": ac,
                    "an": an,
                }));
                break; // one violation per record
            }
        }
    }

    fn merge(&mut self, other: Self) {
        self.n_violations += other.n_violations;
        for example in other.examples {
            self.record_example(example);
        }
    }

    fn finalize(self, _ctx: &ScanContext) -> CheckResult {
        let status = if self.n_violations > 0 {
            Status::Fail
        } else {
            Status::Pass
        };
        let message = if self.n_violations > 0 {
            format!(
                "{} record(s) have AC > AN or negative AC/AN in some stratum.",
                self.n_violations
            )
        } else {
            "Every stratum has 0 <= AC <= AN.".to_string()
        };

        CheckResult {
            id: META.id.to_string(),
            name: META.name.to_string(),
            tier: META.tier,
            category: META.category.to_string(),
            status,
            metric: json!({ "n_violations": self.n_violations }),
            message,
            n_violations: self.n_violations,
            examples: self.examples,
            expectation: Some(json!({
                "rule": "AC <= AN, and AC >= 0 and AN >= 0, for every stratum"
            })),
            plot: None,
            needs: META.needs.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn ctx() -> ScanContext {
        ScanContext {
            reference_genome: "GRCh38".to_string(),
            freq_meta: Vec::new(),
            freq_index_dict: HashMap::new(),
            strata: Vec::new(),
        }
    }

    /// Build a sites row with an `info` struct from `(key, i32)` pairs, encoding
    /// each field the way the VCF reader does: `AC*` fields are `Number=A` (a
    /// single-element array, one value per alt allele) and `AN*` fields are
    /// `Number=1` (a scalar). This exercises the same array-vs-scalar handling the
    /// real fixtures do.
    fn info_value(key: &str, v: i32) -> EncodedValue {
        if key.starts_with("AC") {
            EncodedValue::Array(vec![EncodedValue::Int32(v)])
        } else {
            EncodedValue::Int32(v)
        }
    }

    fn row(contig: &str, pos: i32, info: &[(&str, i32)]) -> EncodedValue {
        EncodedValue::Struct(vec![
            (
                "locus".to_string(),
                EncodedValue::Struct(vec![
                    (
                        "contig".to_string(),
                        EncodedValue::Binary(contig.as_bytes().to_vec()),
                    ),
                    ("position".to_string(), EncodedValue::Int32(pos)),
                ]),
            ),
            (
                "alleles".to_string(),
                EncodedValue::Array(vec![
                    EncodedValue::Binary(b"A".to_vec()),
                    EncodedValue::Binary(b"T".to_vec()),
                ]),
            ),
            (
                "info".to_string(),
                EncodedValue::Struct(
                    info.iter()
                        .map(|(k, v)| (k.to_string(), info_value(k, *v)))
                        .collect(),
                ),
            ),
        ])
    }

    #[test]
    fn all_strata_valid_passes() {
        let cfg = CheckConfig { max_examples: 20 };
        let ctx = ctx();

        let mut s = AcLeAnState::new(&cfg);
        s.process_row(
            &row("chr1", 100, &[("AC", 3), ("AN", 100), ("AC_afr", 1), ("AN_afr", 40)]),
            &ctx,
        );
        s.process_row(
            &row("chr1", 200, &[("AC", 0), ("AN", 0), ("AC_XX", 0), ("AN_XX", 0)]),
            &ctx,
        );

        let r = s.finalize(&ctx);
        assert_eq!(r.status, Status::Pass);
        assert_eq!(r.n_violations, 0);
        assert!(r.examples.is_empty());
    }

    #[test]
    fn subgroup_ac_gt_an_fails() {
        let cfg = CheckConfig { max_examples: 20 };
        let ctx = ctx();

        // Global stratum is fine, but the afr subgroup has AC > AN.
        let mut s = AcLeAnState::new(&cfg);
        s.process_row(
            &row("chr1", 100, &[("AC", 3), ("AN", 100), ("AC_afr", 51), ("AN_afr", 40)]),
            &ctx,
        );

        let r = s.finalize(&ctx);
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 1);
        assert_eq!(r.examples.len(), 1);
        assert_eq!(r.examples[0]["stratum"], "afr");
        assert_eq!(r.examples[0]["reason"], "AC > AN");
        assert_eq!(r.examples[0]["ac"], 51);
        assert_eq!(r.examples[0]["an"], 40);
    }

    #[test]
    fn negative_ac_fails() {
        let cfg = CheckConfig { max_examples: 20 };
        let ctx = ctx();

        let mut s = AcLeAnState::new(&cfg);
        s.process_row(&row("chr1", 300, &[("AC", -1), ("AN", 100)]), &ctx);

        let r = s.finalize(&ctx);
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 1);
        assert_eq!(r.examples[0]["stratum"], "global");
        assert_eq!(r.examples[0]["reason"], "AC < 0");
    }

    /// Split-then-merge == whole, matching the scaffold's accumulator test.
    #[test]
    fn split_then_merge_equals_whole() {
        let cfg = CheckConfig { max_examples: 20 };
        let ctx = ctx();

        let mut a = AcLeAnState::new(&cfg);
        a.process_row(&row("chr1", 100, &[("AC", 3), ("AN", 100)]), &ctx); // ok
        a.process_row(&row("chr1", 200, &[("AC", 51), ("AN", 40)]), &ctx); // AC > AN

        let mut b = AcLeAnState::new(&cfg);
        b.process_row(&row("chr2", 300, &[("AC", 2), ("AN", 50)]), &ctx); // ok
        b.process_row(&row("chr2", 400, &[("AC", 5), ("AN", -1)]), &ctx); // AN < 0

        a.merge(b);
        let r = a.finalize(&ctx);
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 2);
        assert_eq!(r.examples.len(), 2);
    }
}
