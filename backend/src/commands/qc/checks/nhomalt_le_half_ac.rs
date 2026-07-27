//! `arith.nhomalt-le-half-ac` — flag any stratum with `nhomalt > AC/2` or a
//! negative `nhomalt`.
//!
//! Each homozygous-alt genotype contributes two alt alleles, so
//! `0 <= 2*nhomalt <= AC` is a mathematical guarantee of a correct callstats
//! computation. A violation is never biological — it fingerprints a broken
//! upstream merge/aggregation, a sign/sentinel bug, or a het/hom miscount, so any
//! violation is a hard **FAIL**.
//!
//! On a sites-only VCF each stratum's counts are flat `info.nhomalt[_<suffix>]` /
//! `info.AC[_<suffix>]` fields (global = bare `nhomalt`/`AC`), so this reads them
//! inline and needs no globals. See `docs/spec/qc/07-nhomalt-le-half-ac.md` §5 for
//! why `needs` is empty rather than `globals`, and the `Number=A` note.

use genohype_core::codec::EncodedValue;
use genohype_core::genomic::get_field;
use serde_json::json;

use super::util::{count_value, stratum_label, variant_id};
use crate::commands::qc::context::ScanContext;
use crate::commands::qc::framework::{Check, CheckConfig, CheckMeta, CheckResult, Status};

pub const META: CheckMeta = CheckMeta {
    id: "arith.nhomalt-le-half-ac",
    name: "nhomalt <= AC/2",
    tier: 1,
    category: "arithmetic",
    description: "Every stratum has 2*nhomalt <= AC (no impossible homozygote counts).",
    needs: &[],
};

/// Running state: a per-record violation count and a bounded sample of offending
/// records. O(max_examples) memory regardless of dataset size.
pub struct NhomaltLeHalfAcState {
    n_violations: u64,
    examples: Vec<serde_json::Value>,
    max_examples: usize,
}

impl NhomaltLeHalfAcState {
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

/// Why a stratum violates, if it does. `ac` is `None` when the sibling `AC` field
/// is absent (a `fields.required` concern); the `2*nhomalt <= AC` test is also
/// skipped when `AC < 0` (that is `arith.ac-le-an`'s concern) — but a negative
/// `nhomalt` is always flagged. The product is computed in `i64` so a malformed
/// huge `nhomalt` cannot overflow.
fn violation(nhomalt: i32, ac: Option<i32>) -> Option<&'static str> {
    if nhomalt < 0 {
        return Some("nhomalt < 0");
    }
    match ac {
        Some(ac) if ac >= 0 && i64::from(nhomalt) * 2 > i64::from(ac) => Some("nhomalt > AC/2"),
        _ => None,
    }
}

