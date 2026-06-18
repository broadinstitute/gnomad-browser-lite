mod backend;
mod cli;
mod commands;
mod config;
mod mcp;
mod models;
mod oracle;
mod worker;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header::HeaderName, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use bytes::Bytes;
use clap::Parser;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::backend::clickhouse::ClickHouseBackend;
use crate::backend::duckdb::DuckDbBackend;
use crate::backend::hail::HailBackend;
use crate::backend::postgres::PostgresBackend;
use crate::backend::tiered::TieredBackend;
use crate::backend::VariantBackend;
use crate::cli::{Cli, Commands, McpCommands};
use crate::config::{BackendConfig, BrandingConfig, Config};
use crate::mcp::provider::GnomadMcpProvider;
use crate::mcp::server::GnomadMcpServer;
use crate::models::api;
use rmcp::ServiceExt;

/// Application state shared across handlers
#[derive(Clone)]
struct AppState {
    backend: Arc<dyn VariantBackend>,
    /// DuckDB backend kept for schema introspection (debugging only).
    /// Will be None when running with non-DuckDB backends.
    duckdb: Option<Arc<DuckDbBackend>>,
    cache: moka::future::Cache<String, Bytes>,
    /// Data source metadata for UI display (e.g., Hail table path, partition count)
    source_info: Option<Value>,
    branding: BrandingConfig,
}

