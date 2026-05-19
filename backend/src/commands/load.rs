//! `gbl load` command implementation.
//!
//! ETL pipeline for loading gnomAD data into target backends:
//!
//! - **ClickHouse**: Staging → Transform → Target pattern with embedded SQL.
//!   1. Create target table (DDL)
//!   2. Shell out to `genohype export clickhouse` to load raw Hail data into staging
//!   3. Execute transform SQL to flatten nested schema into target table
//!   4. Drop staging table
//!
//! - **DuckDB**: Export Hail table to Parquet via genohype-core's ParquetWriter.
//!   The Parquet files are placed in the output directory where DuckDB mounts them as views.

use anyhow::{bail, Context, Result};
use std::process::Command;
use tracing::info;

use crate::cli::{InitStrategy, TableType, TargetBackend};

// Embedded SQL for ClickHouse ETL
const GENES_DDL: &str = include_str!("../../sql/genes_ddl.sql");
const GENES_TRANSFORM: &str = include_str!("../../sql/genes_transform.sql");
const VARIANTS_DDL: &str = include_str!("../../sql/variants_ddl.sql");
const VARIANTS_TRANSFORM: &str = include_str!("../../sql/variants_transform.sql");

/// Table configuration for the staging→transform pipeline.
struct TableConfig {
    name: &'static str,
    staging_name: &'static str,
    ddl_sql: &'static str,
    transform_sql: &'static str,
}

impl TableConfig {
    fn genes() -> Self {
        Self {
            name: "genes",
            staging_name: "staging_genes_raw",
            ddl_sql: GENES_DDL,
            transform_sql: GENES_TRANSFORM,
        }
    }

    fn variants() -> Self {
        Self {
            name: "variants",
            staging_name: "staging_variants_raw",
            ddl_sql: VARIANTS_DDL,
            transform_sql: VARIANTS_TRANSFORM,
        }
    }
}

/// Run the load command.
pub async fn run(
    source: &str,
    target: TargetBackend,
    table_type: TableType,
    filter: Option<&str>,
    clickhouse_url: &str,
    clickhouse_db: &str,
    output_dir: &str,
    init_strategy: InitStrategy,
    genohype_bin: &str,
    keep_staging: bool,
    limit: Option<u64>,
) -> Result<()> {
    match target {
        TargetBackend::ClickHouse => {
            let config = match table_type {
                TableType::Genes => TableConfig::genes(),
                TableType::Variants => TableConfig::variants(),
            };
            load_clickhouse(
                &config,
                source,
                filter,
                clickhouse_url,
                clickhouse_db,
                init_strategy,
                genohype_bin,
                keep_staging,
                limit,
            )
            .await
        }
        TargetBackend::DuckDb => {
            load_duckdb(source, table_type, output_dir, genohype_bin, limit).await
        }
    }
}

/// ClickHouse ETL: staging → transform → target
async fn load_clickhouse(
    config: &TableConfig,
    source: &str,
    filter: Option<&str>,
    clickhouse_url: &str,
    database: &str,
    init_strategy: InitStrategy,
    genohype_bin: &str,
    keep_staging: bool,
    limit: Option<u64>,
) -> Result<()> {
    info!(
        "Loading {} from {} -> ClickHouse ({})",
        config.name, source, clickhouse_url
    );

    // Step 1: Prepare target table
    info!("Step 1: Preparing target table '{}'...", config.name);
    prepare_target_table(config, clickhouse_url, database, init_strategy).await?;

    // Step 2: Drop old staging table
    info!(
        "Step 2: Dropping staging table '{}' if exists...",
        config.staging_name
    );
    execute_clickhouse_sql(
        clickhouse_url,
        database,
        &format!("DROP TABLE IF EXISTS {}", config.staging_name),
    )
    .await?;

    // Step 3: Load raw data into staging via genohype export
    info!(
        "Step 3: Loading raw data to staging table '{}'...",
        config.staging_name
    );
    run_genohype_export(
        genohype_bin,
        source,
        clickhouse_url,
        config.staging_name,
        limit,
    )?;

    // Step 4: Transform staging -> target
    info!("Step 4: Transforming staging -> target...");
    let transform_sql = if let Some(filter_expr) = filter {
        format!("{} WHERE {}", config.transform_sql, filter_expr)
    } else {
        config.transform_sql.to_string()
    };
    execute_clickhouse_sql(clickhouse_url, database, &transform_sql).await?;

    // Step 5: Verify row counts
    info!("Step 5: Verifying row counts...");
    let staging_count = get_row_count(clickhouse_url, database, config.staging_name).await?;
    let target_count = get_row_count(clickhouse_url, database, config.name).await?;
    info!(
        "  Staging '{}': {} rows",
        config.staging_name, staging_count
    );
    info!("  Target '{}': {} rows", config.name, target_count);

    // Step 6: Cleanup staging
    if keep_staging {
        info!(
            "Step 6: Keeping staging table '{}' (--keep-staging)",
            config.staging_name
        );
    } else {
        info!("Step 6: Dropping staging table '{}'...", config.staging_name);
        execute_clickhouse_sql(
            clickhouse_url,
            database,
            &format!("DROP TABLE IF EXISTS {}", config.staging_name),
        )
        .await?;
    }

    info!(
        "Successfully loaded {} ({} rows)",
        config.name, target_count
    );
    Ok(())
}

