//! `fields.required` — required call-stat fields are present on every row.
//!
//! Mirrors gnomad_qc `validate_required_fields` (federated_validity_checks.py:422). A
//! federation sites submission must carry AC, AN, and nhomalt for the global sample and
//! for every stratification: each genetic-ancestry group and each sex karyotype (XX/XY),
//! including the ancestry×sex cross (e.g. `AC_nfe_XX`).
//!
//! This is a per-row *value*-presence check, not a field-name check: a field can be
//! declared in the schema yet null on individual rows (how the broken fixture drops
//! global nhomalt on a handful of records), and genohype still lists it as a key from
//! the header. So each required field is checked for a non-null value on every row.
//!
//! The genetic-ancestry roster is detected from the schema (each `AC_<group>`), so the
//! check enforces that every stratum *present* is complete rather than assuming a fixed
//! set of groups (which varies by release / regional subset). It does not mandate that
//! ancestry stratification exist at all — that roster calibration is deferred, as in
//! gnomad_qc's config-driven necessity map.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use genohype_core::codec::EncodedValue;
use genohype_core::genomic::get_field;
use serde_json::json;

use super::util::variant_id;
use crate::commands::qc::context::ScanContext;
use crate::commands::qc::framework::{Check, CheckConfig, CheckMeta, CheckResult, Status};

pub const META: CheckMeta = CheckMeta {
    id: "fields.required",
    name: "Required fields present",
    tier: 1,
    category: "schema",
    description: "AC, AN, nhomalt present per row — global, per genetic-ancestry group, and sex-karyotype-stratified (including ancestry×sex).",
    needs: &[],
};

/// Genetic-ancestry groups in the schema: each `AC_<group>` whose group is a single token
/// and not a sex karyotype or `raw`. `AC_nfe` marks `nfe`; `AC_nfe_XX` is then one of its
/// required sex-splits, not a group of its own.
fn detect_ancestry_groups(info_names: &[String]) -> BTreeSet<String> {
    let mut groups = BTreeSet::new();
    for name in info_names {
        if let Some(rest) = name.strip_prefix("AC_") {
            if !rest.contains('_') && !matches!(rest, "XX" | "XY" | "raw") {
                groups.insert(rest.to_string());
            }
        }
    }
    groups
}

/// The full required field list: the AC/AN/nhomalt trio for the global sample, each sex
/// karyotype, and — for every detected ancestry group — its base trio plus its XX/XY splits.
fn build_required(info_names: &[String]) -> Vec<String> {
    let mut required: Vec<String> = vec!["AC".to_string(), "AN".to_string(), "nhomalt".to_string()];
    for base in ["AC", "AN", "nhomalt"] {
        for sx in ["XX", "XY"] {
            required.push(format!("{base}_{sx}"));
        }
    }
    for group in detect_ancestry_groups(info_names) {
        for base in ["AC", "AN", "nhomalt"] {
            required.push(format!("{base}_{group}"));
            required.push(format!("{base}_{group}_XX"));
            required.push(format!("{base}_{group}_XY"));
        }
    }
    required
}

pub struct RequiredFieldsState {
    /// Required field names, resolved once from the first row's schema.
    required: Option<Vec<String>>,
    n_rows_with_missing: u64,
    missing_by_field: BTreeMap<String, u64>,
    examples: Vec<serde_json::Value>,
    max_examples: usize,
}

impl RequiredFieldsState {
    pub fn new(cfg: &CheckConfig) -> Self {
        Self {
            required: None,
            n_rows_with_missing: 0,
            missing_by_field: BTreeMap::new(),
            examples: Vec::new(),
            max_examples: cfg.max_examples,
        }
    }
}