/// Recursively build a backend from the config.
fn build_backend(cfg: &BackendConfig) -> anyhow::Result<(Box<dyn VariantBackend>, Option<Value>)> {
    match cfg {
        BackendConfig::DuckDb { data_dir } => {
            tracing::info!("Initializing DuckDB backend (data_dir: {})", data_dir);
            let backend = DuckDbBackend::new(&PathBuf::from(data_dir))?;
            Ok((Box::new(backend), None))
        }
        BackendConfig::Hail {
            variants_path,
            genes_path,
            constraint_path,
            vep_gff3,
            vep_fasta,
        } => {
            tracing::info!("Initializing Hail backend");
            tracing::info!("  Variants: {}", variants_path);
            tracing::info!("  Genes: {}", genes_path);
            if let Some(cp) = constraint_path {
                tracing::info!("  Constraint: {}", cp);
            }
            if let Some(gff3) = vep_gff3 {
                tracing::info!("  VEP GFF3: {}", gff3);
            }
            let vp = variants_path.clone();
            let gp = genes_path.clone();
            let cp = constraint_path.clone();
            let vep_cfg = vep_gff3.as_ref().map(|gff3| {
                crate::backend::hail::VepConfig {
                    gff3: gff3.clone(),
                    fasta: vep_fasta.clone(),
                }
            });
            // Open tables in a separate thread to avoid blocking tokio runtime
            // (genohype-core's GCS client uses its own blocking runtime internally)
            let backend = std::thread::spawn(move || {
                HailBackend::new(&vp, &gp, cp.as_deref(), vep_cfg)
            }).join().map_err(|_| anyhow::anyhow!("Hail backend init thread panicked"))??;
            let source_info = backend.source_info();
            Ok((Box::new(backend), Some(source_info)))
        }
        BackendConfig::ClickHouse { url, database } => {
            tracing::info!(
                "Initializing ClickHouse backend (url: {}, db: {})",
                url,
                database
            );
            let backend = ClickHouseBackend::new(url, database);
            Ok((Box::new(backend), None))
        }
        BackendConfig::Postgres { database_url } => {
            tracing::info!("Initializing Postgres backend");
            let backend = PostgresBackend::new(database_url)?;
            Ok((Box::new(backend), None))
        }
        BackendConfig::Tiered { fast, fallback } => {
            tracing::info!("Initializing TieredBackend (fast + fallback)");
            let (fast_backend, source_info) = build_backend(fast)?;
            let (fallback_backend, _) = build_backend(fallback)?;
            Ok((Box::new(TieredBackend {
                fast: fast_backend,
                fallback: fallback_backend,
            }), source_info))
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Increase file descriptor limit for Hail table partition reads
    if let Err(e) = rlimit::setrlimit(rlimit::Resource::NOFILE, 10240, 10240) {
        eprintln!("Warning: failed to set file descriptor limit: {}", e);
    }

    // Initialize tracing
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cli = Cli::parse();

    // Intercept non-server commands before starting the web server
    match &cli.command {
        Some(Commands::Validate {
            source,
            schema,
            sample_size,
            verbose,
            fail_fast,
            generate_schema,
        }) => {
            return commands::validate::run(
                source,
                schema.as_deref(),
                *sample_size,
                *verbose,
                *fail_fast,
                generate_schema.as_deref(),
            )
            .await;
        }
        Some(Commands::Load {
            source,
            target,
            table_type,
            filter,
            clickhouse_url,
            clickhouse_db,
            output_dir,
            init_strategy,
            genohype_bin,
            keep_staging,
            limit,
        }) => {
            return commands::load::run(
                source,
                *target,
                *table_type,
                filter.as_deref(),
                clickhouse_url,
                clickhouse_db,
                output_dir,
                *init_strategy,
                genohype_bin,
                *keep_staging,
                *limit,
            )
            .await;
        }
        Some(Commands::Pool(pool_cmd)) => {
            return commands::pool::run(pool_cmd).await;
        }
        Some(Commands::Worker {
            coordinator_url,
            worker_id,
            poll_interval_ms,
            genohype_bin,
        }) => {
            return worker::run_worker(
                coordinator_url,
                worker_id.as_deref(),
                *poll_interval_ms,
                genohype_bin,
            )
            .await;
        }
        Some(Commands::Clickhouse(ch_cmd)) => {
            return commands::infra::run(ch_cmd).map_err(Into::into);
        }
        Some(Commands::Mcp(mcp_cmd)) => {
            return run_mcp(&cli, mcp_cmd).await;
        }
        _ => {}
    }

    // Resolve serve command (default if no subcommand given)
    let port_override = match &cli.command {
        Some(Commands::Serve { port }) => *port,
        None => None,
        _ => unreachable!("non-server commands handled above"),
    };

    let config = Config::load(cli.config.as_deref())?;
    tracing::info!("Backend config: {:?}", config.backend);

    // Initialize moka cache: 500MB capacity, 24h TTL
    let cache = moka::future::Cache::builder()
        .max_capacity(500 * 1024 * 1024)
        .time_to_live(std::time::Duration::from_secs(24 * 60 * 60))
        .build();

    // Build backend from config, with special handling for DuckDB schema endpoint
    let (backend, duckdb, source_info): (Arc<dyn VariantBackend>, Option<Arc<DuckDbBackend>>, Option<Value>) =
        match &config.backend {
            BackendConfig::DuckDb { data_dir } => {
                let db = DuckDbBackend::new(&PathBuf::from(data_dir))?;

                if let Ok(schema) = db.get_schema("genes") {
                    tracing::info!("Genes schema:");
                    for (name, dtype) in schema {
                        tracing::debug!("  {} : {}", name, dtype);
                    }
                }
                if let Ok(schema) = db.get_schema("variants") {
                    tracing::info!("Variants schema:");
                    for (name, dtype) in schema {
                        tracing::debug!("  {} : {}", name, dtype);
                    }
                }

                let arc = Arc::new(db);
                (Arc::clone(&arc) as Arc<dyn VariantBackend>, Some(arc), None)
            }
            other => {
                let (b, si) = build_backend(other)?;
                (Arc::from(b), None, si)
            }
        };

    let branding = config.branding.unwrap_or_default();

    let state = AppState {
        backend,
        duckdb,
        cache,
        source_info,
        branding,
    };

    // Configure CORS for frontend
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([X_CACHE.clone()]);

    // Build router
    let app = Router::new()
        .route("/api/config", get(get_config))
        .route("/api/health", get(health_check))
        .route("/api/gene/:gene_id", get(get_gene))
        .route("/api/gene/:gene_id/variants", get(get_gene_variants))
        .route("/api/gene/:gene_id/variants/stream", get(stream_gene_variants))
        .route("/api/region/:region_id", get(get_region_variants))
        .route("/api/variants/stream", get(stream_region_variants))
        .route("/api/search", get(search_genes))
        .route("/api/variant/:variant_id", get(get_variant_detail))
        .route("/api/schema/:table", get(get_table_schema))
        .layer(cors)
        .with_state(state);

    // Resolve port: CLI flag > PORT env var > default 3000
    let port = port_override
        .map(|p| p.to_string())
        .or_else(|| std::env::var("PORT").ok())
        .unwrap_or_else(|| "3000".to_string());
    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("Starting server on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ==================== MCP server ====================

async fn run_mcp(cli: &Cli, mcp_cmd: &McpCommands) -> anyhow::Result<()> {
    // MCP stdio: suppress all tracing output (it would corrupt the JSON-RPC stream)
    // Tracing is already initialized above, but we redirect to stderr for MCP mode
    let config = Config::load(cli.config.as_deref())?;
    let (backend, _source_info) = build_backend(&config.backend)?;
    let backend: Arc<dyn VariantBackend> = Arc::from(backend);

    let provider = Arc::new(GnomadMcpProvider::new(backend));
    let server = GnomadMcpServer::new(provider);

    match mcp_cmd {
        McpCommands::Stdio => {
            let transport = rmcp::transport::io::stdio();
            let service = server.serve(transport).await?;
            service.waiting().await?;
        }
    }

    Ok(())
}

// ==================== Query parameters ====================

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    10
}

#[derive(Deserialize)]
struct VariantQuery {
    #[serde(default)]
    force_fallback: bool,
    /// When true, bypass the API `moka` cache entirely (read *and* write) so the
    /// benchmark measures the datastore, not the cache. Injected by the runner
    /// as `?no_cache=true` — the axis-1 default. See DESIGN.md "Confounder
    /// controls".
    #[serde(default)]
    no_cache: bool,
}

// ==================== Handlers ====================

async fn health_check() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "gnomad-browser-lite"
    }))
}

