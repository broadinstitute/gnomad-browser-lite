//! `gbl validate` command implementation.
//!
//! Validates source data (Hail tables, VCFs) against the expected gnomAD schema
//! contract using genohype-core's schema validation module. This ensures data
//! conforms to the expected structure before ETL into ClickHouse or DuckDB.

use anyhow::{Context, Result};
use genohype_core::query::QueryEngine;
use genohype_core::validation::{SchemaGenerator, SchemaValidator};

/// Run the validate command.
pub async fn run(
    source: &str,
    schema_path: Option<&str>,
    sample_size: usize,
    verbose: bool,
    fail_fast: bool,
    generate_schema_path: Option<&str>,
) -> Result<()> {
    println!("Opening source: {}", source);

    // Open the source table via genohype-core's QueryEngine
    let engine = tokio::task::spawn_blocking({
        let source = source.to_string();
        move || QueryEngine::open_path(&source)
    })
    .await?
    .context("Failed to open source table")?;

    println!(
        "  Partitions: {}, Key fields: {:?}",
        engine.num_partitions(),
        engine.key_fields()
    );

    if let Some(total) = engine.total_rows() {
        println!("  Total rows: {}", total);
    }

    // Handle schema generation mode
    if let Some(out_path) = generate_schema_path {
        println!("\nGenerating JSON schema...");
        let schema = SchemaGenerator::from_engine(&engine, Some("gnomAD variant schema"))
            .context("Failed to generate schema")?;
        SchemaGenerator::write_to_file(&schema, out_path)
            .with_context(|| format!("Failed to write schema to {}", out_path))?;
        println!("Schema written to {}", out_path);
        return Ok(());
    }

    // Build the validator
    let validator = if let Some(schema_file) = schema_path {
        println!("\nLoading schema from: {}", schema_file);
        SchemaValidator::from_file(schema_file)
            .with_context(|| format!("Failed to load schema from {}", schema_file))?
    } else {
        // Auto-generate schema from the source and validate structure consistency
        println!("\nNo schema file provided — generating schema from source for structural validation...");
        let schema = SchemaGenerator::from_engine(&engine, Some("auto-generated"))
            .context("Failed to generate schema from source")?;
        SchemaValidator::from_value(&schema).context("Failed to create validator from generated schema")?
    };

    // Run validation
    println!(
        "\nValidating {} rows (verbose={}, fail_fast={})...\n",
        sample_size, verbose, fail_fast
    );

    let report = if verbose {
        validator.validate_sample_verbose(&engine, sample_size, fail_fast)?
    } else {
        validator.validate_sample(&engine, sample_size, fail_fast)?
    };

    // Print report
    println!("\n{}", report);

    if report.invalid_count > 0 {
        std::process::exit(1);
    }

    Ok(())
}