impl Check for RequiredFieldsState {
    fn process_row(&mut self, row: &EncodedValue, _ctx: &ScanContext) {
        let Some(EncodedValue::Struct(info)) = get_field(row, "info") else {
            return;
        };
        if self.required.is_none() {
            let names: Vec<String> = info.iter().map(|(n, _)| n.clone()).collect();
            self.required = Some(build_required(&names));
        }
        let required = self.required.as_ref().unwrap();

        // Field names present in THIS row with a non-null value. Matching by name (not a
        // cached position) keeps the check correct regardless of INFO field order, or if the
        // reader ever omits absent fields instead of emitting them as Null.
        let present: HashSet<&str> = info
            .iter()
            .filter(|(_, v)| !matches!(v, EncodedValue::Null))
            .map(|(n, _)| n.as_str())
            .collect();

        let missing_here: Vec<String> = required
            .iter()
            .filter(|field| !present.contains(field.as_str()))
            .cloned()
            .collect();

        if !missing_here.is_empty() {
            self.n_rows_with_missing += 1;
            for f in &missing_here {
                *self.missing_by_field.entry(f.clone()).or_insert(0) += 1;
            }
            if self.examples.len() < self.max_examples {
                self.examples.push(json!({ "variant_id": variant_id(row), "missing": missing_here }));
            }
        }
    }

    fn merge(&mut self, other: Self) {
        self.n_rows_with_missing += other.n_rows_with_missing;
        for (k, v) in other.missing_by_field {
            *self.missing_by_field.entry(k).or_insert(0) += v;
        }
        for e in other.examples {
            if self.examples.len() < self.max_examples {
                self.examples.push(e);
            }
        }
        if self.required.is_none() {
            self.required = other.required;
        }
    }