async fn get_config(State(state): State<AppState>) -> Json<BrandingConfig> {
    Json(state.branding)
}

/// Header name for cache status
static X_CACHE: HeaderName = HeaderName::from_static("x-cache");

async fn get_gene(
    State(state): State<AppState>,
    Path(gene_id): Path<String>,
    Query(params): Query<VariantQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    // Check cache (unless bypassed for benchmarking)
    let cache_key = format!("gene:{}", gene_id);
    if !params.no_cache
        && let Some(cached) = state.cache.get(&cache_key).await
    {
        return Ok((
            [(X_CACHE.clone(), "moka-hit")],
            Json(serde_json::from_slice::<Value>(&cached).unwrap()),
        ));
    }

    let result = if gene_id.starts_with("ENSG") {
        state.backend.get_gene(&gene_id).await
    } else {
        state.backend.get_gene_by_symbol(&gene_id).await
    };

    match result {
        Ok(Some(gene)) => {
            let json_val = serde_json::to_value(&gene).unwrap();
            // Cache the result (unless bypassed)
            if !params.no_cache {
                let bytes = Bytes::from(serde_json::to_vec(&json_val).unwrap());
                state.cache.insert(cache_key, bytes).await;
            }
            Ok((
                [(X_CACHE.clone(), if params.no_cache { "bypass" } else { "miss" })],
                Json(json_val),
            ))
        }
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Gene not found", "gene_id": gene_id })),
        )),
        Err(e) => {
            tracing::error!("Error fetching gene {}: {}", gene_id, e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ))
        }
    }
}

async fn get_gene_variants(
    State(state): State<AppState>,
    Path(gene_id): Path<String>,
    Query(params): Query<VariantQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    // Check cache (unless bypassed for benchmarking)
    let cache_key = format!("gene_variants:{}:fb={}", gene_id, params.force_fallback);
    if !params.no_cache
        && let Some(cached) = state.cache.get(&cache_key).await
    {
        return Ok((
            [(X_CACHE.clone(), "moka-hit")],
            Json(serde_json::from_slice::<Value>(&cached).unwrap()),
        ));
    }

    // Look up gene first
    let gene = {
        let result = if gene_id.starts_with("ENSG") {
            state.backend.get_gene(&gene_id).await
        } else {
            state.backend.get_gene_by_symbol(&gene_id).await
        };

        match result {
            Ok(Some(g)) => g,
            Ok(None) => {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Gene not found", "gene_id": gene_id })),
                ))
            }
            Err(e) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": e.to_string() })),
                ))
            }
        }
    };

    // Normalize chromosome
    let chrom = if gene.chrom.starts_with("chr") {
        gene.chrom.clone()
    } else {
        format!("chr{}", gene.chrom)
    };

    match state
        .backend
        .get_variants(&chrom, gene.start, gene.stop, params.force_fallback)
        .await
    {
        Ok(variants) => {
            let response = api::GeneVariantsResponse {
                gene,
                total: variants.len(),
                variants,
            };
            let json_val = serde_json::to_value(&response).unwrap();
            if !params.no_cache {
                let bytes = Bytes::from(serde_json::to_vec(&json_val).unwrap());
                state.cache.insert(cache_key, bytes).await;
            }
            Ok((
                [(X_CACHE.clone(), if params.no_cache { "bypass" } else { "miss" })],
                Json(json_val),
            ))
        }
        Err(e) => {
            tracing::error!("Error fetching variants for {}: {}", gene_id, e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ))
        }
    }
}