impl Check for NhomaltLeHalfAcState {
    fn process_row(&mut self, row: &EncodedValue, _ctx: &ScanContext) {
        // Sites-VCF layout: per-stratum counts are flat fields of the `info` struct.
        let Some(EncodedValue::Struct(info)) = get_field(row, "info") else {
            return;
        };

        // Scan every nhomalt-family field, pairing it with its matching AC field.
        // A record is counted once, on its first offending stratum.
        for (key, value) in info {
            // "nhomalt" (global) or "nhomalt_<suffix>".
            let Some(suffix) = key.strip_prefix("nhomalt") else {
                continue;
            };
            if !suffix.is_empty() && !suffix.starts_with('_') {
                continue;
            }
            let Some(nhomalt) = count_value(value) else { continue };

            // Matching AC key = "AC" + the same suffix; found without allocating.
            let ac = info
                .iter()
                .find_map(|(k, v)| (k.strip_prefix("AC") == Some(suffix)).then(|| count_value(v)))
                .flatten();

            if let Some(reason) = violation(nhomalt, ac) {
                self.n_violations += 1;
                self.record_example(json!({
                    "variant_id": variant_id(row),
                    "stratum": stratum_label(suffix),
                    "reason": reason,
                    "nhomalt": nhomalt,
                    "ac": ac,
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
                "{} record(s) have nhomalt > AC/2 or negative nhomalt in some stratum.",
                self.n_violations
            )
        } else {
            "Every stratum has 2*nhomalt <= AC.".to_string()
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
                "rule": "2*nhomalt <= AC, and nhomalt >= 0, for every stratum"
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
    /// each field the way the VCF reader does: `AC*` and `nhomalt*` are `Number=A`
    /// (single-element arrays) and any other field (`AN*`) is `Number=1` (scalar).
    fn info_value(key: &str, v: i32) -> EncodedValue {
        if key.starts_with("AC") || key.starts_with("nhomalt") {
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

        let mut s = NhomaltLeHalfAcState::new(&cfg);
        // Boundary: 2*5 == 10 is allowed (<=), plus a valid subgroup.
        s.process_row(
            &row("chr1", 100, &[("AC", 10), ("nhomalt", 5), ("AC_afr", 4), ("nhomalt_afr", 2)]),
            &ctx,
        );
        // Zero counts everywhere.
        s.process_row(
            &row("chr1", 200, &[("AC", 0), ("nhomalt", 0), ("AC_XX", 0), ("nhomalt_XX", 0)]),
            &ctx,
        );

        let r = s.finalize(&ctx);
        assert_eq!(r.status, Status::Pass);
        assert_eq!(r.n_violations, 0);
        assert!(r.examples.is_empty());
    }

    #[test]
    fn subgroup_nhomalt_gt_half_ac_fails() {
        let cfg = CheckConfig { max_examples: 20 };
        let ctx = ctx();

        // Global stratum is fine, but the afr subgroup has 2*nhomalt (6) > AC (4).
        let mut s = NhomaltLeHalfAcState::new(&cfg);
        s.process_row(
            &row("chr1", 100, &[("AC", 10), ("nhomalt", 3), ("AC_afr", 4), ("nhomalt_afr", 3)]),
            &ctx,
        );

        let r = s.finalize(&ctx);
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 1);
        assert_eq!(r.examples.len(), 1);
        assert_eq!(r.examples[0]["stratum"], "afr");
        assert_eq!(r.examples[0]["reason"], "nhomalt > AC/2");
        assert_eq!(r.examples[0]["nhomalt"], 3);
        assert_eq!(r.examples[0]["ac"], 4);
    }

    #[test]
    fn negative_nhomalt_fails() {
        let cfg = CheckConfig { max_examples: 20 };
        let ctx = ctx();

        let mut s = NhomaltLeHalfAcState::new(&cfg);
        s.process_row(&row("chr1", 300, &[("AC", 10), ("nhomalt", -1)]), &ctx);

        let r = s.finalize(&ctx);
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 1);
        assert_eq!(r.examples[0]["stratum"], "global");
        assert_eq!(r.examples[0]["reason"], "nhomalt < 0");
    }

    /// A negative AC is `arith.ac-le-an`'s concern, not this check's — the
    /// `2*nhomalt <= AC` test is skipped when `AC < 0` (no false positive here).
    #[test]
    fn negative_ac_is_not_this_checks_violation() {
        let cfg = CheckConfig { max_examples: 20 };
        let ctx = ctx();

        let mut s = NhomaltLeHalfAcState::new(&cfg);
        s.process_row(&row("chr1", 400, &[("AC", -2), ("nhomalt", 1)]), &ctx);

        let r = s.finalize(&ctx);
        assert_eq!(r.status, Status::Pass);
        assert_eq!(r.n_violations, 0);
    }

    /// Split-then-merge == whole, matching the scaffold's accumulator test.
    #[test]
    fn split_then_merge_equals_whole() {
        let cfg = CheckConfig { max_examples: 20 };
        let ctx = ctx();

        let mut a = NhomaltLeHalfAcState::new(&cfg);
        a.process_row(&row("chr1", 100, &[("AC", 10), ("nhomalt", 4)]), &ctx); // ok
        a.process_row(&row("chr1", 200, &[("AC", 4), ("nhomalt", 3)]), &ctx); // 2*3=6 > 4

        let mut b = NhomaltLeHalfAcState::new(&cfg);
        b.process_row(&row("chr2", 300, &[("AC", 8), ("nhomalt", 4)]), &ctx); // boundary ok
        b.process_row(&row("chr2", 400, &[("AC", 8), ("nhomalt", -1)]), &ctx); // negative

        a.merge(b);
        let r = a.finalize(&ctx);
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 2);
        assert_eq!(r.examples.len(), 2);
    }
}
