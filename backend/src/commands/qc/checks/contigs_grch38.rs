//! `fields.contigs-grch38` — every locus.contig is a GRCh38 primary-assembly contig.
//!
//! Mirrors gnomad_qc's federated build/contig checks (federated_validity_checks.py:
//! build == "GRCh38" ~L1355; `expected_contigs = chr1..22, chrX, chrY` ~L823). A file
//! truly on GRCh38 uses the chr-prefixed primary contigs; a GRCh37-style name ("1"),
//! the GRCh37 mitochondrion ("MT"), or an unplaced/alt/decoy contig ("GL000220.1") is
//! a violation and fails the check. chrM is intentionally excluded from the enum, to
//! match gnomad_qc `expected_contigs`. Per-row and dependency-free, like
//! `fields.biallelic`.

use std::collections::BTreeSet;

use genohype_core::codec::EncodedValue;
use genohype_core::genomic::{as_string, get_nested_field};
use serde_json::json;

use super::util::variant_id;
use crate::commands::qc::context::ScanContext;
use crate::commands::qc::framework::{Check, CheckConfig, CheckMeta, CheckResult, Status};

pub const META: CheckMeta = CheckMeta {
    id: "fields.contigs-grch38",
    name: "GRCh38 contigs only",
    tier: 1,
    category: "schema",
    description: "Every locus.contig is a GRCh38 primary-assembly contig (chr1..22, chrX, chrY).",
    needs: &[],
};

/// GRCh38 primary-assembly contigs — the chr-prefixed names that indicate a GRCh38
/// build. chr1..22, chrX, chrY (matching gnomad_qc `expected_contigs`; chrM excluded).
const ALLOWED_CONTIGS: &[&str] = &[
    "chr1", "chr2", "chr3", "chr4", "chr5", "chr6", "chr7", "chr8", "chr9", "chr10",
    "chr11", "chr12", "chr13", "chr14", "chr15", "chr16", "chr17", "chr18", "chr19",
    "chr20", "chr21", "chr22", "chrX", "chrY",
];

/// A short hint for why a contig is out of the enum, mirroring the sample report.
fn invalid_note(contig: &str) -> &'static str {
    let bare = contig.strip_prefix("chr").unwrap_or(contig);
    if matches!(bare, "M" | "MT") {
        "mitochondrial contig (not in expected set)" // "chrM" / "MT"
    } else if matches!(bare, "X" | "Y") || bare.parse::<u32>().is_ok_and(|n| (1..=22).contains(&n)) {
        "GRCh37-style contig name" // e.g. "1", "X"
    } else {
        "unplaced or alt contig" // e.g. "GL000220.1"
    }
}

/// Violation count, the distinct offending contigs, and a bounded example sample.
/// Memory is O(distinct invalid contigs + max_examples), independent of dataset size.
pub struct ContigsGrch38State {
    n_violations: u64,
    invalid_contigs: BTreeSet<String>,
    examples: Vec<serde_json::Value>,
    max_examples: usize,
}

impl ContigsGrch38State {
    pub fn new(cfg: &CheckConfig) -> Self {
        Self {
            n_violations: 0,
            invalid_contigs: BTreeSet::new(),
            examples: Vec::new(),
            max_examples: cfg.max_examples,
        }
    }

    fn record_example(&mut self, example: serde_json::Value) {
        if self.examples.len() < self.max_examples {
            self.examples.push(example);
        }
    }
}

impl Check for ContigsGrch38State {
    fn process_row(&mut self, row: &EncodedValue, _ctx: &ScanContext) {
        let Some(contig) = get_nested_field(row, "locus.contig").and_then(as_string) else {
            return; // an absent/malformed locus is surfaced by schema checks, not here
        };
        if !ALLOWED_CONTIGS.contains(&contig.as_str()) {
            self.n_violations += 1;
            self.record_example(json!({
                "variant_id": variant_id(row),
                "contig": contig,
                "note": invalid_note(&contig),
            }));
            self.invalid_contigs.insert(contig);
        }
    }

    fn merge(&mut self, other: Self) {
        self.n_violations += other.n_violations;
        self.invalid_contigs.extend(other.invalid_contigs);
        for example in other.examples {
            self.record_example(example);
        }
    }