#[derive(Debug, Deserialize)]
struct StreamQuery {
    /// "full" to fetch entire gene region, default fetches exon regions only
    mode: Option<String>,
    /// Comma-separated exon feature types to include (e.g., "CDS,UTR,exon"). Default: CDS only.
    include: Option<String>,
}

async fn stream_gene_variants(
    State(state): State<AppState>,
    Path(gene_id): Path<String>,
    Query(params): Query<StreamQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    // Look up gene (same logic as get_gene_variants)
    let gene = {
        let result = if gene_id.starts_with("ENSG") {
            state.backend.get_gene(&gene_id).await
        } else {
            state.backend.get_gene_by_symbol(&gene_id).await
        };

        match result {
            Ok(Some(g)) => g,
            Ok(None) => {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Gene not found", "gene_id": gene_id })),
                ))
            }
            Err(e) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": e.to_string() })),
                ))
            }
        }
    };

    // Normalize chromosome
    let chrom = if gene.chrom.starts_with("chr") {
        gene.chrom.clone()
    } else {
        format!("chr{}", gene.chrom)
    };

    // Build exon intervals (±50bp shoulder, merged) unless mode=full
    let is_full = params.mode.as_deref() == Some("full");
    let include_types: Vec<&str> = params.include.as_deref()
        .map(|s| s.split(',').collect())
        .unwrap_or_else(|| vec!["CDS"]);
    let exon_regions: Option<Vec<(i64, i64)>> = if !is_full {
        gene.exons.as_ref().and_then(|exons| {
            if exons.is_empty() { return None; }
            let shoulder: i64 = 50;
            let mut intervals: Vec<(i64, i64)> = exons.iter()
                .filter(|e| include_types.iter().any(|t| e.feature_type.as_str() == *t))
                .map(|e| ((e.start as i64 - shoulder).max(0), e.stop as i64 + shoulder))
                .collect();
            if intervals.is_empty() { return None; }
            intervals.sort_by_key(|&(s, _)| s);
            // Merge overlapping intervals
            let mut merged: Vec<(i64, i64)> = vec![intervals[0]];
            for &(s, e) in &intervals[1..] {
                let last = merged.last_mut().unwrap();
                if s <= last.1 {
                    last.1 = last.1.max(e);
                } else {
                    merged.push((s, e));
                }
            }
            Some(merged)
        })
    } else {
        None
    };

    let variant_stream = match state
        .backend
        .stream_variants(&chrom, gene.start, gene.stop, exon_regions.as_deref())
        .await
    {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("Error starting variant stream for {}: {}", gene_id, e);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ));
        }
    };

    // Check if we have a cached total from a previous request
    let cache_key = format!("gene_variants:{}:fb=false", gene_id);
    let cached_total: Option<usize> = state.cache.get(&cache_key).await.and_then(|bytes| {
        serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("total").and_then(|t| t.as_u64()))
            .map(|t| t as usize)
    });

    // Build NDJSON stream: first line is gene metadata (+ total if known), then one variant per line
    let mut metadata = json!({ "gene": gene.clone() });
    if let Some(total) = cached_total {
        metadata["total"] = json!(total);
    }
    if let Some(ref si) = state.source_info {
        metadata["source"] = si.clone();
    }
    metadata["mode"] = json!(if is_full { "full" } else { "exons" });
    if let Some(ref regions) = exon_regions {
        metadata["region_count"] = json!(regions.len());
    }
    let gene_line = serde_json::to_string(&metadata).unwrap() + "\n";

    let cache = state.cache.clone();
    let gene_for_cache = gene.clone();
    let cache_key_owned = cache_key;
    let backend = Arc::clone(&state.backend);
    let prefetch_cache = state.cache.clone();
    let prefetch_chrom = chrom.clone();
    let prefetch_gene_start = gene.start;
    let prefetch_gene_stop = gene.stop;
    let prefetch_regions = exon_regions.clone();

    /// Maximum variant count for which background prefetch is triggered.
    const MAX_PREFETCH_VARIANTS: usize = 10_000;

    let ndjson_stream = async_stream::stream! {
        yield Ok::<Bytes, std::io::Error>(Bytes::from(gene_line));

        let mut all_variants: Vec<api::Variant> = Vec::new();
        let mut variant_stream = std::pin::pin!(variant_stream);
        while let Some(result) = variant_stream.next().await {
            match result {
                Ok(variant) => {
                    let mut line = serde_json::to_string(&json!({ "variant": variant })).unwrap();
                    line.push('\n');
                    all_variants.push(variant);
                    yield Ok(Bytes::from(line));
                }
                Err(e) => {
                    tracing::error!("Error streaming variant: {}", e);
                    break;
                }
            }
        }

        let variant_count = all_variants.len();
        let prefetch_eligible = variant_count <= MAX_PREFETCH_VARIANTS && variant_count > 0;

        // Emit a summary line with prefetch metadata
        let summary = serde_json::json!({
            "summary": {
                "total": variant_count,
                "prefetch_eligible": prefetch_eligible,
            }
        });
        let mut summary_line = serde_json::to_string(&summary).unwrap();
        summary_line.push('\n');
        yield Ok(Bytes::from(summary_line));

        // Populate cache after stream completes so refreshes are instant
        let response = api::GeneVariantsResponse {
            gene: gene_for_cache,
            total: variant_count,
            variants: all_variants,
        };
        if let Ok(json_val) = serde_json::to_value(&response) {
            if let Ok(bytes) = serde_json::to_vec(&json_val) {
                cache.insert(cache_key_owned, Bytes::from(bytes)).await;
            }
        }

        // Background prefetch: re-scan without projection to populate variant detail cache
        if variant_count <= MAX_PREFETCH_VARIANTS && variant_count > 0 {
            tokio::spawn(async move {
                tracing::info!(
                    "Background prefetch: decoding full details for {} variants",
                    variant_count
                );
                match backend
                    .stream_variant_details(
                        &prefetch_chrom,
                        prefetch_gene_start,
                        prefetch_gene_stop,
                        prefetch_regions.as_deref(),
                    )
                    .await
                {
                    Ok(detail_stream) => {
                        let mut detail_stream = std::pin::pin!(detail_stream);
                        let mut cached = 0usize;
                        while let Some(result) = detail_stream.next().await {
                            match result {
                                Ok(detail) => {
                                    if let Some(ref vid) = detail.variant_id {
                                        let key = format!("variant:{}:fb=false", vid);
                                        if let Ok(bytes) = serde_json::to_vec(&detail) {
                                            prefetch_cache.insert(key, Bytes::from(bytes)).await;
                                            cached += 1;
                                        }
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("Background prefetch error: {}", e);
                                    break;
                                }
                            }
                        }
                        tracing::info!("Background prefetch complete: cached {} variant details", cached);
                    }
                    Err(e) => {
                        tracing::warn!("Background prefetch failed to start: {}", e);
                    }
                }
            });
        }
    };

    Ok(Response::builder()
        .header("Content-Type", "application/x-ndjson")
        .header("x-cache", "miss")
        .body(Body::from_stream(ndjson_stream))
        .unwrap())
}

