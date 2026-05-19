//! `gbl clickhouse` infrastructure command implementation.
//!
//! Thin porcelain wrapper around `genohype clickhouse` CLI commands for
//! ClickHouse VM provisioning on GCP. Uses shell-out via `std::process::Command`
//! because the ClickHouse VM management logic lives in the `genohype` CLI
//! binary crate, not in a library crate.

use anyhow::{bail, Context, Result};
use std::process::{Command, Stdio};
use tracing::info;

use crate::cli::ClickhouseCommands;

/// Run a clickhouse infrastructure subcommand.
pub fn run(cmd: &ClickhouseCommands) -> Result<()> {
    match cmd {
        ClickhouseCommands::Create {
            name,
            profile,
            machine_type,
            disk_size_gb,
            zone,
        } => {
            info!("Creating ClickHouse instance '{}'...", name);

            let mut args = vec!["clickhouse".to_string(), "create".to_string(), name.clone()];

            if let Some(p) = profile {
                args.push("--profile".to_string());
                args.push(p.clone());
            }
            if let Some(mt) = machine_type {
                args.push("--machine-type".to_string());
                args.push(mt.clone());
            }
            if let Some(ds) = disk_size_gb {
                args.push("--disk-size-gb".to_string());
                args.push(ds.to_string());
            }
            if let Some(z) = zone {
                args.push("--zone".to_string());
                args.push(z.clone());
            }

            run_genohype(&args)
        }

        ClickhouseCommands::Destroy { name, yes } => {
            info!("Destroying ClickHouse instance '{}'...", name);

            let mut args = vec![
                "clickhouse".to_string(),
                "destroy".to_string(),
                name.clone(),
            ];

            if *yes {
                args.push("--yes".to_string());
            }

            run_genohype(&args)
        }

        ClickhouseCommands::Tunnel { name, port } => {
            info!(
                "Creating IAP tunnel to '{}' on local port {}...",
                name, port
            );

            let args = vec![
                "clickhouse".to_string(),
                "tunnel".to_string(),
                name.clone(),
                "--port".to_string(),
                port.to_string(),
            ];

            run_genohype(&args)
        }
    }
}

/// Shell out to the `genohype` binary with the given arguments.
/// Inherits stdin/stdout/stderr for interactive output (e.g., Terraform progress bars).
fn run_genohype(args: &[String]) -> Result<()> {
    let genohype_bin =
        std::env::var("GENOHYPE_BIN").unwrap_or_else(|_| "genohype".to_string());

    info!("Running: {} {}", genohype_bin, args.join(" "));

    let status = Command::new(&genohype_bin)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| {
            format!(
                "Failed to run '{}'. Is genohype installed and on PATH?",
                genohype_bin
            )
        })?;

    if !status.success() {
        bail!(
            "genohype {} exited with status: {}",
            args.first().unwrap_or(&String::new()),
            status
        );
    }

    Ok(())
}
