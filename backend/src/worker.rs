//! GBL distributed worker implementation.
//!
//! Implements `genohype_pool::TaskHandler` so the GBL binary can act as a
//! distributed worker node. When the coordinator assigns a task, the handler
//! deserializes the payload and executes the appropriate ETL operation
//! (typically a sharded `gbl load` for a specific partition range).

use anyhow::{bail, Context, Result};
use genohype_pool::distributed::message::TaskDescriptor;
use genohype_pool::{TaskHandler, TaskResult};
use serde_json::Value;
use std::process::Command;
use std::sync::Arc;
use tracing::info;

/// Task handler for GBL distributed ETL tasks.
///
/// Receives task descriptors from the coordinator, each specifying a partition
/// or subset of a Hail table to load into a target backend.
pub struct GblTaskHandler {
    /// Path to genohype binary for export operations
    pub genohype_bin: String,
}

#[genohype_pool::async_trait]
impl TaskHandler for GblTaskHandler {
    async fn handle_task(
        &self,
        payload: &Value,
        tasks: Vec<TaskDescriptor>,
    ) -> std::result::Result<TaskResult, anyhow::Error> {
        let source = payload["source"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing 'source' in job payload"))?;
        let target = payload["target"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing 'target' in job payload"))?;
        let table_type = payload["table_type"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing 'table_type' in job payload"))?;
        let clickhouse_url = payload["clickhouse_url"]
            .as_str()
            .unwrap_or("http://localhost:8123");
        let clickhouse_db = payload["clickhouse_db"]
            .as_str()
            .unwrap_or("default");

        let mut total_rows = 0usize;

        for task in &tasks {
            let partition_id = task.payload.get("partition_id").and_then(|v| v.as_u64());
            let interval = task.payload.get("interval").and_then(|v| v.as_str());

            info!(
                "Processing task {} (partition: {:?}, interval: {:?})",
                task.id, partition_id, interval
            );

            let rows = match target {
                "clickhouse" => {
                    self.load_clickhouse_partition(
                        source,
                        clickhouse_url,
                        clickhouse_db,
                        table_type,
                        partition_id,
                        interval,
                    )
                    .await?
                }
                "duckdb" => {
                    self.load_duckdb_partition(source, table_type, partition_id, interval)
                        .await?
                }
                other => bail!("unsupported target backend: {}", other),
            };

            total_rows += rows;
            info!("Task {} complete: {} rows", task.id, rows);
        }

        Ok(TaskResult::success(total_rows, None))
    }
}

impl GblTaskHandler {
    /// Load a partition into ClickHouse by shelling out to genohype export.
    async fn load_clickhouse_partition(
        &self,
        source: &str,
        clickhouse_url: &str,
        _clickhouse_db: &str,
        table_type: &str,
        partition_id: Option<u64>,
        interval: Option<&str>,
    ) -> Result<usize> {
        let staging_table = format!("staging_{}_raw", table_type);

        let genohype_bin = self.genohype_bin.clone();
        let source = source.to_string();
        let clickhouse_url = clickhouse_url.to_string();
        let staging_table = staging_table.clone();
        let partition_id = partition_id;
        let interval = interval.map(|s| s.to_string());

        // Shell out to genohype in a blocking task
        let result = tokio::task::spawn_blocking(move || {
            let mut cmd = Command::new(&genohype_bin);
            cmd.arg("export")
                .arg("clickhouse")
                .arg(&source)
                .arg(&clickhouse_url)
                .arg(&staging_table);

            if let Some(pid) = partition_id {
                cmd.arg("--partition").arg(pid.to_string());
            }
            if let Some(ref interval) = interval {
                cmd.arg("--interval").arg(interval);
            }

            cmd.stdin(std::process::Stdio::inherit())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit());

            info!("Running: {:?}", cmd);

            let status = cmd
                .status()
                .context("Failed to run genohype export clickhouse")?;

            if !status.success() {
                bail!(
                    "genohype export clickhouse failed with status: {}",
                    status
                );
            }

            // We don't have a precise row count from the shell-out;
            // return 1 to indicate success
            Ok::<usize, anyhow::Error>(1)
        })
        .await??;

        Ok(result)
    }

    /// Load a partition to local Parquet for DuckDB.
    async fn load_duckdb_partition(
        &self,
        source: &str,
        table_type: &str,
        partition_id: Option<u64>,
        interval: Option<&str>,
    ) -> Result<usize> {
        let filename = format!("{}.parquet", table_type);
        let output_path = format!("data/{}", filename);

        let genohype_bin = self.genohype_bin.clone();
        let source = source.to_string();
        let partition_id = partition_id;
        let interval = interval.map(|s| s.to_string());

        let result = tokio::task::spawn_blocking(move || {
            let mut cmd = Command::new(&genohype_bin);
            cmd.arg("export").arg("parquet").arg(&source).arg(&output_path);

            if let Some(pid) = partition_id {
                cmd.arg("--partition").arg(pid.to_string());
            }
            if let Some(ref interval) = interval {
                cmd.arg("--interval").arg(interval);
            }

            cmd.stdin(std::process::Stdio::inherit())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit());

            info!("Running: {:?}", cmd);

            let status = cmd
                .status()
                .context("Failed to run genohype export parquet")?;

            if !status.success() {
                bail!("genohype export parquet failed with status: {}", status);
            }

            Ok::<usize, anyhow::Error>(1)
        })
        .await??;

        Ok(result)
    }
}

/// Start the worker loop, polling the coordinator for tasks.
pub async fn run_worker(
    coordinator_url: &str,
    worker_id: Option<&str>,
    poll_interval_ms: u64,
    genohype_bin: &str,
) -> Result<()> {
    let handler = Arc::new(GblTaskHandler {
        genohype_bin: genohype_bin.to_string(),
    });

    let worker_config = genohype_pool::distributed::WorkerConfig {
        coordinator_url: coordinator_url.to_string(),
        worker_id: worker_id.unwrap_or("auto").to_string(),
        poll_interval_ms,
        build_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        ..Default::default()
    };

    info!(
        "Starting GBL worker (coordinator: {}, id: {})",
        coordinator_url, worker_config.worker_id
    );

    genohype_pool::distributed::worker::run_worker(worker_config, handler).await?;

    Ok(())
}