#[derive(Debug, Deserialize)]
struct RegionStreamQuery {
    /// Chromosome, e.g. "chr1"
    chrom: String,
    /// Comma-separated intervals as "start-stop,start-stop"
    intervals: String,
}

async fn stream_region_variants(
    State(state): State<AppState>,
    Query(params): Query<RegionStreamQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    // Parse intervals
    let intervals: Vec<(i64, i64)> = params
        .intervals
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| {
            let parts: Vec<&str> = s.split('-').collect();
            if parts.len() != 2 {
                return Err(());
            }
            let start: i64 = parts[0].parse().map_err(|_| ())?;
            let stop: i64 = parts[1].parse().map_err(|_| ())?;
            Ok((start, stop))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "Invalid intervals format",
                    "expected": "start-stop,start-stop",
                    "received": params.intervals
                })),
            )
        })?;

    if intervals.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "No intervals provided" })),
        ));
    }

    // Normalize chromosome
    let chrom = if params.chrom.starts_with("chr") {
        params.chrom.clone()
    } else {
        format!("chr{}", params.chrom)
    };

    // Compute bounding region from intervals
    let bounding_start = intervals.iter().map(|(s, _)| *s).min().unwrap();
    let bounding_end = intervals.iter().map(|(_, e)| *e).max().unwrap();

    let variant_stream = match state
        .backend
        .stream_variants(&chrom, bounding_start, bounding_end, Some(&intervals))
        .await
    {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("Error starting region variant stream: {}", e);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ));
        }
    };

    // Build NDJSON stream: first line is metadata, then one variant per line
    let metadata = json!({
        "chrom": chrom,
        "intervals": intervals.len(),
        "bounding_start": bounding_start,
        "bounding_end": bounding_end,
    });
    let metadata_line = serde_json::to_string(&metadata).unwrap() + "\n";

    let prefetch_cache = state.cache.clone();
    let backend = Arc::clone(&state.backend);
    let prefetch_chrom = chrom.clone();
    let prefetch_start = bounding_start;
    let prefetch_end = bounding_end;
    let prefetch_intervals = intervals.clone();
    const MAX_PREFETCH_VARIANTS: usize = 10_000;

    let ndjson_stream = async_stream::stream! {
        yield Ok::<Bytes, std::io::Error>(Bytes::from(metadata_line));

        let mut all_variants: Vec<crate::models::api::Variant> = Vec::new();
        let mut variant_stream = std::pin::pin!(variant_stream);
        while let Some(result) = variant_stream.next().await {
            match result {
                Ok(variant) => {
                    let mut line = serde_json::to_string(&json!({ "variant": variant })).unwrap();
                    line.push('\n');
                    all_variants.push(variant);
                    yield Ok(Bytes::from(line));
                }
                Err(e) => {
                    tracing::error!("Error streaming region variant: {}", e);
                    break;
                }
            }
        }

        let variant_count = all_variants.len();
        let prefetch_eligible = variant_count <= MAX_PREFETCH_VARIANTS && variant_count > 0;

        // Emit a summary line with prefetch metadata
        let summary = serde_json::json!({
            "summary": {
                "total": variant_count,
                "prefetch_eligible": prefetch_eligible,
            }
        });
        let mut summary_line = serde_json::to_string(&summary).unwrap();
        summary_line.push('\n');
        yield Ok(Bytes::from(summary_line));

        // Background prefetch: re-scan without projection to populate variant detail cache
        if prefetch_eligible {
            tokio::spawn(async move {
                tracing::info!(
                    "Region background prefetch: decoding full details for {} variants",
                    variant_count
                );
                match backend
                    .stream_variant_details(
                        &prefetch_chrom,
                        prefetch_start,
                        prefetch_end,
                        Some(&prefetch_intervals),
                    )
                    .await
                {
                    Ok(detail_stream) => {
                        let mut detail_stream = std::pin::pin!(detail_stream);
                        let mut cached = 0usize;
                        while let Some(result) = detail_stream.next().await {
                            match result {
                                Ok(detail) => {
                                    if let Some(ref vid) = detail.variant_id {
                                        let key = format!("variant:{}:fb=false", vid);
                                        if let Ok(bytes) = serde_json::to_vec(&detail) {
                                            prefetch_cache.insert(key, Bytes::from(bytes)).await;
                                            cached += 1;
                                        }
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("Region background prefetch error: {}", e);
                                    break;
                                }
                            }
                        }
                        tracing::info!("Region background prefetch complete: cached {} variant details", cached);
                    }
                    Err(e) => {
                        tracing::warn!("Region background prefetch failed to start: {}", e);
                    }
                }
            });
        }
    };

    Ok(Response::builder()
        .header("Content-Type", "application/x-ndjson")
        .header("x-cache", "miss")
        .body(Body::from_stream(ndjson_stream))
        .unwrap())
}

