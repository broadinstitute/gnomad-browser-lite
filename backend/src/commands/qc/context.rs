//! `ScanContext` — read-only state built once before the scan and shared by every
//! check. It resolves the table globals (`freq_meta` / `freq_index_dict`) into the
//! per-stratum layout that the arithmetic/biological checks need to locate global vs
//! per-stratum AC/AN inside each row's `freq` array.
//!
//! For sources without frequency globals (e.g. sites-only VCFs, where
//! `engine.globals()` returns an empty struct) the strata are simply empty — the
//! trivial `fields.biallelic` check needs none of this, and richer checks land in
//! later specs.

use std::collections::HashMap;

use anyhow::{Context, Result};
use genohype_core::codec::EncodedValue;
use genohype_core::genomic::{as_i32, as_string, get_field};
use genohype_core::query::QueryEngine;

/// One frequency stratum, parsed from a `freq_meta` entry. The `index` is the
/// position in each row's `freq` array that this stratum's AC/AN/AF live at.
///
/// Populated by [`ScanContext::build`] but not yet consumed: the trivial
/// `fields.biallelic` check needs no strata. The arithmetic/biological checks in
/// specs 02+ read these fields — hence `allow(dead_code)` for now.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Stratum {
    pub index: usize,
    pub group: Option<String>,
    pub ancestry: Option<String>,
    pub sex: Option<String>,
}

#[allow(dead_code)]
impl Stratum {
    /// True when this stratum is the dataset-wide total (no ancestry, no sex).
    pub fn is_global(&self) -> bool {
        self.ancestry.is_none() && self.sex.is_none()
    }
}

/// Read-only context shared across the parallel scan.
///
/// The frequency fields are parsed up front (deliverable 3) so that adding a
/// stratum-aware check later is purely additive; `fields.biallelic` reads none of
/// them, so they're currently unused — see [`Stratum`].
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ScanContext {
    pub reference_genome: String,
    /// Raw `freq_meta` rows as `key -> value` maps, one per `freq` array slot.
    pub freq_meta: Vec<HashMap<String, String>>,
    /// `"group|ancestry|sex" -> freq array index`, from the table globals.
    pub freq_index_dict: HashMap<String, i32>,
    /// Parsed strata, aligned with `freq_meta` by index.
    pub strata: Vec<Stratum>,
}

impl ScanContext {
    /// Build the context from the engine's globals. Missing/empty globals yield
    /// empty strata rather than an error, so sites-only VCFs are handled cleanly.
    pub fn build(engine: &QueryEngine, reference_genome: &str) -> Result<Self> {
        let globals = engine.globals().context("failed to read table globals")?;

        let freq_meta = parse_freq_meta(&globals);
        let freq_index_dict = parse_freq_index_dict(&globals);
        let strata = freq_meta
            .iter()
            .enumerate()
            .map(|(index, entry)| Stratum {
                index,
                group: lookup_alias(entry, &["group", "groups"]),
                ancestry: lookup_alias(entry, &["pop", "gen_anc", "ancestry", "subpop"]),
                sex: lookup_alias(entry, &["sex", "sex_karyotype"]),
            })
            .collect();

        Ok(Self {
            reference_genome: reference_genome.to_string(),
            freq_meta,
            freq_index_dict,
            strata,
        })
    }
}

/// Parse `freq_meta` (an `Array<Struct>` / `Array<Dict>`) into per-slot string maps.
fn parse_freq_meta(globals: &EncodedValue) -> Vec<HashMap<String, String>> {
    let Some(EncodedValue::Array(entries)) = get_field(globals, "freq_meta") else {
        return Vec::new();
    };
    entries
        .iter()
        .map(|entry| {
            let mut map = HashMap::new();
            if let EncodedValue::Struct(fields) = entry {
                for (k, v) in fields {
                    if let Some(s) = as_string(v) {
                        map.insert(k.clone(), s);
                    }
                }
            }
            map
        })
        .collect()
}

/// Parse `freq_index_dict` (a `Struct` of `name -> Int32`) into a lookup map.
fn parse_freq_index_dict(globals: &EncodedValue) -> HashMap<String, i32> {
    let mut dict = HashMap::new();
    if let Some(EncodedValue::Struct(fields)) = get_field(globals, "freq_index_dict") {
        for (k, v) in fields {
            if let Some(i) = as_i32(v) {
                dict.insert(k.clone(), i);
            }
        }
    }
    dict
}

/// First present value among a set of aliased keys (empty strings treated as absent).
fn lookup_alias(map: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| map.get(*k))
        .filter(|s| !s.is_empty())
        .cloned()
}
