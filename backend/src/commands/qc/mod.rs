//! `gbl qc` — federation QC. One command, one streaming pass over the source;
//! every selected check consumes that shared scan (see `docs/spec/qc/00-design-reference.md`).
//!
//! This module owns the CLI handler, the report contract, and the parallel
//! fold/reduce that drives the accumulator. The checks themselves live in
//! [`checks`]; the framework (accumulator, registry, result types) in [`framework`].

pub mod checks;
pub mod context;
pub mod framework;

use anyhow::{Context, Result};
use genohype_core::query::QueryEngine;
use rayon::prelude::*;
use serde::Serialize;

use crate::cli::{FailOn, QcCommands};
use context::ScanContext;
use framework::{registry, CheckConfig, CheckResult, QcAccumulator, RegistryEntry, Status};

const SCHEMA_VERSION: &str = "1";
const REFERENCE_GENOME: &str = "GRCh38";

/// The top-level report — the CLI ↔ `/qc` app contract.
#[derive(Debug, Serialize)]
struct Report {
    schema_version: &'static str,
    source: String,
    dataset_id: Option<String>,
    reference_genome: String,
    data_type: String,
    /// RFC3339, stamped by this process.
    generated_at: String,
    rows_scanned: u64,
    summary: Summary,
    checks: Vec<CheckResult>,
}

#[derive(Debug, Default, Serialize)]
struct Summary {
    pass: usize,
    warn: usize,
    fail: usize,
}

impl Summary {
    fn tally(checks: &[CheckResult]) -> Self {
        let mut s = Summary::default();
        for c in checks {
            match c.status {
                Status::Pass => s.pass += 1,
                Status::Warn => s.warn += 1,
                Status::Fail => s.fail += 1,
            }
        }
        s
    }
}

/// Dispatch entry point for `gbl qc <subcommand>`.
pub async fn run(cmd: &QcCommands) -> Result<()> {
    match cmd {
        QcCommands::List => {
            list();
            Ok(())
        }
        QcCommands::Run {
            source,
            checks,
            tier,
            out,
            max_examples,
            fail_on,
            data_type,
        } => {
            run_checks(
                source,
                checks.as_deref(),
                tier.as_deref(),
                out.as_deref(),
                *max_examples,
                *fail_on,
                data_type.as_deref(),
            )
            .await
        }
    }
}

/// `gbl qc list` — print the registry: id, tier, category, description, deps.
fn list() {
    let mut entries = registry();
    entries.sort_by(|a, b| a.meta.tier.cmp(&b.meta.tier).then(a.meta.id.cmp(b.meta.id)));

    println!("{:<28} {:<5} {:<12} {:<24} DESCRIPTION", "ID", "TIER", "CATEGORY", "NEEDS");
    for e in &entries {
        let needs = if e.meta.needs.is_empty() {
            "-".to_string()
        } else {
            e.meta.needs.join(",")
        };
        println!(
            "{:<28} {:<5} {:<12} {:<24} {}",
            e.meta.id, e.meta.tier, e.meta.category, needs, e.meta.description
        );
    }
}

/// Resolve `--checks` / `--tier` (or the default) into the selected registry rows.
///
/// Default (neither flag) is every single-dataset check: excludes Tier 3 (cross-
/// dataset) and reference-dependent checks, which need extra inputs.
fn resolve_selection(checks: Option<&str>, tier: Option<&str>) -> Result<Vec<RegistryEntry>> {
    let all = registry();

    if let Some(checks) = checks {
        let requested: Vec<&str> = checks.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        let mut selected = Vec::new();
        for id in requested {
            let entry = all
                .iter()
                .find(|e| e.meta.id == id)
                .copied()
                .with_context(|| format!("unknown check id '{}' (see `gbl qc list`)", id))?;
            selected.push(entry);
        }
        return Ok(selected);
    }

    if let Some(tier) = tier {
        let tiers: Vec<u8> = tier
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<u8>().with_context(|| format!("invalid tier '{}'", s)))
            .collect::<Result<_>>()?;
        return Ok(all
            .into_iter()
            .filter(|e| tiers.contains(&e.meta.tier))
            .collect());
    }

    Ok(all
        .into_iter()
        .filter(|e| e.meta.tier != 3 && !e.meta.needs.contains(&"reference"))
        .collect())
}

/// `gbl qc run <source>` — the single-pass scan.
async fn run_checks(
    source: &str,
    checks: Option<&str>,
    tier: Option<&str>,
    out: Option<&str>,
    max_examples: usize,
    fail_on: FailOn,
    data_type: Option<&str>,
) -> Result<()> {
    let selected = resolve_selection(checks, tier)?;
    if selected.is_empty() {
        anyhow::bail!("no checks selected");
    }

    // Open the source off the async runtime, exactly like `commands/validate.rs`.
    let engine = tokio::task::spawn_blocking({
        let source = source.to_string();
        move || QueryEngine::open_path(&source)
    })
    .await?
    .with_context(|| format!("failed to open source: {}", source))?;

    let ctx = ScanContext::build(&engine, REFERENCE_GENOME)?;
    let cfg = CheckConfig { max_examples };

    // Single streaming pass: fold each partition independently and in parallel,
    // then reduce the partial accumulators associatively (mirrors genohype `summary`).
    let acc = (0..engine.num_partitions())
        .into_par_iter()
        .fold(
            || QcAccumulator::new(&selected, &cfg),
            |mut a, p| {
                if let Ok(iter) = engine.scan_partition_iter(p, &[]) {
                    for row in iter.flatten() {
                        a.process_row(&row, &ctx);
                    }
                }
                a
            },
        )
        .reduce(
            || QcAccumulator::new(&selected, &cfg),
            |mut a, b| {
                a.merge(b);
                a
            },
        );

    let rows_scanned = acc.rows_scanned();
    let results = acc.finalize(&ctx);
    let summary = Summary::tally(&results);

    // Exit-code policy decided before we move `results` into the report.
    let has_fail = results.iter().any(|c| c.status == Status::Fail);
    let has_warn = results.iter().any(|c| c.status == Status::Warn);
    let should_fail = match fail_on {
        FailOn::Fail => has_fail,
        FailOn::Warn => has_fail || has_warn,
    };

    let report = Report {
        schema_version: SCHEMA_VERSION,
        source: source.to_string(),
        dataset_id: None,
        reference_genome: REFERENCE_GENOME.to_string(),
        data_type: data_type.unwrap_or("wgs").to_string(),
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        rows_scanned,
        summary,
        checks: results,
    };

    let json = serde_json::to_string_pretty(&report).context("failed to serialize report")?;
    match out {
        Some(path) => {
            std::fs::write(path, json).with_context(|| format!("failed to write report to {}", path))?;
            eprintln!(
                "qc: scanned {} rows, {} pass / {} warn / {} fail -> {}",
                report.rows_scanned,
                report.summary.pass,
                report.summary.warn,
                report.summary.fail,
                path
            );
        }
        None => println!("{}", json),
    }

    // The report is always written; only then do we signal via exit code.
    if should_fail {
        std::process::exit(1);
    }

    Ok(())
}