fn parse_region(region_id: &str) -> Option<(String, i64, i64)> {
    let parts: Vec<&str> = region_id.split(|c| c == '-' || c == ':').collect();

    if parts.len() == 3 {
        let chrom = parts[0].to_string();
        let start = parts[1].parse().ok()?;
        let end = parts[2].parse().ok()?;
        Some((chrom, start, end))
    } else if parts.len() == 2 {
        let inner: Vec<&str> = parts[1].split('-').collect();
        if inner.len() == 2 {
            let chrom = parts[0].to_string();
            let start = inner[0].parse().ok()?;
            let end = inner[1].parse().ok()?;
            Some((chrom, start, end))
        } else {
            None
        }
    } else {
        None
    }
}

async fn get_region_variants(
    State(state): State<AppState>,
    Path(region_id): Path<String>,
    Query(params): Query<VariantQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let (chrom, start, end) = match parse_region(&region_id) {
        Some(r) => r,
        None => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "Invalid region format",
                    "expected": "chr1-55039000-55065000 or chr1:55039000-55065000",
                    "received": region_id
                })),
            ))
        }
    };

    // Check cache (unless bypassed for benchmarking)
    let cache_key = format!("region:{}:{}-{}:fb={}", chrom, start, end, params.force_fallback);
    if !params.no_cache
        && let Some(cached) = state.cache.get(&cache_key).await
    {
        return Ok((
            [(X_CACHE.clone(), "moka-hit")],
            Json(serde_json::from_slice::<Value>(&cached).unwrap()),
        ));
    }

    match state
        .backend
        .get_variants(&chrom, start, end, params.force_fallback)
        .await
    {
        Ok(variants) => {
            let response = api::RegionVariantsResponse {
                region: api::RegionInfo {
                    chrom,
                    start,
                    end,
                },
                total: variants.len(),
                variants,
            };
            let json_val = serde_json::to_value(&response).unwrap();
            if !params.no_cache {
                let bytes = Bytes::from(serde_json::to_vec(&json_val).unwrap());
                state.cache.insert(cache_key, bytes).await;
            }
            Ok((
                [(X_CACHE.clone(), if params.no_cache { "bypass" } else { "miss" })],
                Json(json_val),
            ))
        }
        Err(e) => {
            tracing::error!("Error fetching region {}: {}", region_id, e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ))
        }
    }
}

