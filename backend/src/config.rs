use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::backend::elasticsearch::{DEFAULT_GENES_INDEX, DEFAULT_VARIANTS_INDEX};
use crate::backend::hail::{DEFAULT_GENES_PATH, DEFAULT_VARIANTS_PATH};

fn default_es_variants_index() -> String {
    DEFAULT_VARIANTS_INDEX.to_string()
}

fn default_es_genes_index() -> String {
    DEFAULT_GENES_INDEX.to_string()
}

fn default_tier_genes_path() -> String {
    DEFAULT_GENES_PATH.to_string()
}

/// Default splice buffer (bp) added on each side of every CDS exon for the
/// `tiered-cds` hot set, so canonical/extended splice-region variants just
/// outside the coding bounds still route to the fast tier.
pub const DEFAULT_CDS_SPLICE_BUFFER: i64 = 25;

/// Default flank (bp) added on each side of the gene body for the
/// `tiered-genebody` hot set (regulatory buffer — DESIGN.md: "+10kb buffer").
pub const DEFAULT_GENEBODY_BUFFER: i64 = 10_000;

fn default_cds_splice_buffer() -> i64 {
    DEFAULT_CDS_SPLICE_BUFFER
}

fn default_genebody_buffer() -> i64 {
    DEFAULT_GENEBODY_BUFFER
}

/// Which gene-derived intervals make up the "hot" set served by the tiered
/// router's fast tier. Selects between the two benchmark sub-arms.
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TierRouting {
    /// `tiered-cds`: hot set = CDS exons + splice buffer (~1.5% of genome).
    /// Gene-view region queries span introns and fall to the cold tier.
    #[default]
    Cds,
    /// `tiered-genebody`: hot set = full gene bodies + flank (~45% of genome).
    /// Gene-view region queries stay hot.
    Genebody,
}

/// An external link shown in the navbar or on pages.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExternalLink {
    pub label: String,
    pub url: String,
}

/// White-label branding configuration, loaded from `[branding]` in `gbl.toml`.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct BrandingConfig {
    pub name: String,
    pub short_name: Option<String>,
    pub full_title: Option<String>,
    pub navbar_color: Option<String>,
    pub navbar_text_color: Option<String>,
    pub accent_color: Option<String>,
    pub logo_url: Option<String>,
    pub favicon_url: Option<String>,
    /// Resolved markdown content for the homepage (read from file during load).
    #[serde(default)]
    pub homepage_content: Option<String>,
    /// Resolved markdown content for the about page.
    #[serde(default)]
    pub about_content: Option<String>,
    /// Resolved markdown content for the terms page.
    #[serde(default)]
    pub terms_content: Option<String>,
    pub external_links: Option<Vec<ExternalLink>>,
}

impl Default for BrandingConfig {
    fn default() -> Self {
        BrandingConfig {
            name: "gnomAD Browser Lite".to_string(),
            short_name: None,
            full_title: None,
            navbar_color: Some("#333".to_string()),
            navbar_text_color: Some("#ffffff".to_string()),
            accent_color: Some("#0066cc".to_string()),
            logo_url: None,
            favicon_url: None,
            homepage_content: None,
            about_content: None,
            terms_content: None,
            external_links: None,
        }
    }
}

