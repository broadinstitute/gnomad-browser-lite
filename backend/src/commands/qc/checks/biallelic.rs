//! `fields.biallelic` — the trivial end-to-end check that proves the pipe.
//!
//! A sites-only federation submission must be split to biallelic: every row's
//! `alleles` array is exactly `[ref, alt]`. Any row with `len(alleles) != 2`
//! (a still-multiallelic site, or a malformed row) is a violation and fails the
//! check. It needs neither globals nor a reference, which is why it's the first
//! check to land — it exercises the whole scan/report path with the least logic.

use genohype_core::codec::EncodedValue;
use genohype_core::genomic::get_field;
use serde_json::json;

use super::util::variant_id;
use crate::commands::qc::context::ScanContext;
use crate::commands::qc::framework::{Check, CheckConfig, CheckMeta, CheckResult, Status};

pub const META: CheckMeta = CheckMeta {
    id: "fields.biallelic",
    name: "Biallelic sites",
    tier: 1,
    category: "schema",
    description: "Every row is split to biallelic (alleles == [ref, alt]).",
    needs: &[],
};

/// Running state: a violation count and a bounded sample of offending variants.
/// O(max_examples) memory regardless of dataset size.
pub struct BiallelicState {
    n_violations: u64,
    examples: Vec<serde_json::Value>,
    max_examples: usize,
}

impl BiallelicState {
    pub fn new(cfg: &CheckConfig) -> Self {
        Self {
            n_violations: 0,
            examples: Vec::new(),
            max_examples: cfg.max_examples,
        }
    }

    /// Push an example if we're still under the cap. Bounding here (and in
    /// `merge`) keeps memory O(checks), not O(variants).
    fn record_example(&mut self, example: serde_json::Value) {
        if self.examples.len() < self.max_examples {
            self.examples.push(example);
        }
    }
}

impl Check for BiallelicState {
    fn process_row(&mut self, row: &EncodedValue, _ctx: &ScanContext) {
        if let Some(EncodedValue::Array(alleles)) = get_field(row, "alleles")
            && alleles.len() != 2
        {
            self.n_violations += 1;
            self.record_example(json!({
                "variant_id": variant_id(row),
                "n_alleles": alleles.len(),
            }));
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
            format!("{} record(s) are not biallelic.", self.n_violations)
        } else {
            "All records are biallelic.".to_string()
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
            expectation: Some(json!({ "rule": "len(alleles) == 2 for every row" })),
            plot: None,
            needs: META.needs.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::qc::framework::{registry, CheckState, QcAccumulator};

    fn ctx() -> ScanContext {
        ScanContext {
            reference_genome: "GRCh38".to_string(),
            freq_meta: Vec::new(),
            freq_index_dict: std::collections::HashMap::new(),
            strata: Vec::new(),
        }
    }

    /// Build a minimal sites row with the given alleles.
    fn row(contig: &str, pos: i32, alleles: &[&str]) -> EncodedValue {
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
                EncodedValue::Array(
                    alleles
                        .iter()
                        .map(|a| EncodedValue::Binary(a.as_bytes().to_vec()))
                        .collect(),
                ),
            ),
        ])
    }

    /// The acceptance-criteria unit test: fold two partitions independently,
    /// merge, finalize, and assert the CheckResult.
    #[test]
    fn accumulator_folds_merges_and_flags_multiallelic() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = registry();
        let ctx = ctx();

        // Partition A: two clean biallelic rows.
        let mut a = QcAccumulator::new(&selected, &cfg);
        a.process_row(&row("chr1", 100, &["A", "T"]), &ctx);
        a.process_row(&row("chr1", 200, &["G", "C"]), &ctx);

        // Partition B: one clean, one multiallelic (3 alleles).
        let mut b = QcAccumulator::new(&selected, &cfg);
        b.process_row(&row("chr2", 300, &["A", "G"]), &ctx);
        b.process_row(&row("chr2", 400, &["A", "G", "T"]), &ctx);

        a.merge(b);
        assert_eq!(a.rows_scanned(), 4);

        let results = a.finalize(&ctx);
        assert_eq!(results.len(), 1);
        let r = &results[0];
        assert_eq!(r.id, "fields.biallelic");
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 1);
        assert_eq!(r.examples.len(), 1);
        assert_eq!(r.examples[0]["variant_id"], "chr2-400-A-G");
        assert_eq!(r.examples[0]["n_alleles"], 3);
    }

    #[test]
    fn all_biallelic_passes() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = registry();
        let ctx = ctx();

        let mut acc = QcAccumulator::new(&selected, &cfg);
        acc.process_row(&row("chr1", 100, &["A", "T"]), &ctx);
        acc.process_row(&row("chr1", 200, &["AC", "A"]), &ctx);

        let results = acc.finalize(&ctx);
        assert_eq!(results[0].status, Status::Pass);
        assert_eq!(results[0].n_violations, 0);
        assert!(results[0].examples.is_empty());
    }

    /// A direct exercise of the state to keep the `CheckState` wiring honest.
    #[test]
    fn constructor_wires_into_registry() {
        let cfg = CheckConfig { max_examples: 5 };
        let entry = &registry()[0];
        assert_eq!(entry.meta.id, "fields.biallelic");
        assert!(matches!((entry.construct)(&cfg), CheckState::Biallelic(_)));
    }
}
