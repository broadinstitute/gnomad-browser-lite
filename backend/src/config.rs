use anyhow::Result;
use serde::Deserialize;
use std::path::Path;

use crate::backend::hail::{DEFAULT_GENES_PATH, DEFAULT_VARIANTS_PATH};

/// Top-level configuration, typically loaded from `gbl.toml`.
#[derive(Debug, Deserialize)]
pub struct Config {
    pub backend: BackendConfig,
}

/// Discriminated union for backend selection.
///
/// In TOML, the `type` field selects the variant:
///
/// ```toml
/// [backend]
/// type = "hail"
/// variants_path = "gs://..."
/// genes_path = "gs://..."
/// ```
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BackendConfig {
    DuckDb {
        data_dir: String,
    },
    Hail {
        variants_path: String,
        genes_path: String,
    },
    Tiered {
        fast: Box<BackendConfig>,
        fallback: Box<BackendConfig>,
    },
}

impl Default for Config {
    /// Zero-config default: Hail backend pointing at public gnomAD GCS tables.
    fn default() -> Self {
        Config {
            backend: BackendConfig::Hail {
                variants_path: DEFAULT_VARIANTS_PATH.to_string(),
                genes_path: DEFAULT_GENES_PATH.to_string(),
            },
        }
    }
}

impl Config {
    /// Load configuration from a TOML file, or return the zero-config default.
    ///
    /// - If `path` is `Some` and the file exists, parse it.
    /// - If `path` is `None` or the file doesn't exist, return `Config::default()`.
    pub fn load(path: Option<&str>) -> Result<Self> {
        match path {
            Some(p) if Path::new(p).exists() => {
                let contents = std::fs::read_to_string(p)?;
                let config: Config = toml::from_str(&contents)?;
                Ok(config)
            }
            _ => Ok(Config::default()),
        }
    }
}
