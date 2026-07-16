//! The QC check framework: the report contract (`CheckResult` / `Status` / `Plot`),
//! the streaming accumulator (`QcAccumulator` + `CheckState`), and the check
//! **registry**.
//!
//! A check is a single [`CheckState`] variant implementing [`Check`] (fold one row,
//! merge two partial states, finalize into a [`CheckResult`]) plus one line in
//! [`registry`]. The scan, parallelism, and reporting never change — that small,
//! additive surface is what lets the `qc-validity-builder` skill scaffold a new
//! check mechanically.

use genohype_core::codec::EncodedValue;
use serde::{Deserialize, Serialize};

use super::checks::ac_le_an::{self, AcLeAnState};
use super::checks::biallelic::{self, BiallelicState};
use super::checks::complete_chromosomes::{self, CompleteChromosomesState};
use super::checks::contigs_grch38::{self, ContigsGrch38State};
use super::checks::freq_index_dict::{self, FreqIndexDictState};
use super::checks::required_fields::{self, RequiredFieldsState};
use super::checks::retired_terms::{self, RetiredTermsState};
use super::context::ScanContext;

/// pass / warn / fail — serialized lowercase to match the report schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pass,
    Warn,
    Fail,
}

/// A precomputed figure a check can attach. `data` is always a small summary
/// array, never raw variants — the browser only renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plot {
    /// Renderer hint, e.g. "histogram" | "scatter" | "bar".
    pub kind: String,
    pub title: String,
    pub data: serde_json::Value,
}

/// One check's outcome — the CLI ↔ app contract (schema in `00-design-reference.md`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckResult {
    pub id: String,
    pub name: String,
    pub tier: u8,
    pub category: String,
    pub status: Status,
    pub metric: serde_json::Value,
    pub message: String,
    pub n_violations: u64,
    pub examples: Vec<serde_json::Value>,
    pub expectation: Option<serde_json::Value>,
    pub plot: Option<Plot>,
    pub needs: Vec<String>,
}

/// Static description of a check — powers `gbl qc list`, `--checks` resolution, and
/// tier selection. The check's runtime state carries no metadata; it lives here.
#[derive(Debug, Clone, Copy)]
pub struct CheckMeta {
    pub id: &'static str,
    pub name: &'static str,
    pub tier: u8,
    pub category: &'static str,
    pub description: &'static str,
    /// Input dependencies: "globals" | "reference" | "consequences".
    pub needs: &'static [&'static str],
}

/// Per-run knobs passed to every check constructor (e.g. the examples cap).
#[derive(Debug, Clone, Copy)]
pub struct CheckConfig {
    pub max_examples: usize,
}

/// A registry row: static metadata + a constructor for the check's initial state.
#[derive(Debug, Clone, Copy)]
pub struct RegistryEntry {
    pub meta: CheckMeta,
    pub construct: fn(&CheckConfig) -> CheckState,
}

/// The check catalog. Adding a check is one line here plus its module — nothing
/// in the scan or reporting path changes.
pub fn registry() -> Vec<RegistryEntry> {
    vec![
        RegistryEntry {
            meta: biallelic::META,
            construct: |cfg| CheckState::Biallelic(BiallelicState::new(cfg)),
        },
        RegistryEntry {
            meta: contigs_grch38::META,
            construct: |cfg| CheckState::ContigsGrch38(ContigsGrch38State::new(cfg)),
        },
        RegistryEntry {
            meta: complete_chromosomes::META,
            construct: |cfg| CheckState::CompleteChromosomes(CompleteChromosomesState::new(cfg)),
        },
        RegistryEntry {
            meta: retired_terms::META,
            construct: |cfg| CheckState::RetiredTerms(RetiredTermsState::new(cfg)),
        },
        RegistryEntry {
            meta: required_fields::META,
            construct: |cfg| CheckState::RequiredFields(RequiredFieldsState::new(cfg)),
        },
        RegistryEntry {
            meta: freq_index_dict::META,
            construct: |cfg| CheckState::FreqIndexDict(FreqIndexDictState::new(cfg)),
        },
        RegistryEntry {
            meta: ac_le_an::META,
            construct: |cfg| CheckState::AcLeAn(AcLeAnState::new(cfg)),
        },
    ]
}

/// The behavior every check implements. Kept private-ish to the framework: the
/// scan only ever touches [`QcAccumulator`].
pub trait Check {
    /// Fold one variant record into the running state. Hot path — keep it cheap.
    fn process_row(&mut self, row: &EncodedValue, ctx: &ScanContext);
    /// Combine another partial state into this one. Must be associative and
    /// commutative (it runs in a parallel reduce).
    fn merge(&mut self, other: Self)
    where
        Self: Sized;
    /// Evaluate the final state against the check's expectation.
    fn finalize(self, ctx: &ScanContext) -> CheckResult;
}