async fn search_genes(
    State(state): State<AppState>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    match state.backend.search_genes(&params.q, params.limit).await {
        Ok(results) => {
            let response = api::SearchResponse {
                query: params.q,
                total: results.len(),
                results,
            };
            Ok(Json(serde_json::to_value(&response).unwrap()))
        }
        Err(e) => {
            tracing::error!("Error searching genes: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ))
        }
    }
}

async fn get_variant_detail(
    State(state): State<AppState>,
    Path(variant_id): Path<String>,
    Query(params): Query<VariantQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    // Check cache (unless bypassed for benchmarking)
    let cache_key = format!("variant:{}:fb={}", variant_id, params.force_fallback);
    if !params.no_cache
        && let Some(cached) = state.cache.get(&cache_key).await
    {
        return Ok((
            [(X_CACHE.clone(), "moka-hit")],
            Json(serde_json::from_slice::<Value>(&cached).unwrap()),
        ));
    }

    match state
        .backend
        .get_variant_detail(&variant_id, params.force_fallback)
        .await
    {
        Ok(Some(variant)) => {
            let json_val = serde_json::to_value(&variant).unwrap();
            if !params.no_cache {
                let bytes = Bytes::from(serde_json::to_vec(&json_val).unwrap());
                state.cache.insert(cache_key, bytes).await;
            }
            Ok((
                [(X_CACHE.clone(), if params.no_cache { "bypass" } else { "miss" })],
                Json(json_val),
            ))
        }
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Variant not found", "variant_id": variant_id })),
        )),
        Err(e) => {
            tracing::error!("Error fetching variant {}: {}", variant_id, e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ))
        }
    }
}

async fn get_table_schema(
    State(state): State<AppState>,
    Path(table): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if table != "genes" && table != "variants" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Unknown table", "table": table })),
        ));
    }

    let Some(duckdb_backend) = &state.duckdb else {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "Schema introspection only available with DuckDB backend" })),
        ));
    };

    let schema_result = duckdb_backend.get_schema(&table);

    match schema_result {
        Ok(schema) => {
            let fields: Vec<Value> = schema
                .into_iter()
                .map(|(name, dtype)| json!({ "name": name, "type": dtype }))
                .collect();
            Ok(Json(json!({
                "table": table,
                "fields": fields
            })))
        }
        Err(e) => {
            tracing::error!("Error getting schema for {}: {}", table, e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ))
        }
    }
}
