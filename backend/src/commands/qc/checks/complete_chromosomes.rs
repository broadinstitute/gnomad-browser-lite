//! `complete.chromosomes` — every expected GRCh38 chromosome is present.
//!
//! Mirrors gnomad_qc's federated contig-completeness check
//! (federated_validity_checks.py:823, `expected_contigs = chr1..22, chrX, chrY`, passed
//! to `summarize_variants`). Accumulates the set of expected contigs seen during the
//! scan and, at finalize, flags any that never appeared — e.g. a dropped chrY.
//! Dependency-free; the presence set is unioned across partitions.
//!
//! This is the dual of `fields.contigs-grch38`: that check flags contigs present but
//! invalid; this one flags contigs expected but absent.
//!
//! Note: on a regional subset (a handful of intervals) most chromosomes are
//! legitimately absent, so this check is expected to fail there — see
//! `examples/federation` `defects.json` `clean_caveats`. It is meaningful on
//! genome-wide submissions.

use std::collections::BTreeSet;

use genohype_core::codec::EncodedValue;
use genohype_core::genomic::{as_string, get_nested_field};
use serde_json::json;

use crate::commands::qc::context::ScanContext;
use crate::commands::qc::framework::{Check, CheckConfig, CheckMeta, CheckResult, Status};

pub const META: CheckMeta = CheckMeta {
    id: "complete.chromosomes",
    name: "All GRCh38 chromosomes present",
    tier: 1,
    category: "completeness",
    description: "Every expected GRCh38 chromosome (chr1..22, chrX, chrY) has at least one site.",
    needs: &[],
};

/// Chromosomes a genome-wide GRCh38 sites file must contain — chr1..22, chrX, chrY
/// (matching gnomad_qc `expected_contigs`; chrM is not required).
const EXPECTED_CONTIGS: &[&str] = &[
    "chr1", "chr2", "chr3", "chr4", "chr5", "chr6", "chr7", "chr8", "chr9", "chr10",
    "chr11", "chr12", "chr13", "chr14", "chr15", "chr16", "chr17", "chr18", "chr19",
    "chr20", "chr21", "chr22", "chrX", "chrY",
];

/// The expected contigs seen so far. Bounded by `EXPECTED_CONTIGS.len()` regardless
/// of dataset size. `_cfg` is unused (this check records no examples) but kept for the
/// uniform constructor signature.
pub struct CompleteChromosomesState {
    seen: BTreeSet<String>,
}

impl CompleteChromosomesState {
    pub fn new(_cfg: &CheckConfig) -> Self {
        Self { seen: BTreeSet::new() }
    }
}

impl Check for CompleteChromosomesState {
    fn process_row(&mut self, row: &EncodedValue, _ctx: &ScanContext) {
        // Once every expected contig has been observed there is nothing left to learn.
        if self.seen.len() == EXPECTED_CONTIGS.len() {
            return;
        }
        if let Some(contig) = get_nested_field(row, "locus.contig").and_then(as_string)
            && EXPECTED_CONTIGS.contains(&contig.as_str())
        {
            self.seen.insert(contig);
        }
    }

    fn merge(&mut self, other: Self) {
        self.seen.extend(other.seen);
    }

    fn finalize(self, _ctx: &ScanContext) -> CheckResult {
        let missing: Vec<&str> = EXPECTED_CONTIGS
            .iter()
            .copied()
            .filter(|c| !self.seen.contains(*c))
            .collect();
        let status = if missing.is_empty() { Status::Pass } else { Status::Fail };
        let message = if missing.is_empty() {
            "All expected GRCh38 chromosomes are present.".to_string()
        } else {
            format!("{} expected chromosome(s) absent: {}.", missing.len(), missing.join(", "))
        };

        CheckResult {
            id: META.id.to_string(),
            name: META.name.to_string(),
            tier: META.tier,
            category: META.category.to_string(),
            status,
            metric: json!({ "n_missing": missing.len(), "missing_contigs": missing }),
            message,
            n_violations: missing.len() as u64,
            examples: Vec::new(),
            expectation: Some(json!({ "rule": "every expected GRCh38 chromosome (chr1..22, chrX, chrY) is present" })),
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

    fn row(contig: &str) -> EncodedValue {
        EncodedValue::Struct(vec![(
            "locus".to_string(),
            EncodedValue::Struct(vec![
                ("contig".to_string(), EncodedValue::Binary(contig.as_bytes().to_vec())),
                ("position".to_string(), EncodedValue::Int32(1)),
            ]),
        )])
    }

    fn entry() -> RegistryEntry {
        RegistryEntry {
            meta: META,
            construct: |cfg| CheckState::CompleteChromosomes(CompleteChromosomesState::new(cfg)),
        }
    }

    /// Present everything except chrY (mirrors the broken fixture's dropped chrY),
    /// split across two partitions to exercise the union merge.
    #[test]
    fn flags_missing_chromosome() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();

        let present: Vec<&str> = EXPECTED_CONTIGS.iter().copied().filter(|c| *c != "chrY").collect();
        let (a_c, b_c) = present.split_at(present.len() / 2);

        let mut a = QcAccumulator::new(&selected, &cfg);
        for c in a_c {
            a.process_row(&row(c), &ctx);
        }
        let mut b = QcAccumulator::new(&selected, &cfg);
        for c in b_c {
            b.process_row(&row(c), &ctx);
        }
        a.merge(b);

        let results = a.finalize(&ctx);
        let r = &results[0];
        assert_eq!(r.id, "complete.chromosomes");
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 1);
        assert_eq!(r.metric["missing_contigs"], json!(["chrY"]));
    }

    #[test]
    fn all_present_passes() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();

        let mut acc = QcAccumulator::new(&selected, &cfg);
        for c in EXPECTED_CONTIGS {
            acc.process_row(&row(c), &ctx);
        }
        // A non-expected contig must not affect completeness.
        acc.process_row(&row("GL000220.1"), &ctx);

        let results = acc.finalize(&ctx);
        assert_eq!(results[0].status, Status::Pass);
        assert_eq!(results[0].n_violations, 0);
    }
}