/// One variant per check. An enum (not a trait object) keeps merges total and
/// avoids dynamic downcasting; `merge` combines like-with-like by construction,
/// since every accumulator is built from the same selection in the same order.
pub enum CheckState {
    Biallelic(BiallelicState),
    ContigsGrch38(ContigsGrch38State),
    CompleteChromosomes(CompleteChromosomesState),
    RetiredTerms(RetiredTermsState),
    RequiredFields(RequiredFieldsState),
    FreqIndexDict(FreqIndexDictState),
    AcLeAn(AcLeAnState),
}

impl CheckState {
    fn process_row(&mut self, row: &EncodedValue, ctx: &ScanContext) {
        match self {
            CheckState::Biallelic(s) => s.process_row(row, ctx),
            CheckState::ContigsGrch38(s) => s.process_row(row, ctx),
            CheckState::CompleteChromosomes(s) => s.process_row(row, ctx),
            CheckState::RetiredTerms(s) => s.process_row(row, ctx),
            CheckState::RequiredFields(s) => s.process_row(row, ctx),
            CheckState::FreqIndexDict(s) => s.process_row(row, ctx),
            CheckState::AcLeAn(s) => s.process_row(row, ctx),
        }
    }

    fn merge(&mut self, other: CheckState) {
        match (self, other) {
            (CheckState::Biallelic(a), CheckState::Biallelic(b)) => a.merge(b),
            (CheckState::ContigsGrch38(a), CheckState::ContigsGrch38(b)) => a.merge(b),
            (CheckState::CompleteChromosomes(a), CheckState::CompleteChromosomes(b)) => a.merge(b),
            (CheckState::RetiredTerms(a), CheckState::RetiredTerms(b)) => a.merge(b),
            (CheckState::RequiredFields(a), CheckState::RequiredFields(b)) => a.merge(b),
            (CheckState::FreqIndexDict(a), CheckState::FreqIndexDict(b)) => a.merge(b),
            (CheckState::AcLeAn(a), CheckState::AcLeAn(b)) => a.merge(b),
            _ => unreachable!("merge only ever combines like check states (same selection, same order)"),
        }
    }

    fn finalize(self, ctx: &ScanContext) -> CheckResult {
        match self {
            CheckState::Biallelic(s) => s.finalize(ctx),
            CheckState::ContigsGrch38(s) => s.finalize(ctx),
            CheckState::CompleteChromosomes(s) => s.finalize(ctx),
            CheckState::RetiredTerms(s) => s.finalize(ctx),
            CheckState::RequiredFields(s) => s.finalize(ctx),
            CheckState::FreqIndexDict(s) => s.finalize(ctx),
            CheckState::AcLeAn(s) => s.finalize(ctx),
        }
    }
}

/// Holds one [`CheckState`] per selected check, in a fixed order, plus the running
/// row count. The parallel scan folds rows into it and reduces partials with
/// [`merge`](Self::merge); [`finalize`](Self::finalize) turns it into the report.
pub struct QcAccumulator {
    states: Vec<CheckState>,
    rows_scanned: u64,
}

impl QcAccumulator {
    /// Instantiate one accumulator with fresh state for each selected check.
    pub fn new(selected: &[RegistryEntry], cfg: &CheckConfig) -> Self {
        Self {
            states: selected.iter().map(|e| (e.construct)(cfg)).collect(),
            rows_scanned: 0,
        }
    }

    /// Fold one row into every check's state.
    pub fn process_row(&mut self, row: &EncodedValue, ctx: &ScanContext) {
        self.rows_scanned += 1;
        for state in &mut self.states {
            state.process_row(row, ctx);
        }
    }

    /// Merge another accumulator element-wise by index. `other` was built from the
    /// same selection, so the variants line up.
    pub fn merge(&mut self, other: QcAccumulator) {
        self.rows_scanned += other.rows_scanned;
        for (a, b) in self.states.iter_mut().zip(other.states) {
            a.merge(b);
        }
    }

    /// Number of rows folded into this accumulator.
    pub fn rows_scanned(&self) -> u64 {
        self.rows_scanned
    }

    /// Evaluate every check into its final [`CheckResult`].
    pub fn finalize(self, ctx: &ScanContext) -> Vec<CheckResult> {
        self.states.into_iter().map(|s| s.finalize(ctx)).collect()
    }
}
