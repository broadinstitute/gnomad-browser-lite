mod backend;
mod cli;
mod commands;
mod config;
mod models;
mod worker;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Json, Response},
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
use crate::backend::tiered::TieredBackend;
use crate::backend::VariantBackend;
use crate::cli::{Cli, Commands};
use crate::config::{BackendConfig, Config};
use crate::models::api;

/// Application state shared across handlers
#[derive(Clone)]
struct AppState {
    backend: Arc<dyn VariantBackend>,
    /// DuckDB backend kept for schema introspection (debugging only).
    /// Will be None when running with non-DuckDB backends.
    duckdb: Option<Arc<DuckDbBackend>>,
    cache: moka::future::Cache<String, Bytes>,
}

/// Recursively build a backend from the config.
fn build_backend(cfg: &BackendConfig) -> anyhow::Result<Box<dyn VariantBackend>> {
    match cfg {
        BackendConfig::DuckDb { data_dir } => {
            tracing::info!("Initializing DuckDB backend (data_dir: {})", data_dir);
            let backend = DuckDbBackend::new(&PathBuf::from(data_dir))?;
            Ok(Box::new(backend))
        }
        BackendConfig::Hail {
            variants_path,
            genes_path,
        } => {
            tracing::info!("Initializing Hail backend");
            tracing::info!("  Variants: {}", variants_path);
            tracing::info!("  Genes: {}", genes_path);
            let vp = variants_path.clone();
            let gp = genes_path.clone();
            // Open tables in a separate thread to avoid blocking tokio runtime
            // (genohype-core's GCS client uses its own blocking runtime internally)
            let backend = std::thread::spawn(move || {
                HailBackend::new(&vp, &gp)
            }).join().map_err(|_| anyhow::anyhow!("Hail backend init thread panicked"))??;
            Ok(Box::new(backend))
        }
        BackendConfig::ClickHouse { url, database } => {
            tracing::info!(
                "Initializing ClickHouse backend (url: {}, db: {})",
                url,
                database
            );
            let backend = ClickHouseBackend::new(url, database);
            Ok(Box::new(backend))
        }
        BackendConfig::Tiered { fast, fallback } => {
            tracing::info!("Initializing TieredBackend (fast + fallback)");
            let fast_backend = build_backend(fast)?;
            let fallback_backend = build_backend(fallback)?;
            Ok(Box::new(TieredBackend {
                fast: fast_backend,
                fallback: fallback_backend,
            }))
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
        _ => {}
    }

    // Resolve serve command (default if no subcommand given)
    let (config_path, port_override) = match &cli.command {
        Some(Commands::Serve { config, port }) => (config.as_deref(), *port),
        None => (None, None),
        _ => unreachable!("non-server commands handled above"),
    };

    let config = Config::load(config_path)?;
    tracing::info!("Backend config: {:?}", config.backend);

    // Initialize moka cache: 500MB capacity, 24h TTL
    let cache = moka::future::Cache::builder()
        .max_capacity(500 * 1024 * 1024)
        .time_to_live(std::time::Duration::from_secs(24 * 60 * 60))
        .build();

    // Build backend from config, with special handling for DuckDB schema endpoint
    let (backend, duckdb): (Arc<dyn VariantBackend>, Option<Arc<DuckDbBackend>>) =
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
                (Arc::clone(&arc) as Arc<dyn VariantBackend>, Some(arc))
            }
            other => {
                let b = build_backend(other)?;
                (Arc::from(b), None)
            }
        };

    let state = AppState {
        backend,
        duckdb,
        cache,
    };

    // Configure CORS for frontend
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build router
    let app = Router::new()
        .route("/api/health", get(health_check))
        .route("/api/gene/:gene_id", get(get_gene))
        .route("/api/gene/:gene_id/variants", get(get_gene_variants))
        .route("/api/gene/:gene_id/variants/stream", get(stream_gene_variants))
        .route("/api/region/:region_id", get(get_region_variants))
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
}

// ==================== Handlers ====================

async fn health_check() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "gnomad-browser-lite"
    }))
}

async fn get_gene(
    State(state): State<AppState>,
    Path(gene_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Check cache
    let cache_key = format!("gene:{}", gene_id);
    if let Some(cached) = state.cache.get(&cache_key).await {
        return Ok(Json(serde_json::from_slice(&cached).unwrap()));
    }

    let result = if gene_id.starts_with("ENSG") {
        state.backend.get_gene(&gene_id).await
    } else {
        state.backend.get_gene_by_symbol(&gene_id).await
    };

    match result {
        Ok(Some(gene)) => {
            let json_val = serde_json::to_value(&gene).unwrap();
            // Cache the result
            let bytes = Bytes::from(serde_json::to_vec(&json_val).unwrap());
            state.cache.insert(cache_key, bytes).await;
            Ok(Json(json_val))
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
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Check cache
    let cache_key = format!("gene_variants:{}:fb={}", gene_id, params.force_fallback);
    if let Some(cached) = state.cache.get(&cache_key).await {
        return Ok(Json(serde_json::from_slice(&cached).unwrap()));
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
            let bytes = Bytes::from(serde_json::to_vec(&json_val).unwrap());
            state.cache.insert(cache_key, bytes).await;
            Ok(Json(json_val))
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

async fn stream_gene_variants(
    State(state): State<AppState>,
    Path(gene_id): Path<String>,
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

    let variant_stream = match state
        .backend
        .stream_variants(&chrom, gene.start, gene.stop)
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
    let gene_line = serde_json::to_string(&metadata).unwrap() + "\n";

    let cache = state.cache.clone();
    let gene_for_cache = gene.clone();
    let cache_key_owned = cache_key;

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

        // Populate cache after stream completes so refreshes are instant
        let response = api::GeneVariantsResponse {
            gene: gene_for_cache,
            total: all_variants.len(),
            variants: all_variants,
        };
        if let Ok(json_val) = serde_json::to_value(&response) {
            if let Ok(bytes) = serde_json::to_vec(&json_val) {
                cache.insert(cache_key_owned, Bytes::from(bytes)).await;
            }
        }
    };

    Ok(Response::builder()
        .header("Content-Type", "application/x-ndjson")
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
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
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

    // Check cache
    let cache_key = format!("region:{}:{}-{}:fb={}", chrom, start, end, params.force_fallback);
    if let Some(cached) = state.cache.get(&cache_key).await {
        return Ok(Json(serde_json::from_slice(&cached).unwrap()));
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
            let bytes = Bytes::from(serde_json::to_vec(&json_val).unwrap());
            state.cache.insert(cache_key, bytes).await;
            Ok(Json(json_val))
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
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Check cache
    let cache_key = format!("variant:{}:fb={}", variant_id, params.force_fallback);
    if let Some(cached) = state.cache.get(&cache_key).await {
        return Ok(Json(serde_json::from_slice(&cached).unwrap()));
    }

    match state
        .backend
        .get_variant_detail(&variant_id, params.force_fallback)
        .await
    {
        Ok(Some(variant)) => {
            let json_val = serde_json::to_value(&variant).unwrap();
            let bytes = Bytes::from(serde_json::to_vec(&json_val).unwrap());
            state.cache.insert(cache_key, bytes).await;
            Ok(Json(json_val))
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