    fn finalize(self, _ctx: &ScanContext) -> CheckResult {
        let status = if self.n_violations > 0 { Status::Fail } else { Status::Pass };
        let invalid: Vec<String> = self.invalid_contigs.into_iter().collect();
        let message = if self.n_violations > 0 {
            format!(
                "{} site(s) on {} contig(s) not in the GRCh38 primary assembly.",
                self.n_violations,
                invalid.len()
            )
        } else {
            "All sites are on GRCh38 primary-assembly contigs.".to_string()
        };

        CheckResult {
            id: META.id.to_string(),
            name: META.name.to_string(),
            tier: META.tier,
            category: META.category.to_string(),
            status,
            metric: json!({ "n_violations": self.n_violations, "invalid_contigs": invalid }),
            message,
            n_violations: self.n_violations,
            examples: self.examples,
            expectation: Some(json!({ "rule": "every locus.contig in the GRCh38 primary-assembly enum" })),
            plot: None,
            needs: META.needs.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::qc::framework::{CheckState, QcAccumulator, RegistryEntry};

    fn ctx() -> ScanContext {
        ScanContext {
            reference_genome: "GRCh38".to_string(),
            freq_meta: Vec::new(),
            freq_index_dict: std::collections::HashMap::new(),
            strata: Vec::new(),
        }
    }

    /// A minimal sites row with the given contig; alleles are present so `variant_id`
    /// produces a realistic id.
    fn row(contig: &str, pos: i32) -> EncodedValue {
        EncodedValue::Struct(vec![
            (
                "locus".to_string(),
                EncodedValue::Struct(vec![
                    ("contig".to_string(), EncodedValue::Binary(contig.as_bytes().to_vec())),
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
        ])
    }

    /// Just this check, so the test is independent of the rest of the registry.
    fn entry() -> RegistryEntry {
        RegistryEntry {
            meta: META,
            construct: |cfg| CheckState::ContigsGrch38(ContigsGrch38State::new(cfg)),
        }
    }

    #[test]
    fn folds_merges_and_flags_non_grch38_contigs() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();

        // Partition A: valid GRCh38 contigs.
        let mut a = QcAccumulator::new(&selected, &cfg);
        a.process_row(&row("chr1", 100), &ctx);
        a.process_row(&row("chrX", 200), &ctx);

        // Partition B: GRCh37-style ("1"), unplaced ("GL000220.1"), and one valid.
        let mut b = QcAccumulator::new(&selected, &cfg);
        b.process_row(&row("1", 300), &ctx);
        b.process_row(&row("GL000220.1", 400), &ctx);
        b.process_row(&row("chr22", 500), &ctx);

        a.merge(b);
        let results = a.finalize(&ctx);
        let r = &results[0];
        assert_eq!(r.id, "fields.contigs-grch38");
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 2);
        assert_eq!(r.metric["invalid_contigs"], json!(["1", "GL000220.1"]));
        assert_eq!(r.examples.len(), 2);
        assert_eq!(r.examples[0]["contig"], "1");
        assert_eq!(r.examples[0]["note"], "GRCh37-style contig name");
    }

    #[test]
    fn all_grch38_contigs_pass() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();

        let mut acc = QcAccumulator::new(&selected, &cfg);
        acc.process_row(&row("chr1", 100), &ctx);
        acc.process_row(&row("chr2", 200), &ctx);
        acc.process_row(&row("chrY", 300), &ctx);

        let results = acc.finalize(&ctx);
        assert_eq!(results[0].status, Status::Pass);
        assert_eq!(results[0].n_violations, 0);
        assert!(results[0].examples.is_empty());
    }

    /// chrM is excluded from the GRCh38 enum here, so it must be flagged.
    #[test]
    fn chrm_is_flagged() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();

        let mut acc = QcAccumulator::new(&selected, &cfg);
        acc.process_row(&row("chrM", 100), &ctx);

        let results = acc.finalize(&ctx);
        assert_eq!(results[0].status, Status::Fail);
        assert_eq!(results[0].n_violations, 1);
        assert_eq!(results[0].examples[0]["note"], "mitochondrial contig (not in expected set)");
    }
}
