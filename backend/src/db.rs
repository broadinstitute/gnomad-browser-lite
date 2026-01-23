use anyhow::{Context, Result};
use duckdb::{params, Connection};
use serde_json::Value;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Database wrapper for DuckDB operations
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// Create a new database instance with in-memory DuckDB
    pub fn new() -> Result<Self> {
        let conn = Connection::open_in_memory()
            .context("Failed to open in-memory DuckDB connection")?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Register Parquet files as views
    pub fn register_views(&self, data_dir: &Path) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        let variants_path = data_dir.join("variants.parquet");
        let genes_path = data_dir.join("genes.parquet");

        // Check if files exist
        if variants_path.exists() {
            let sql = format!(
                "CREATE OR REPLACE VIEW variants AS SELECT * FROM '{}'",
                variants_path.display()
            );
            conn.execute(&sql, [])
                .context("Failed to create variants view")?;
            tracing::info!("Registered variants view from {}", variants_path.display());
        } else {
            tracing::warn!("Variants parquet file not found at {}", variants_path.display());
        }

        if genes_path.exists() {
            let sql = format!(
                "CREATE OR REPLACE VIEW genes AS SELECT * FROM '{}'",
                genes_path.display()
            );
            conn.execute(&sql, [])
                .context("Failed to create genes view")?;
            tracing::info!("Registered genes view from {}", genes_path.display());
        } else {
            tracing::warn!("Genes parquet file not found at {}", genes_path.display());
        }

        Ok(())
    }

    /// Get gene by gene_id
    pub fn get_gene(&self, gene_id: &str) -> Result<Option<Value>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn
            .prepare("SELECT * FROM genes WHERE gene_id = ?")
            .context("Failed to prepare gene query")?;

        let result = stmt.query_row(params![gene_id], |row| {
            // DuckDB returns complex types as JSON when selected
            // We'll iterate over columns and build a JSON object
            let column_count = row.as_ref().column_count();
            let mut map = serde_json::Map::new();

            for i in 0..column_count {
                let column_name = row.as_ref().column_name(i).map_or("unknown", |s| s.as_str());
                // Try to get value as different types
                if let Ok(val) = row.get::<_, String>(i) {
                    map.insert(column_name.to_string(), Value::String(val));
                } else if let Ok(val) = row.get::<_, i64>(i) {
                    map.insert(column_name.to_string(), Value::Number(val.into()));
                } else if let Ok(val) = row.get::<_, f64>(i) {
                    if let Some(n) = serde_json::Number::from_f64(val) {
                        map.insert(column_name.to_string(), Value::Number(n));
                    }
                } else if let Ok(val) = row.get::<_, bool>(i) {
                    map.insert(column_name.to_string(), Value::Bool(val));
                } else {
                    map.insert(column_name.to_string(), Value::Null);
                }
            }

            Ok(Value::Object(map))
        });

        match result {
            Ok(val) => Ok(Some(val)),
            Err(duckdb::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("Query error: {}", e)),
        }
    }

    /// Get gene by symbol (case-insensitive)
    pub fn get_gene_by_symbol(&self, symbol: &str) -> Result<Option<Value>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn
            .prepare("SELECT * FROM genes WHERE UPPER(gencode_symbol) = UPPER(?)")
            .context("Failed to prepare gene symbol query")?;

        let result = stmt.query_row(params![symbol], |row| {
            let column_count = row.as_ref().column_count();
            let mut map = serde_json::Map::new();

            for i in 0..column_count {
                let column_name = row.as_ref().column_name(i).map_or("unknown", |s| s.as_str());
                if let Ok(val) = row.get::<_, String>(i) {
                    map.insert(column_name.to_string(), Value::String(val));
                } else if let Ok(val) = row.get::<_, i64>(i) {
                    map.insert(column_name.to_string(), Value::Number(val.into()));
                } else if let Ok(val) = row.get::<_, f64>(i) {
                    if let Some(n) = serde_json::Number::from_f64(val) {
                        map.insert(column_name.to_string(), Value::Number(n));
                    }
                } else if let Ok(val) = row.get::<_, bool>(i) {
                    map.insert(column_name.to_string(), Value::Bool(val));
                } else {
                    map.insert(column_name.to_string(), Value::Null);
                }
            }

            Ok(Value::Object(map))
        });

        match result {
            Ok(val) => Ok(Some(val)),
            Err(duckdb::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("Query error: {}", e)),
        }
    }

    /// Get variants in a genomic region
    pub fn get_variants(&self, chrom: &str, start: i64, end: i64) -> Result<Vec<Value>> {
        let conn = self.conn.lock().unwrap();

        // The gnomAD browser HT uses a locus struct with contig and position fields
        // Try different schema possibilities
        let sql = r#"
            SELECT * FROM variants
            WHERE locus.contig = ?
            AND locus.position >= ?
            AND locus.position <= ?
            ORDER BY locus.position
        "#;

        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => {
                // Fallback: try flat column names
                let fallback_sql = r#"
                    SELECT * FROM variants
                    WHERE contig = ?
                    AND position >= ?
                    AND position <= ?
                    ORDER BY position
                "#;
                conn.prepare(fallback_sql)
                    .context("Failed to prepare variants query")?
            }
        };

        let mut rows = stmt
            .query(params![chrom, start, end])
            .context("Failed to execute variants query")?;

        let mut results = Vec::new();

        while let Some(row) = rows.next().context("Failed to fetch row")? {
            let column_count = row.as_ref().column_count();
            let mut map = serde_json::Map::new();

            for i in 0..column_count {
                let column_name = row.as_ref().column_name(i).map_or("unknown", |s| s.as_str());
                if let Ok(val) = row.get::<_, String>(i) {
                    // Try to parse as JSON if it looks like it
                    if val.starts_with('{') || val.starts_with('[') {
                        if let Ok(json_val) = serde_json::from_str(&val) {
                            map.insert(column_name.to_string(), json_val);
                            continue;
                        }
                    }
                    map.insert(column_name.to_string(), Value::String(val));
                } else if let Ok(val) = row.get::<_, i64>(i) {
                    map.insert(column_name.to_string(), Value::Number(val.into()));
                } else if let Ok(val) = row.get::<_, f64>(i) {
                    if let Some(n) = serde_json::Number::from_f64(val) {
                        map.insert(column_name.to_string(), Value::Number(n));
                    }
                } else if let Ok(val) = row.get::<_, bool>(i) {
                    map.insert(column_name.to_string(), Value::Bool(val));
                } else {
                    map.insert(column_name.to_string(), Value::Null);
                }
            }

            results.push(Value::Object(map));
        }

        Ok(results)
    }

    /// Search genes by symbol prefix
    pub fn search_genes(&self, query: &str, limit: usize) -> Result<Vec<Value>> {
        let conn = self.conn.lock().unwrap();

        let sql = r#"
            SELECT gene_id, gencode_symbol as gene_symbol, chrom, start, stop
            FROM genes
            WHERE UPPER(gencode_symbol) LIKE UPPER(? || '%')
            LIMIT ?
        "#;

        let mut stmt = conn.prepare(sql).context("Failed to prepare search query")?;
        let mut rows = stmt
            .query(params![query, limit as i64])
            .context("Failed to execute search query")?;

        let mut results = Vec::new();

        while let Some(row) = rows.next().context("Failed to fetch row")? {
            let column_count = row.as_ref().column_count();
            let mut map = serde_json::Map::new();

            for i in 0..column_count {
                let column_name = row.as_ref().column_name(i).map_or("unknown", |s| s.as_str());
                if let Ok(val) = row.get::<_, String>(i) {
                    map.insert(column_name.to_string(), Value::String(val));
                } else if let Ok(val) = row.get::<_, i64>(i) {
                    map.insert(column_name.to_string(), Value::Number(val.into()));
                }
            }

            results.push(Value::Object(map));
        }

        Ok(results)
    }

    /// Get schema information for debugging
    pub fn get_schema(&self, table: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();

        let sql = format!("DESCRIBE {}", table);
        let mut stmt = conn.prepare(&sql).context("Failed to prepare describe query")?;
        let mut rows = stmt.query([]).context("Failed to execute describe")?;

        let mut schema = Vec::new();
        while let Some(row) = rows.next().context("Failed to fetch schema row")? {
            let name: String = row.get(0)?;
            let dtype: String = row.get(1)?;
            schema.push((name, dtype));
        }

        Ok(schema)
    }
}

impl Clone for Database {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
        }
    }
}
