use clap::{Parser, Subcommand, ValueEnum};

/// gnomAD Browser Lite — multi-backend genomic data browser
#[derive(Parser, Debug)]
#[command(name = "gbl", version, about)]
pub struct Cli {
    /// Path to gbl.toml configuration file (global, used by serve and mcp commands)
    #[arg(short, long, global = true)]
    pub config: Option<String>,

    #[command(subcommand)]
    pub command: Option<Commands>,
}

/// Target backend for the load command.
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum TargetBackend {
    /// Load into DuckDB via Parquet files
    DuckDb,
    /// Load into ClickHouse via staging→transform ETL
    ClickHouse,
}

/// Table type to load.
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum TableType {
    /// Gene models table
    Genes,
    /// Variant sites table
    Variants,
}

/// Initialization strategy for ClickHouse table loading.
#[derive(Debug, Clone, Copy, Default, ValueEnum)]
pub enum InitStrategy {
    /// Create table if it doesn't exist, fail if it does
    Create,
    /// Drop and recreate table (default)
    #[default]
    Replace,
    /// Append to existing table
    Append,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Start the REST API server
    Serve {
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

    /// Load data from a source into a target backend (ETL pipeline)
    ///
    /// For ClickHouse: uses staging→transform→target pattern with embedded SQL.
    /// For DuckDB: exports to Parquet files that DuckDB reads as views.
    Load {
        /// Path to the source Hail table (.ht directory)
        source: String,

        /// Target backend to load into
        #[arg(long, value_enum)]
        target: TargetBackend,

        /// Type of table to load
        #[arg(long, value_enum)]
        table_type: TableType,

        /// Optional filter expression appended as WHERE clause (ClickHouse target)
        /// or applied during export (DuckDB target).
        /// Example: "locus.contig = 'chr1'"
        #[arg(long)]
        filter: Option<String>,

        /// ClickHouse HTTP URL (for ClickHouse target)
        #[arg(long, default_value = "http://localhost:8123")]
        clickhouse_url: String,

        /// ClickHouse database name (for ClickHouse target)
        #[arg(long, default_value = "default")]
        clickhouse_db: String,

        /// Output directory for Parquet files (for DuckDB target)
        #[arg(long, default_value = "data")]
        output_dir: String,

        /// Initialization strategy for ClickHouse tables
        #[arg(long, value_enum, default_value = "replace")]
        init_strategy: InitStrategy,

        /// Path to the genohype binary (used for ClickHouse staging export)
        #[arg(long, default_value = "genohype")]
        genohype_bin: String,

        /// Keep staging table after transform (for debugging)
        #[arg(long)]
        keep_staging: bool,

        /// Row limit for testing (passed to genohype export)
        #[arg(long)]
        limit: Option<u64>,
    },

    /// Manage GCP worker pools (native genohype-pool integration)
    #[command(subcommand)]
    Pool(PoolCommands),

    /// Run as a distributed worker node
    Worker {
        /// Coordinator URL to poll for tasks
        #[arg(long)]
        coordinator_url: String,

        /// Worker ID (auto-generated if not provided)
        #[arg(long)]
        worker_id: Option<String>,

        /// Poll interval in milliseconds
        #[arg(long, default_value = "1000")]
        poll_interval_ms: u64,

        /// Path to the genohype binary (used for export tasks)
        #[arg(long, default_value = "genohype")]
        genohype_bin: String,
    },

    /// Manage ClickHouse infrastructure on GCP
    #[command(subcommand)]
    Clickhouse(ClickhouseCommands),

    /// Run the MCP (Model Context Protocol) server
    #[command(subcommand)]
    Mcp(McpCommands),
}

/// MCP server transport subcommands.
#[derive(Subcommand, Debug)]
pub enum McpCommands {
    /// Run MCP server over stdin/stdout (for CopilotKit bridge or Claude Desktop)
    Stdio,
}

/// Pool management subcommands using genohype-pool native library.
#[derive(Subcommand, Debug)]
pub enum PoolCommands {
    /// Create a new GCP worker pool
    Create {
        /// Pool name
        name: String,

        /// Number of worker VMs
        #[arg(long, default_value = "2")]
        num_workers: usize,

        /// GCP machine type
        #[arg(long, default_value = "e2-standard-4")]
        machine_type: String,

        /// Use spot/preemptible VMs
        #[arg(long)]
        spot: bool,
    },

    /// Submit a distributed load job to the pool
    Submit {
        /// Pool name
        pool: String,

        /// Source Hail table path
        source: String,

        /// Target backend for loading
        #[arg(long, value_enum)]
        target: TargetBackend,

        /// Table type to load
        #[arg(long, value_enum)]
        table_type: TableType,

        /// ClickHouse URL (for ClickHouse target)
        #[arg(long, default_value = "http://localhost:8123")]
        clickhouse_url: String,

        /// ClickHouse database
        #[arg(long, default_value = "default")]
        clickhouse_db: String,

        /// Skip building the binary (use pre-staged)
        #[arg(long)]
        skip_build: bool,

        /// Force resubmit even if a job is already running
        #[arg(long)]
        force: bool,
    },

    /// Get pool status
    Status {
        /// Pool name
        name: String,
    },

    /// Destroy a worker pool
    Destroy {
        /// Pool name
        name: String,
    },
}

/// ClickHouse infrastructure subcommands (shells out to `genohype clickhouse`).
#[derive(Subcommand, Debug)]
pub enum ClickhouseCommands {
    /// Create a ClickHouse VM on GCP
    Create {
        /// Instance name
        name: String,

        /// Profile name from config file
        #[arg(long)]
        profile: Option<String>,

        /// GCP machine type (overrides profile)
        #[arg(long)]
        machine_type: Option<String>,

        /// Boot disk size in GB (overrides profile)
        #[arg(long)]
        disk_size_gb: Option<u32>,

        /// GCP zone (overrides profile/defaults)
        #[arg(long)]
        zone: Option<String>,
    },

    /// Destroy a ClickHouse VM
    Destroy {
        /// Instance name
        name: String,

        /// Skip confirmation prompt
        #[arg(long, short = 'y')]
        yes: bool,
    },

    /// Create an IAP tunnel to a ClickHouse instance
    Tunnel {
        /// Instance name
        name: String,

        /// Local port to bind
        #[arg(long, default_value = "8123")]
        port: u16,
    },
}
