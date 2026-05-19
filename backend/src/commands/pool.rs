//! `gbl pool` command implementation.
//!
//! Native integration with genohype-pool library for GCP worker pool
//! provisioning and distributed job submission.

use anyhow::{Context, Result};
use genohype_pool::{CloudPoolManager, LocalPoolManager, SubmitOptions};
use serde_json::json;
use tracing::info;

use crate::cli::{PoolCommands, TargetBackend, TableType};

/// Run a pool subcommand.
pub async fn run(cmd: &PoolCommands) -> Result<()> {
    // Use LocalPoolManager for now; CloudPoolManager requires GCP credentials
    // and will be wired up when running on GCP infrastructure.
    let manager = LocalPoolManager::new();

    match cmd {
        PoolCommands::Create {
            name,
            num_workers,
            machine_type,
            spot,
        } => {
            info!(
                "Creating pool '{}' with {} workers (type: {}, spot: {})",
                name, num_workers, machine_type, spot
            );
            manager
                .create_pool(name, *num_workers, machine_type, *spot)
                .await
                .context("Failed to create pool")?;
            info!("Pool '{}' created successfully", name);
            Ok(())
        }

        PoolCommands::Submit {
            pool,
            source,
            target,
            table_type,
            clickhouse_url,
            clickhouse_db,
            skip_build: _,
            force: _,
        } => {
            info!(
                "Submitting distributed load job to pool '{}': {} -> {:?}/{:?}",
                pool, source, target, table_type
            );

            let target_str = match target {
                TargetBackend::DuckDb => "duckdb",
                TargetBackend::ClickHouse => "clickhouse",
            };
            let table_type_str = match table_type {
                TableType::Genes => "genes",
                TableType::Variants => "variants",
            };

            let payload = json!({
                "source": source,
                "target": target_str,
                "table_type": table_type_str,
                "clickhouse_url": clickhouse_url,
                "clickhouse_db": clickhouse_db,
            });

            let options = SubmitOptions {
                pool_name: pool.clone(),
                target_binary: std::env::current_exe()
                    .unwrap_or_else(|_| "gbl".into())
                    .to_string_lossy()
                    .to_string(),
                args: vec![
                    "worker".to_string(),
                    "--coordinator-url".to_string(),
                    "COORDINATOR_URL".to_string(),
                ],
                payload,
                input_path: source.clone(),
                num_workers: 0, // Use pool's existing worker count
                machine_type: String::new(),
                spot: false,
                zone: None,
                env_vars: Default::default(),
                labels: Default::default(),
            };

            let job_id = manager
                .submit(options)
                .await
                .context("Failed to submit job")?;
            info!("Job submitted: {}", job_id);
            Ok(())
        }

        PoolCommands::Status { name } => {
            let status = manager
                .get_status(name)
                .await
                .context("Failed to get pool status")?;
            println!("Pool: {}", status.name);
            println!("  Active workers: {}", status.active_workers);
            println!("  Idle workers: {}", status.idle_workers);
            println!("  Healthy: {}", status.healthy);
            if let Some(url) = &status.coordinator_url {
                println!("  Coordinator: {}", url);
            }
            Ok(())
        }

        PoolCommands::Destroy { name } => {
            info!("Destroying pool '{}'...", name);
            manager
                .destroy_pool(name)
                .await
                .context("Failed to destroy pool")?;
            info!("Pool '{}' destroyed", name);
            Ok(())
        }
    }
}
