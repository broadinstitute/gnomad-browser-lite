//! `fields.freq-index-dict` — the `freq_index_dict` global is well-formed.
//!
//! `freq_index_dict` maps a grouping-combination label to the index of that stratum in the
//! `freq` array (see https://gnomad.broadinstitute.org/help/v4-hts). Keys are formatted
//! `[downsampling_]gen_anc_sex_group`, the global `adj` stratum sits at index 0 and `raw` at
//! index 1. This check validates that structure.
//!
//! It reads a Hail-table global, so it does nothing per row and evaluates entirely in
//! `finalize`. A flat sites VCF carries no `freq_index_dict` (frequencies are flattened into
//! INFO fields), so `ScanContext.freq_index_dict` is empty there and the check is not
//! applicable → PASS. It does real work only on a Hail-table submission.
//!
//! Per the methods team, the check does not require the full gnomAD ancestry roster — a key
//! only has to *look like* it carries a genetic-ancestry group (a lowercase group-shaped
//! token that isn't a sex karyotype or `adj`/`raw`).

use std::collections::BTreeSet;

use genohype_core::codec::EncodedValue;
use serde_json::json;

use crate::commands::qc::context::ScanContext;
use crate::commands::qc::framework::{Check, CheckConfig, CheckMeta, CheckResult, Status};

pub const META: CheckMeta = CheckMeta {
    id: "fields.freq-index-dict",
    name: "freq_index_dict well-formed",
    tier: 1,
    category: "schema",
    description: "freq_index_dict keys formatted [downsampling_]gen_anc_sex_group; adj at index 0, raw at index 1.",
    needs: &["globals"],
};

fn is_group(t: &str) -> bool {
    t == "adj" || t == "raw"
}
fn is_sex(t: &str) -> bool {
    t == "XX" || t == "XY"
}
fn is_downsampling(t: &str) -> bool {
    !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())
}
/// A token shaped like a genetic-ancestry group: lowercase letters, length >= 2, and not the
/// `adj`/`raw` group tokens. Deliberately not matched against the real gnomAD roster.
fn is_gen_anc_shaped(t: &str) -> bool {
    t.len() >= 2 && t.bytes().all(|b| b.is_ascii_lowercase()) && !is_group(t)
}

/// A key is `[downsampling_]gen_anc_sex_group`: an optional leading numeric downsampling
/// token, then an optional gen_anc, then an optional sex (XX/XY), then the group (adj/raw).
fn valid_key_order(parts: &[&str]) -> bool {
    let Some((group, head)) = parts.split_last() else {
        return false;
    };
    if !is_group(group) {
        return false;
    }
    let mut mid = head;
    if mid.first().is_some_and(|t| is_downsampling(t)) {
        mid = &mid[1..];
    }
    match mid {
        [] => true,
        [one] => is_gen_anc_shaped(one) || is_sex(one),
        [anc, sex] => is_gen_anc_shaped(anc) && is_sex(sex),
        _ => false,
    }
}

pub struct FreqIndexDictState {
    max_examples: usize,
}

impl FreqIndexDictState {
    pub fn new(cfg: &CheckConfig) -> Self {
        Self { max_examples: cfg.max_examples }
    }
}

impl Check for FreqIndexDictState {
    // Globals-only check: nothing to fold per row or merge across partitions.
    fn process_row(&mut self, _row: &EncodedValue, _ctx: &ScanContext) {}
    fn merge(&mut self, _other: Self) {}

