mod db;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::get,
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::db::Database;

/// Application state shared across handlers
#[derive(Clone)]
struct AppState {
    db: Database,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Initialize database
    let db = Database::new()?;

    // Register Parquet views - use DATA_DIR env var or default to ../data
    let data_dir = std::env::var("DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../data"));
    tracing::info!("Using data directory: {:?}", data_dir);
    db.register_views(&data_dir)?;

    // Print schema info for debugging
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

    let state = AppState { db };

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
        .route("/api/region/:region_id", get(get_region_variants))
        .route("/api/search", get(search_genes))
        .route("/api/variant/:variant_id", get(get_variant_detail))
        .route("/api/schema/:table", get(get_table_schema))
        .layer(cors)
        .with_state(state);

    // Start server - use PORT env var or default to 3000
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("Starting server on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Health check endpoint
async fn health_check() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "gnomad-browser-lite"
    }))
}

/// Get gene by ID or symbol
/// GET /api/gene/:gene_id
async fn get_gene(
    State(state): State<AppState>,
    Path(gene_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Try by gene_id first, then by symbol
    let result = if gene_id.starts_with("ENSG") {
        state.db.get_gene(&gene_id)
    } else {
        state.db.get_gene_by_symbol(&gene_id)
    };

    match result {
        Ok(Some(gene)) => Ok(Json(gene)),
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

/// Get variants for a gene
/// GET /api/gene/:gene_id/variants
async fn get_gene_variants(
    State(state): State<AppState>,
    Path(gene_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // First get the gene to find its coordinates
    let gene_result = if gene_id.starts_with("ENSG") {
        state.db.get_gene(&gene_id)
    } else {
        state.db.get_gene_by_symbol(&gene_id)
    };

    let gene = match gene_result {
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
    };

    // Extract coordinates from gene
    let chrom_raw = gene
        .get("chrom")
        .or_else(|| gene.get("reference_genome"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // Normalize chromosome to match variants format (chr1, chr2, etc.)
    let chrom = if chrom_raw.starts_with("chr") {
        chrom_raw.to_string()
    } else {
        format!("chr{}", chrom_raw)
    };
    let start = gene
        .get("start")
        .or_else(|| gene.get("gene_start"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let stop = gene
        .get("stop")
        .or_else(|| gene.get("gene_stop"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    match state.db.get_variants(&chrom, start, stop) {
        Ok(variants) => Ok(Json(json!({
            "gene": gene,
            "variants": variants,
            "total": variants.len()
        }))),
        Err(e) => {
            tracing::error!("Error fetching variants for {}: {}", gene_id, e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ))
        }
    }
}

/// Parse region string like "chr1-55039000-55065000" or "1:55039000-55065000"
fn parse_region(region_id: &str) -> Option<(String, i64, i64)> {
    // Handle formats: "chr1-start-end" or "chr1:start-end"
    let parts: Vec<&str> = region_id
        .split(|c| c == '-' || c == ':')
        .collect();

    if parts.len() == 3 {
        let chrom = parts[0].to_string();
        let start = parts[1].parse().ok()?;
        let end = parts[2].parse().ok()?;
        Some((chrom, start, end))
    } else if parts.len() == 2 {
        // Format: "chr1:55039000-55065000" split as ["chr1", "55039000", "55065000"]
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

/// Get variants in a genomic region
/// GET /api/region/:region_id
/// Region format: chr1-55039000-55065000 or chr1:55039000-55065000
async fn get_region_variants(
    State(state): State<AppState>,
    Path(region_id): Path<String>,
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

    match state.db.get_variants(&chrom, start, end) {
        Ok(variants) => Ok(Json(json!({
            "region": {
                "chrom": chrom,
                "start": start,
                "end": end
            },
            "variants": variants,
            "total": variants.len()
        }))),
        Err(e) => {
            tracing::error!("Error fetching region {}: {}", region_id, e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ))
        }
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    10
}

/// Search genes by symbol
/// GET /api/search?q=PCSK&limit=10
async fn search_genes(
    State(state): State<AppState>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    match state.db.search_genes(&params.q, params.limit) {
        Ok(results) => Ok(Json(json!({
            "query": params.q,
            "results": results,
            "total": results.len()
        }))),
        Err(e) => {
            tracing::error!("Error searching genes: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ))
        }
    }
}

/// Get variant detail by ID
/// GET /api/variant/:variant_id
async fn get_variant_detail(
    State(state): State<AppState>,
    Path(variant_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    match state.db.get_variant(&variant_id) {
        Ok(Some(variant)) => Ok(Json(variant)),
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

/// Get table schema for debugging
/// GET /api/schema/:table
async fn get_table_schema(
    State(state): State<AppState>,
    Path(table): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Only allow known tables
    if table != "genes" && table != "variants" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Unknown table", "table": table })),
        ));
    }

    match state.db.get_schema(&table) {
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