    fn finalize(self, _ctx: &ScanContext) -> CheckResult {
        let status = if self.n_rows_with_missing > 0 { Status::Fail } else { Status::Pass };
        let missing_fields: Vec<&str> = self.missing_by_field.keys().map(String::as_str).collect();
        let message = if self.n_rows_with_missing > 0 {
            format!(
                "{} row(s) missing required field(s): {}.",
                self.n_rows_with_missing,
                missing_fields.join(", ")
            )
        } else {
            "All required fields present on every row.".to_string()
        };

        CheckResult {
            id: META.id.to_string(),
            name: META.name.to_string(),
            tier: META.tier,
            category: META.category.to_string(),
            status,
            metric: json!({ "n_violations": self.n_rows_with_missing, "missing_fields": missing_fields }),
            message,
            n_violations: self.n_rows_with_missing,
            examples: self.examples,
            expectation: Some(json!({
                "rule": "AC, AN, nhomalt present per row: global, per genetic-ancestry group, and per sex karyotype (including ancestry×sex)"
            })),
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

    /// The full set of required INFO fields for the given ancestry groups, all populated.
    fn complete_info(groups: &[&str]) -> Vec<(String, EncodedValue)> {
        let mut names: Vec<String> = vec!["AC".to_string(), "AN".to_string(), "nhomalt".to_string()];
        for base in ["AC", "AN", "nhomalt"] {
            for sx in ["XX", "XY"] {
                names.push(format!("{base}_{sx}"));
            }
        }
        for g in groups {
            for base in ["AC", "AN", "nhomalt"] {
                names.push(format!("{base}_{g}"));
                names.push(format!("{base}_{g}_XX"));
                names.push(format!("{base}_{g}_XY"));
            }
        }
        names.into_iter().map(|n| (n, EncodedValue::Int32(1))).collect()
    }

    fn info_row(info_fields: Vec<(String, EncodedValue)>) -> EncodedValue {
        EncodedValue::Struct(vec![
            (
                "locus".to_string(),
                EncodedValue::Struct(vec![
                    ("contig".to_string(), EncodedValue::Binary(b"chr1".to_vec())),
                    ("position".to_string(), EncodedValue::Int32(1)),
                ]),
            ),
            (
                "alleles".to_string(),
                EncodedValue::Array(vec![
                    EncodedValue::Binary(b"A".to_vec()),
                    EncodedValue::Binary(b"T".to_vec()),
                ]),
            ),
            ("info".to_string(), EncodedValue::Struct(info_fields)),
        ])
    }

    fn null_field(fields: &mut [(String, EncodedValue)], target: &str) {
        for (n, v) in fields.iter_mut() {
            if n == target {
                *v = EncodedValue::Null;
            }
        }
    }

    fn entry() -> RegistryEntry {
        RegistryEntry {
            meta: META,
            construct: |cfg| CheckState::RequiredFields(RequiredFieldsState::new(cfg)),
        }
    }

    #[test]
    fn all_required_present_passes() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();
        let mut acc = QcAccumulator::new(&selected, &cfg);
        acc.process_row(&info_row(complete_info(&["afr", "nfe"])), &ctx);
        acc.process_row(&info_row(complete_info(&["afr", "nfe"])), &ctx);
        let results = acc.finalize(&ctx);
        assert_eq!(results[0].status, Status::Pass);
        assert_eq!(results[0].n_violations, 0);
    }

    #[test]
    fn missing_global_field_fails() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();
        let mut broken = complete_info(&["afr", "nfe"]);
        null_field(&mut broken, "nhomalt");
        let mut acc = QcAccumulator::new(&selected, &cfg);
        acc.process_row(&info_row(complete_info(&["afr", "nfe"])), &ctx); // clean row resolves schema
        acc.process_row(&info_row(broken), &ctx);
        let r = &acc.finalize(&ctx)[0];
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 1);
        assert_eq!(r.metric["missing_fields"], json!(["nhomalt"]));
        assert_eq!(r.examples[0]["missing"], json!(["nhomalt"]));
    }

    #[test]
    fn incomplete_ancestry_base_fails() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();
        let mut fields = complete_info(&["afr", "nfe"]);
        null_field(&mut fields, "AN_afr");
        let mut acc = QcAccumulator::new(&selected, &cfg);
        acc.process_row(&info_row(fields), &ctx);
        let r = &acc.finalize(&ctx)[0];
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.metric["missing_fields"], json!(["AN_afr"]));
    }

    /// The stronger requirement: an ancestry group missing its sex split is flagged.
    #[test]
    fn missing_ancestry_sex_split_fails() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();
        let mut fields = complete_info(&["afr", "nfe"]);
        null_field(&mut fields, "AC_nfe_XX");
        let mut acc = QcAccumulator::new(&selected, &cfg);
        acc.process_row(&info_row(fields), &ctx);
        let r = &acc.finalize(&ctx)[0];
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.metric["missing_fields"], json!(["AC_nfe_XX"]));
    }

    #[test]
    fn missing_global_sex_field_fails() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();
        let mut fields = complete_info(&["afr", "nfe"]);
        null_field(&mut fields, "AC_XY");
        let mut acc = QcAccumulator::new(&selected, &cfg);
        acc.process_row(&info_row(fields), &ctx);
        let r = &acc.finalize(&ctx)[0];
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.metric["missing_fields"], json!(["AC_XY"]));
    }

    /// A realistic broken submission: different rows drop a global field, a
    /// genetic-ancestry-group field, and a sex-karyotype field.
    #[test]
    fn diverse_missing_fields_across_categories() {
        let cfg = CheckConfig { max_examples: 20 };
        let selected = [entry()];
        let ctx = ctx();
        let mut acc = QcAccumulator::new(&selected, &cfg);

        // Row 1 is complete and resolves the schema (afr, amr, nfe).
        acc.process_row(&info_row(complete_info(&["afr", "amr", "nfe"])), &ctx);

        // Row 2: missing a global field.
        let mut r2 = complete_info(&["afr", "amr", "nfe"]);
        null_field(&mut r2, "nhomalt");
        acc.process_row(&info_row(r2), &ctx);

        // Row 3: missing a genetic-ancestry-group field.
        let mut r3 = complete_info(&["afr", "amr", "nfe"]);
        null_field(&mut r3, "AC_amr");
        acc.process_row(&info_row(r3), &ctx);

        // Row 4: missing a sex-karyotype field.
        let mut r4 = complete_info(&["afr", "amr", "nfe"]);
        null_field(&mut r4, "AN_XY");
        acc.process_row(&info_row(r4), &ctx);

        let r = &acc.finalize(&ctx)[0];
        assert_eq!(r.status, Status::Fail);
        assert_eq!(r.n_violations, 3);
        assert_eq!(r.metric["missing_fields"], json!(["AC_amr", "AN_XY", "nhomalt"]));
    }
}
