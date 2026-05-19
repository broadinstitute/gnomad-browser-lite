use clap::{Parser, Subcommand};

/// gnomAD Browser Lite — multi-backend genomic data browser
#[derive(Parser, Debug)]
#[command(name = "gbl", version, about)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Start the REST API server
    Serve {
        /// Path to gbl.toml configuration file
        #[arg(short, long)]
        config: Option<String>,

        /// Port to listen on (overrides config and PORT env var)
        #[arg(short, long)]
        port: Option<u16>,
    },

    /// Validate a source table against the expected gnomAD schema
    Validate {
        /// Path to a Hail table (.ht directory), VCF file, or Parquet file
        source: String,

        /// Optional JSON schema file to validate against.
        /// If not provided, generates a schema from the source and validates structure.
        #[arg(short, long)]
        schema: Option<String>,

        /// Number of rows to sample for validation (default: 100)
        #[arg(short = 'n', long, default_value = "100")]
        sample_size: usize,

        /// Show verbose per-row validation results
        #[arg(short, long)]
        verbose: bool,

        /// Stop on first validation error
        #[arg(long)]
        fail_fast: bool,

        /// Generate a JSON schema from the source and write to this file
        #[arg(long)]
        generate_schema: Option<String>,
    },
}