    fn finalize(self, ctx: &ScanContext) -> CheckResult {
        let dict = &ctx.freq_index_dict;

        let (status, message, issues, examples): (Status, String, Vec<String>, Vec<serde_json::Value>) =
            if dict.is_empty() {
                (
                    Status::Pass,
                    "freq_index_dict absent (flat sites submission); not applicable.".to_string(),
                    Vec::new(),
                    Vec::new(),
                )
            } else {
                let mut issues: BTreeSet<String> = BTreeSet::new();
                let mut examples: Vec<serde_json::Value> = Vec::new();

                if dict.get("adj") != Some(&0) {
                    issues.insert(format!("'adj' must be at index 0 (found {:?})", dict.get("adj")));
                }
                if dict.get("raw") != Some(&1) {
                    issues.insert(format!("'raw' must be at index 1 (found {:?})", dict.get("raw")));
                }

                // Deterministic order for examples: by declared index.
                let mut entries: Vec<(&String, &i32)> = dict.iter().collect();
                entries.sort_by_key(|(_, i)| **i);

                let mut any_gen_anc = false;
                for (key, _) in &entries {
                    let parts: Vec<&str> = key.split('_').collect();
                    if parts.iter().any(|p| is_gen_anc_shaped(p)) {
                        any_gen_anc = true;
                    }
                    if !valid_key_order(&parts) {
                        issues.insert(
                            "key not formatted as [downsampling_]gen_anc_sex_group ending in adj/raw".to_string(),
                        );
                        if examples.len() < self.max_examples {
                            examples.push(json!({ "key": key, "issue": "malformed grouping key" }));
                        }
                    }
                }

                if !any_gen_anc {
                    issues.insert("no genetic-ancestry-group-shaped key present".to_string());
                }

                // Indices must be unique and contiguous from 0.
                let mut idxs: Vec<i32> = dict.values().copied().collect();
                idxs.sort_unstable();
                if idxs.iter().enumerate().any(|(pos, v)| *v != pos as i32) {
                    issues.insert("freq index values are not unique and contiguous from 0".to_string());
                }

                let status = if issues.is_empty() { Status::Pass } else { Status::Fail };
                let message = if issues.is_empty() {
                    "freq_index_dict is well-formed (adj@0, raw@1, valid grouping keys).".to_string()
                } else {
                    format!(
                        "freq_index_dict validation failed: {}",
                        issues.iter().cloned().collect::<Vec<_>>().join("; ")
                    )
                };

                (status, message, issues.into_iter().collect(), examples)
            };

        let n = issues.len() as u64;
        CheckResult {
            id: META.id.to_string(),
            name: META.name.to_string(),
            tier: META.tier,
            category: META.category.to_string(),
            status,
            metric: json!({ "n_violations": n, "issues": issues }),
            message,
            n_violations: n,
            examples,
            expectation: Some(json!({
                "rule": "freq_index_dict keys formatted [downsampling_]gen_anc_sex_group; adj at index 0, raw at index 1"
            })),
            plot: None,
            needs: META.needs.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn ctx_with_index(entries: &[(&str, i32)]) -> ScanContext {
        ScanContext {
            reference_genome: "GRCh38".to_string(),
            freq_meta: Vec::new(),
            freq_index_dict: entries.iter().map(|(k, v)| (k.to_string(), *v)).collect::<HashMap<_, _>>(),
            strata: Vec::new(),
        }
    }

    fn run(entries: &[(&str, i32)]) -> CheckResult {
        let cfg = CheckConfig { max_examples: 20 };
        FreqIndexDictState::new(&cfg).finalize(&ctx_with_index(entries))
    }

    #[test]
    fn empty_dict_is_not_applicable_and_passes() {
        assert_eq!(run(&[]).status, Status::Pass);
    }

    #[test]
    fn valid_v4_style_passes() {
        let r = run(&[
            ("adj", 0),
            ("raw", 1),
            ("XX_adj", 2),
            ("XY_adj", 3),
            ("afr_adj", 4),
            ("afr_XX_adj", 5),
            ("afr_XY_adj", 6),
        ]);
        assert_eq!(r.status, Status::Pass);
        assert_eq!(r.n_violations, 0);
    }

    #[test]
    fn adj_not_at_zero_fails() {
        // adj at 1, raw at 0 — both misplaced.
        let r = run(&[("raw", 0), ("adj", 1), ("afr_adj", 2)]);
        assert_eq!(r.status, Status::Fail);
        assert!(r.metric["issues"].as_array().unwrap().iter().any(|i| i.as_str().unwrap().contains("'adj'")));
    }

    #[test]
    fn key_not_ending_in_group_fails() {
        // "afr" has no trailing adj/raw group token.
        let r = run(&[("adj", 0), ("raw", 1), ("afr", 2)]);
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.examples[0]["key"], "afr");
    }

    #[test]
    fn sex_before_gen_anc_fails() {
        // "XX_afr_adj" is out of order (sex must follow gen_anc).
        let r = run(&[("adj", 0), ("raw", 1), ("XX_afr_adj", 2)]);
        assert_eq!(r.status, Status::Fail);
    }

    #[test]
    fn no_gen_anc_shaped_key_fails() {
        // Global + sex only, no ancestry-group-shaped token anywhere.
        let r = run(&[("adj", 0), ("raw", 1), ("XX_adj", 2), ("XY_adj", 3)]);
        assert_eq!(r.status, Status::Fail);
        assert!(r
            .metric["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i.as_str().unwrap().contains("genetic-ancestry")));
    }
}