/// DuckDB ETL: export Hail table to Parquet via genohype-core's ParquetWriter.
async fn load_duckdb(
    source: &str,
    table_type: TableType,
    output_dir: &str,
    genohype_bin: &str,
    limit: Option<u64>,
) -> Result<()> {
    let filename = match table_type {
        TableType::Genes => "genes.parquet",
        TableType::Variants => "variants.parquet",
    };
    let output_path = std::path::Path::new(output_dir).join(filename);

    info!(
        "Exporting {} from {} -> {}",
        filename,
        source,
        output_path.display()
    );

    // Ensure output directory exists
    std::fs::create_dir_all(output_dir)
        .with_context(|| format!("Failed to create output directory: {}", output_dir))?;

    // Use genohype export parquet to write directly
    let mut cmd = Command::new(genohype_bin);
    cmd.arg("export")
        .arg("parquet")
        .arg(source)
        .arg(output_path.to_str().unwrap());

    if let Some(limit) = limit {
        cmd.arg("--limit").arg(limit.to_string());
    }

    info!("Running: {:?}", cmd);

    let status = cmd
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .status()
        .context("Failed to run genohype export parquet")?;

    if !status.success() {
        bail!(
            "genohype export parquet exited with status: {}",
            status
        );
    }

    info!("Successfully exported {}", output_path.display());
    Ok(())
}

/// Prepare the target table based on init strategy.
async fn prepare_target_table(
    config: &TableConfig,
    url: &str,
    database: &str,
    strategy: InitStrategy,
) -> Result<()> {
    match strategy {
        InitStrategy::Create => {
            execute_clickhouse_sql(url, database, config.ddl_sql).await?;
        }
        InitStrategy::Replace => {
            execute_clickhouse_sql(
                url,
                database,
                &format!("DROP TABLE IF EXISTS {}", config.name),
            )
            .await?;
            execute_clickhouse_sql(url, database, config.ddl_sql).await?;
        }
        InitStrategy::Append => {
            execute_clickhouse_sql(url, database, config.ddl_sql).await?;
        }
    }
    Ok(())
}

/// Execute SQL against ClickHouse via HTTP (using curl).
/// Handles multi-statement SQL by splitting on semicolons.
async fn execute_clickhouse_sql(url: &str, database: &str, sql: &str) -> Result<()> {
    let statements = split_sql_statements(sql);
    for statement in &statements {
        execute_single_sql(url, database, statement).await?;
    }
    Ok(())
}

/// Split SQL text into individual statements by semicolons.
fn split_sql_statements(sql: &str) -> Vec<String> {
    sql.split(';')
        .map(|s| s.trim())
        .filter(|s| {
            !s.is_empty()
                && !s.lines().all(|line| {
                    let trimmed = line.trim();
                    trimmed.is_empty() || trimmed.starts_with("--")
                })
        })
        .map(|s| s.to_string())
        .collect()
}

/// Execute a single SQL statement against ClickHouse.
async fn execute_single_sql(url: &str, database: &str, sql: &str) -> Result<()> {
    let full_url = format!("{}/?database={}", url, database);

    let output = Command::new("curl")
        .arg("-sS")
        .arg("--fail-with-body")
        .arg(&full_url)
        .arg("-d")
        .arg(sql)
        .output()
        .context("Failed to execute curl command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        bail!(
            "ClickHouse SQL failed:\nSQL: {}\nstderr: {}\nstdout: {}",
            sql.chars().take(200).collect::<String>(),
            stderr,
            stdout
        );
    }

    Ok(())
}

/// Get row count from a ClickHouse table.
async fn get_row_count(url: &str, database: &str, table: &str) -> Result<u64> {
    let full_url = format!("{}/?database={}", url, database);
    let sql = format!("SELECT count() FROM {}", table);

    let output = Command::new("curl")
        .arg("-sS")
        .arg(&full_url)
        .arg("-d")
        .arg(&sql)
        .output()
        .context("Failed to execute curl command")?;

    if !output.status.success() {
        return Ok(0);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .trim()
        .parse()
        .context("Failed to parse row count")
}

/// Shell out to `genohype export clickhouse` to load raw Hail data into a staging table.
fn run_genohype_export(
    genohype_bin: &str,
    source: &str,
    clickhouse_url: &str,
    staging_table: &str,
    limit: Option<u64>,
) -> Result<()> {
    let mut cmd = Command::new(genohype_bin);
    cmd.arg("export")
        .arg("clickhouse")
        .arg(source)
        .arg(clickhouse_url)
        .arg(staging_table);

    if let Some(limit) = limit {
        cmd.arg("--limit").arg(limit.to_string());
    }

    info!("Running: {:?}", cmd);

    let status = cmd
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .status()
        .context("Failed to run genohype export clickhouse")?;

    if !status.success() {
        tracing::warn!(
            "genohype export clickhouse exited with status: {} — some partitions may have \
             failed. Continuing with transform (staging data may be incomplete).",
            status
        );
    }

    Ok(())
}
