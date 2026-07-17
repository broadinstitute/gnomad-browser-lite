//! `fields.retired-terms` — no retired gnomAD terminology in the schema.
//!
//! Mirrors gnomad_qc `check_globals_for_retired_terms` (federated_validity_checks.py:1373).
//! Retired labels `oth`/`other` are superseded by `remaining`, and `pop`/`population` by
//! `gen_anc`. They surface two ways: as a segment of a flat sites-VCF INFO field name
//! (e.g. `AC_oth`), or as a key/value in a Hail table's `freq_meta` global. Segment-based
//! matching (`split('_')`) avoids substring false positives.

use std::collections::{BTreeMap, BTreeSet};

use genohype_core::codec::EncodedValue;
use genohype_core::genomic::get_field;
use serde_json::json;

use crate::commands::qc::context::ScanContext;
use crate::commands::qc::framework::{Check, CheckConfig, CheckMeta, CheckResult, Status};

pub const META: CheckMeta = CheckMeta {
    id: "fields.retired-terms",
    name: "No retired terminology",
    tier: 1,
    category: "schema",
    description: "No retired gnomAD labels (oth, other, pop, population) in field names or freq_meta.",
    // Reads flat VCF INFO field names (and freq_meta when present); no hard globals dependency.
    needs: &[],
};

/// Retired gnomAD labels: `oth`/`other` -> `remaining`, `pop`/`population` -> `gen_anc`.
const RETIRED_TERMS: &[&str] = &["oth", "other", "pop", "population"];

/// The retired token in an underscore-delimited name, if any ("AC_oth" -> "oth").
fn retired_token(name: &str) -> Option<&'static str> {
    name.split('_')
        .find_map(|seg| RETIRED_TERMS.iter().copied().find(|t| seg.eq_ignore_ascii_case(t)))
}

/// Offending labels mapped to the retired term they contain, deduped across partitions.
/// INFO field names are uniform across rows, so they're captured once.
pub struct RetiredTermsState {
    offenders: BTreeMap<String, &'static str>,
    schema_scanned: bool,
    max_examples: usize,
}

impl RetiredTermsState {
    pub fn new(cfg: &CheckConfig) -> Self {
        Self { offenders: BTreeMap::new(), schema_scanned: false, max_examples: cfg.max_examples }
    }
}

impl Check for RetiredTermsState {
    fn process_row(&mut self, row: &EncodedValue, _ctx: &ScanContext) {
        if self.schema_scanned {
            return;
        }
        // The flat sites-VCF path: retired terms as INFO field-name segments (AC_oth, ...).
        // Marked scanned only once the (uniform) info struct is actually seen.
        if let Some(EncodedValue::Struct(info)) = get_field(row, "info") {
            for (name, _) in info {
                if let Some(term) = retired_token(name) {
                    self.offenders.insert(name.clone(), term);
                }
            }
            self.schema_scanned = true;
        }
    }

    fn merge(&mut self, other: Self) {
        self.offenders.extend(other.offenders);
        self.schema_scanned |= other.schema_scanned;
    }

    fn finalize(mut self, ctx: &ScanContext) -> CheckResult {
        // The Hail-table path: retired terms in freq_meta keys/values (empty for sites VCFs).
        for entry in &ctx.freq_meta {
            for (k, v) in entry {
                if let Some(t) = RETIRED_TERMS.iter().copied().find(|t| k.eq_ignore_ascii_case(t)) {
                    self.offenders.insert(format!("freq_meta key '{k}'"), t);
                }
                if let Some(t) = RETIRED_TERMS.iter().copied().find(|t| v.eq_ignore_ascii_case(t)) {
                    self.offenders.insert(format!("freq_meta '{k}={v}'"), t);
                }
            }
        }

        let terms: Vec<&str> = self
            .offenders
            .values()
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let status = if terms.is_empty() { Status::Pass } else { Status::Fail };
        let examples: Vec<serde_json::Value> = self
            .offenders
            .iter()
            .take(self.max_examples)
            .map(|(label, term)| json!({ "field": label, "retired_term": term }))
            .collect();
        let message = if terms.is_empty() {
            "No retired terminology in field names or freq_meta.".to_string()
        } else {
            format!(
                "Retired terminology ({}) in {} field(s)/label(s).",
                terms.join(", "),
                self.offenders.len()
            )
        };

        CheckResult {
            id: META.id.to_string(),
            name: META.name.to_string(),
            tier: META.tier,
            category: META.category.to_string(),
            status,
            metric: json!({ "n_violations": self.offenders.len(), "retired_terms": terms }),
            message,
            n_violations: self.offenders.len() as u64,
            examples,
            expectation: Some(json!({ "rule": "no retired labels (oth, other, pop, population) in field names or freq_meta" })),
            plot: None,
            needs: META.needs.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::commands::qc::framework::{CheckState, QcAccumulator, RegistryEntry};

    fn ctx_with_freq_meta(freq_meta: Vec<HashMap<String, String>>) -> ScanContext {
        ScanContext {
            reference_genome: "GRCh38".to_string(),
            freq_meta,
            freq_index_dict: HashMap::new(),
            strata: Vec::new(),
        }
    }

    fn ctx() -> ScanContext {
        ctx_with_freq_meta(Vec::new())
    }

    /// A row whose `info` struct has the given INFO field names (dummy values).
    fn row_with_info(info_fields: &[&str]) -> EncodedValue {
        EncodedValue::Struct(vec![(
            "info".to_string(),
            EncodedValue::Struct(
                info_fields.iter().map(|n| (n.to_string(), EncodedValue::Int32(0))).collect(),
            ),
        )])
    }

    fn entry() -> RegistryEntry {
        RegistryEntry {
            meta: META,
            construct: |cfg| CheckState::RetiredTerms(RetiredTermsState::new(cfg)),
        }
    }

    #[test]
    fn flags_retired_field_names() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();

        let mut acc = QcAccumulator::new(&selected, &cfg);
        // Two rows, same schema — the second must not double-count.
        acc.process_row(&row_with_info(&["AC_nfe", "AC_oth", "AN_oth", "AC_afr"]), &ctx);
        acc.process_row(&row_with_info(&["AC_nfe", "AC_oth", "AN_oth", "AC_afr"]), &ctx);

        let results = acc.finalize(&ctx);
        let r = &results[0];
        assert_eq!(r.id, "fields.retired-terms");
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.metric["retired_terms"], json!(["oth"]));
        assert_eq!(r.n_violations, 2); // AC_oth, AN_oth
    }

    #[test]
    fn clean_field_names_pass() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();

        let mut acc = QcAccumulator::new(&selected, &cfg);
        acc.process_row(&row_with_info(&["AC_nfe", "AC_afr", "AN_afr", "nhomalt_amr"]), &ctx);

        let results = acc.finalize(&ctx);
        assert_eq!(results[0].status, Status::Pass);
        assert_eq!(results[0].n_violations, 0);
    }

    /// The Hail-table path the VCF fixtures don't exercise: retired key ("pop") and
    /// retired value ("oth") in freq_meta.
    #[test]
    fn flags_retired_freq_meta() {
        let cfg = CheckConfig { max_examples: 20 };
        let ctx = ctx_with_freq_meta(vec![
            HashMap::from([
                ("group".to_string(), "adj".to_string()),
                ("pop".to_string(), "nfe".to_string()),
            ]),
            HashMap::from([("gen_anc".to_string(), "oth".to_string())]),
        ]);

        let r = RetiredTermsState::new(&cfg).finalize(&ctx);
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.metric["retired_terms"], json!(["oth", "pop"]));
        assert_eq!(r.n_violations, 2);
    }
}
