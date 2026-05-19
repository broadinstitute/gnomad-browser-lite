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
}