/// Top-level configuration, typically loaded from `gbl.toml`.
#[derive(Debug, Deserialize)]
pub struct Config {
    pub backend: BackendConfig,
    pub branding: Option<BrandingConfig>,
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
        /// Path to gnomAD constraint metrics Hail table (optional).
        constraint_path: Option<String>,
        /// Path to GFF3 for on-the-fly VEP annotation (enables AnnotatingDataSource wrapping).
        vep_gff3: Option<String>,
        /// Path to reference FASTA for HGVS notation (requires vep_gff3).
        vep_fasta: Option<String>,
    },
    ClickHouse {
        url: String,
        database: String,
    },
    /// Postgres JSONB wide-table backend (benchmark arm `postgres`).
    ///
    /// ```toml
    /// [backend]
    /// type = "postgres"
    /// database_url = "postgres://user:pass@localhost:5432/gnomad"
    /// ```
    Postgres {
        database_url: String,
    },
    /// Elasticsearch backend (benchmark arm `es`, the prod baseline).
    ///
    /// ```toml
    /// [backend]
    /// type = "elasticsearch"
    /// url = "http://localhost:9200"
    /// # optional; default to the prod-style index names:
    /// variants_index = "gnomad_v4_variants"
    /// genes_index = "genes_grch38"
    /// ```
    Elasticsearch {
        url: String,
        #[serde(default = "default_es_variants_index")]
        variants_index: String,
        #[serde(default = "default_es_genes_index")]
        genes_index: String,
    },
    /// Region-aware tiered router (benchmark arms `tiered-cds` / `tiered-genebody`).
    ///
    /// At startup the gene intervals (CDS exons or gene bodies, per `routing`)
    /// are loaded from `genes_path` into an in-memory interval tree. A region
    /// query 100%-contained in the hot set is served by `fast`; any query that
    /// spans a cold gap is routed in its entirety to `fallback` (no API-layer
    /// scatter/gather).
    ///
    /// ```toml
    /// [backend]
    /// type = "tiered"
    /// routing = "cds"          # or "genebody"
    ///
    /// [backend.fast]
    /// type = "postgres"
    /// database_url = "postgres://localhost/gnomad"
    ///
    /// [backend.fallback]
    /// type = "hail"
    /// variants_path = "gs://..."
    /// genes_path = "gs://..."
    /// ```
    Tiered {
        fast: Box<BackendConfig>,
        fallback: Box<BackendConfig>,
        /// Selects the `tiered-cds` vs `tiered-genebody` hot set. Default: `cds`.
        #[serde(default)]
        routing: TierRouting,
        /// gnomAD genes Hail table the hot intervals are loaded from. Defaults
        /// to the public gnomAD genes table (same as the Hail backend).
        #[serde(default = "default_tier_genes_path")]
        genes_path: String,
        /// Buffer (bp) on each side of every CDS exon (only used for `cds`).
        #[serde(default = "default_cds_splice_buffer")]
        cds_splice_buffer: i64,
        /// Buffer (bp) on each side of the gene body (only used for `genebody`).
        #[serde(default = "default_genebody_buffer")]
        genebody_buffer: i64,
    },
}

impl Default for Config {
    /// Zero-config default: Hail backend pointing at public gnomAD GCS tables.
    fn default() -> Self {
        Config {
            backend: BackendConfig::Hail {
                variants_path: DEFAULT_VARIANTS_PATH.to_string(),
                genes_path: DEFAULT_GENES_PATH.to_string(),
                constraint_path: None,
                vep_gff3: None,
                vep_fasta: None,
            },
            branding: None,
        }
    }
}

/// If `value` looks like a file path, read it relative to `base_dir`
/// and convert markdown to HTML.
fn resolve_markdown_field(value: &mut Option<String>, base_dir: &Path) {
    let Some(v) = value.as_deref() else { return };
    let trimmed = v.trim();
    if trimmed.ends_with(".md") || trimmed.ends_with(".markdown") || trimmed.ends_with(".txt") {
        let file_path = base_dir.join(trimmed);
        match std::fs::read_to_string(&file_path) {
            Ok(contents) => {
                let parser = pulldown_cmark::Parser::new(&contents);
                let mut html = String::new();
                pulldown_cmark::html::push_html(&mut html, parser);
                *value = Some(html);
            }
            Err(e) => {
                tracing::warn!("Could not read branding file {:?}: {}", file_path, e);
            }
        }
    }
}

impl Config {
    /// Load configuration from a TOML file, or return the zero-config default.
    ///
    /// - If `path` is `Some` and the file exists, parse it.
    /// - If `path` is `None` or the file doesn't exist, return `Config::default()`.
    ///
    /// Markdown file paths in branding fields are resolved relative to the
    /// config file's directory.
    pub fn load(path: Option<&str>) -> Result<Self> {
        match path {
            Some(p) if Path::new(p).exists() => {
                let contents = std::fs::read_to_string(p)?;
                let mut config: Config = toml::from_str(&contents)?;

                // Resolve markdown file paths relative to the config file directory
                if let Some(ref mut branding) = config.branding {
                    let base_dir = Path::new(p)
                        .parent()
                        .unwrap_or_else(|| Path::new("."));
                    resolve_markdown_field(&mut branding.homepage_content, base_dir);
                    resolve_markdown_field(&mut branding.about_content, base_dir);
                    resolve_markdown_field(&mut branding.terms_content, base_dir);
                }

                Ok(config)
            }
            _ => Ok(Config::default()),
        }
    }
}
