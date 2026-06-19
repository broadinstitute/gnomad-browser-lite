use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use async_trait::async_trait;
use tracing::{debug, info, warn};

use super::{QueryStats, VariantBackend};
use crate::config::CacheMode;
use crate::models::api::{Gene, SearchResult, Variant, VariantDetails};

/// Materialized-cache backend — "the database is a cache of responses".
///
/// The browser hot set is *enumerable* (~20k protein-coding genes) and gnomAD
/// releases are infrequent, so the full gene-view variant payload for every gene
/// is precomputed offline (Phase 4: a pool job iterates the genes table, runs
/// the Hail query for each gene boundary, and writes
/// `gs://.../cache/variants/{gene_id}.json`). This backend serves those
/// gene-views as an O(1) lookup with no query engine.
///
/// ## Routing
///
/// The [`VariantBackend`] trait has no "gene-view" method — a gene page is just a
/// `get_variants(chrom, gene.start, gene.stop)` call (see `get_gene_variants` in
/// `main.rs`). To intercept it without changing the trait, the backend loads a
/// `(chrom, start, stop) → gene_id` reverse index from the genes table at
/// startup. Then:
///
/// - `get_variants` whose coordinates **exactly** match a known gene boundary →
///   served from the materialized cache (RAM / file / lazy, per [`CacheMode`]).
///   A blob that hasn't been built yet (partial cache) degrades gracefully to
///   the fallback.
/// - any other `get_variants` (ad-hoc region), plus `get_gene`,
///   `get_gene_by_symbol`, `search_genes`, and `get_variant_detail` → delegated
///   to the `fallback` (conventionally `hail-gcs`).
///
/// The cached unit is the **variant list** (`Vec<Variant>`), matching the Phase-4
/// blob shape. Gene *metadata* (`get_gene`) is a cheap point lookup that the
/// wrapped Hail backend answers at full fidelity (constraint metrics, transcript
/// list) — the cache deliberately only intercepts the expensive part, the
/// gene's variant payload. This keeps the oracle's gene/region/detail checks
/// identical to the reference backend on cacheable queries.
///
/// ## Cache methodology note
///
/// For every *other* benchmark arm the API `moka` cache is bypassed to isolate
/// the datastore. Here the materialized cache **is** the system under test, so
/// `gcs-cache-lazy` keeps its own warm-on-demand `moka` independent of the API
/// cache: cold = cache-miss → fallback Hail, warm = cache-hit.
pub struct GcsCacheBackend {
    fallback: Box<dyn VariantBackend>,
    /// `(norm_contig, start, stop) → gene_id`, for recognizing gene-view region
    /// queries. Contig is normalized to its bare form (`chr1` → `1`) so the
    /// genes table and incoming queries agree regardless of `chr` prefix.
    gene_boundaries: HashMap<(String, i64, i64), String>,
    store: CacheStore,
}

/// Backing store for the precomputed gene-view blobs, one variant per
/// [`CacheMode`].
enum CacheStore {
    /// All gene-view blobs resident in RAM, keyed by gene_id.
    Mem(HashMap<String, Arc<Vec<Variant>>>),
    /// Per-hit read of `{dir}/{gene_id}.json` from local-SSD.
    File { dir: PathBuf },
    /// Warm-on-demand `moka` cache over the fallback, keyed by gene_id.
    Lazy(moka::future::Cache<String, Arc<Vec<Variant>>>),
}

/// Normalize a contig to its bare form (`chr1` → `1`, `chrX` → `X`).
fn norm_contig(contig: &str) -> String {
    contig.strip_prefix("chr").unwrap_or(contig).to_string()
}

/// Path to a gene's precomputed blob within a cache directory.
fn blob_path(dir: &PathBuf, gene_id: &str) -> PathBuf {
    dir.join(format!("{gene_id}.json"))
}

/// Parse a `{gene_id}.json` blob (a JSON array of [`Variant`]) from raw bytes.
fn parse_blob(bytes: &[u8]) -> Result<Vec<Variant>> {
    serde_json::from_slice::<Vec<Variant>>(bytes).context("malformed gene-view cache blob")
}

impl GcsCacheBackend {
    /// Build the backend: wrap `fallback`, derive the gene-boundary reverse index
    /// from `genes`, and initialize the store for `mode`.
    ///
    /// For [`CacheMode::Mem`] every blob present in `cache_dir` is loaded into
    /// RAM now (genes without a blob simply fall through at query time). For
    /// [`CacheMode::File`] `cache_dir` is recorded for per-hit reads. For
    /// [`CacheMode::Lazy`] `cache_dir` is ignored and an empty `moka` cache is
    /// created.
    pub fn new(
        fallback: Box<dyn VariantBackend>,
        genes: &[Gene],
        mode: CacheMode,
        cache_dir: Option<String>,
    ) -> Result<Self> {
        let mut gene_boundaries = HashMap::with_capacity(genes.len());
        for gene in genes {
            gene_boundaries.insert(
                (norm_contig(&gene.chrom), gene.start, gene.stop),
                gene.gene_id.clone(),
            );
        }
        info!(
            "gcs-cache: indexed {} gene boundaries (mode={:?})",
            gene_boundaries.len(),
            mode
        );

        let store = match mode {
            CacheMode::Mem => {
                let dir = PathBuf::from(cache_dir.clone().ok_or_else(|| {
                    anyhow::anyhow!("gcs-cache mode=mem requires `cache_dir`")
                })?);
                let mut blobs: HashMap<String, Arc<Vec<Variant>>> = HashMap::new();
                let mut missing = 0usize;
                for gene_id in gene_boundaries.values() {
                    let path = blob_path(&dir, gene_id);
                    match std::fs::read(&path) {
                        Ok(bytes) => match parse_blob(&bytes) {
                            Ok(variants) => {
                                blobs.insert(gene_id.clone(), Arc::new(variants));
                            }
                            Err(e) => warn!("gcs-cache: skipping {:?}: {}", path, e),
                        },
                        Err(_) => missing += 1,
                    }
                }
                info!(
                    "gcs-cache: loaded {} gene-view blobs into RAM ({} not yet built)",
                    blobs.len(),
                    missing
                );
                CacheStore::Mem(blobs)
            }
            CacheMode::File => {
                let dir = PathBuf::from(cache_dir.clone().ok_or_else(|| {
                    anyhow::anyhow!("gcs-cache mode=file requires `cache_dir`")
                })?);
                // Per-hit reads degrade to the fallback when a blob is missing,
                // so a wrong `cache_dir` would silently serve everything cold.
                // Warn loudly at startup to keep the benchmark honest.
                if !dir.is_dir() {
                    warn!("gcs-cache mode=file: cache_dir {:?} is not a directory; gene-views will fall through to the fallback", dir);
                }
                CacheStore::File { dir }
            }
            CacheMode::Lazy => {
                // Entry-keyed cache over gene blobs; one entry per gene, so a
                // generous bound over the ~20k-gene hot set never evicts.
                CacheStore::Lazy(
                    moka::future::Cache::builder()
                        .max_capacity(64 * 1024)
                        .build(),
                )
            }
        };

        Ok(Self {
            fallback,
            gene_boundaries,
            store,
        })
    }

    /// gene_id whose boundary exactly equals `(chrom, start, end)`, if any.
    fn gene_at_boundary(&self, chrom: &str, start: i64, end: i64) -> Option<&str> {
        self.gene_boundaries
            .get(&(norm_contig(chrom), start, end))
            .map(String::as_str)
    }
}

#[async_trait]
impl VariantBackend for GcsCacheBackend {
    // Gene metadata, symbol resolution, search, and variant-by-id all fall
    // through: they are not part of the materialized (variant-payload) cache.

    async fn get_gene(&self, gene_id: &str) -> Result<Option<Gene>> {
        self.fallback.get_gene(gene_id).await
    }

    async fn get_gene_by_symbol(&self, symbol: &str) -> Result<Option<Gene>> {
        self.fallback.get_gene_by_symbol(symbol).await
    }

    async fn search_genes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        self.fallback.search_genes(query, limit).await
    }

    async fn get_variant_detail(
        &self,
        variant_id: &str,
        force_fallback: bool,
    ) -> Result<Option<VariantDetails>> {
        self.fallback
            .get_variant_detail(variant_id, force_fallback)
            .await
    }

    async fn get_variant_detail_timed(
        &self,
        variant_id: &str,
        force_fallback: bool,
    ) -> Result<(Option<VariantDetails>, QueryStats)> {
        self.fallback
            .get_variant_detail_timed(variant_id, force_fallback)
            .await
    }

    async fn get_variants(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        force_fallback: bool,
    ) -> Result<Vec<Variant>> {
        Ok(self
            .get_variants_timed(chrom, start, end, force_fallback)
            .await?
            .0)
    }

    async fn get_variants_timed(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        force_fallback: bool,
    ) -> Result<(Vec<Variant>, QueryStats)> {
        // `force_fallback` (and any non-gene-boundary region) bypasses the cache
        // entirely — this is the uncacheable tail that reports baseline latency.
        if force_fallback {
            return self.fallback.get_variants_timed(chrom, start, end, false).await;
        }

        let Some(gene_id) = self.gene_at_boundary(chrom, start, end).map(str::to_owned) else {
            debug!("gcs-cache: {}:{}-{} not a gene boundary -> fallback", chrom, start, end);
            return self.fallback.get_variants_timed(chrom, start, end, false).await;
        };

        match &self.store {
            CacheStore::Mem(blobs) => {
                if let Some(variants) = blobs.get(&gene_id) {
                    debug!("gcs-cache: RAM hit for gene {}", gene_id);
                    // `db_query_ms` = the O(1) map lookup + clone out of RAM;
                    // there is no per-hit deserialization in mem mode.
                    let t = Instant::now();
                    let out = variants.as_ref().clone();
                    let db_query_ms = t.elapsed().as_secs_f64() * 1e3;
                    return Ok((out, QueryStats { db_query_ms, deserialize_ms: 0.0 }));
                }
                debug!("gcs-cache: gene {} not in RAM cache -> fallback", gene_id);
                self.fallback.get_variants_timed(chrom, start, end, false).await
            }
            CacheStore::File { dir } => {
                let path = blob_path(dir, &gene_id);
                // Read off the async runtime: blob reads are blocking file I/O.
                let read = tokio::task::spawn_blocking(move || {
                    let t_io = Instant::now();
                    let bytes = std::fs::read(&path).ok()?;
                    let io_ms = t_io.elapsed().as_secs_f64() * 1e3;
                    let t_de = Instant::now();
                    let variants = parse_blob(&bytes).ok()?;
                    let de_ms = t_de.elapsed().as_secs_f64() * 1e3;
                    Some((variants, io_ms, de_ms))
                })
                .await?;
                match read {
                    Some((variants, io_ms, de_ms)) => {
                        debug!("gcs-cache: file hit for gene {}", gene_id);
                        Ok((variants, QueryStats { db_query_ms: io_ms, deserialize_ms: de_ms }))
                    }
                    None => {
                        debug!("gcs-cache: blob for gene {} missing/unreadable -> fallback", gene_id);
                        self.fallback.get_variants_timed(chrom, start, end, false).await
                    }
                }
            }
            CacheStore::Lazy(cache) => {
                if let Some(variants) = cache.get(&gene_id).await {
                    debug!("gcs-cache: lazy warm hit for gene {}", gene_id);
                    let t = Instant::now();
                    let out = variants.as_ref().clone();
                    let db_query_ms = t.elapsed().as_secs_f64() * 1e3;
                    return Ok((out, QueryStats { db_query_ms, deserialize_ms: 0.0 }));
                }
                // Cold: pull from the fallback, warm the cache, report fallback
                // (cold-path) timing.
                debug!("gcs-cache: lazy miss for gene {} -> fallback + warm", gene_id);
                let (variants, stats) =
                    self.fallback.get_variants_timed(chrom, start, end, false).await?;
                cache.insert(gene_id, Arc::new(variants.clone())).await;
                Ok((variants, stats))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::api::Variant;

    fn gene(gene_id: &str, chrom: &str, start: i64, stop: i64) -> Gene {
        Gene {
            gene_id: gene_id.into(),
            gene_symbol: Some("FAKE".into()),
            gencode_symbol: None,
            chrom: chrom.into(),
            start,
            stop,
            strand: None,
            canonical_transcript_id: None,
            transcripts: None,
            exons: None,
            constraint: None,
        }
    }

    fn variant(chrom: &str, pos: i64, tag: &str) -> Variant {
        Variant {
            variant_id: Some(format!("{chrom}-{pos}-A-C")),
            pos,
            chrom: chrom.into(),
            alleles: vec!["A".into(), "C".into()],
            rsids: None,
            consequence: None,
            hgvsc: None,
            hgvsp: None,
            gene_id: None,
            gene_symbol: Some(tag.into()),
            transcript_id: None,
            lof: None,
            ac: 0,
            an: 0,
            af: 0.0,
            allele_freq: 0.0,
        }
    }

    /// Fallback that tags every result with a marker symbol so tests can tell
    /// when a query fell through instead of being served from cache.
    struct TagBackend {
        tag: &'static str,
    }

    #[async_trait]
    impl VariantBackend for TagBackend {
        async fn get_gene(&self, gene_id: &str) -> Result<Option<Gene>> {
            Ok(Some(gene(gene_id, "chr1", 100, 200)))
        }
        async fn get_gene_by_symbol(&self, _symbol: &str) -> Result<Option<Gene>> {
            Ok(Some(gene("ENSGSYM", "chr1", 100, 200)))
        }
        async fn search_genes(&self, query: &str, _limit: usize) -> Result<Vec<SearchResult>> {
            Ok(vec![SearchResult {
                gene_id: self.tag.into(),
                gene_symbol: query.into(),
                chrom: None,
                start: None,
                stop: None,
            }])
        }
        async fn get_variants(
            &self,
            chrom: &str,
            start: i64,
            _end: i64,
            _force_fallback: bool,
        ) -> Result<Vec<Variant>> {
            Ok(vec![variant(chrom, start, self.tag)])
        }
        async fn get_variant_detail(
            &self,
            variant_id: &str,
            _force_fallback: bool,
        ) -> Result<Option<VariantDetails>> {
            Ok(Some(VariantDetails {
                variant_id: Some(variant_id.into()),
                pos: 0,
                chrom: self.tag.into(),
                alleles: vec!["A".into(), "C".into()],
                rsids: None,
                consequence: None,
                hgvsc: None,
                hgvsp: None,
                gene_id: None,
                gene_symbol: None,
                transcript_id: None,
                ac: 0,
                an: 0,
                af: 0.0,
                allele_freq: 0.0,
                caid: None,
                exome: None,
                genome: None,
                joint: None,
                transcript_consequences: None,
                in_silico_predictors: None,
                coverage: None,
            }))
        }
    }

    /// One gene (`ENSG1`) on chr1 spanning 100..=200, with a prebuilt mem blob of
    /// two CACHE-tagged variants. The fallback tags everything COLD.
    fn mem_backend() -> GcsCacheBackend {
        let mut gene_boundaries = HashMap::new();
        gene_boundaries.insert(("1".to_string(), 100, 200), "ENSG1".to_string());
        let mut blobs = HashMap::new();
        blobs.insert(
            "ENSG1".to_string(),
            Arc::new(vec![variant("chr1", 110, "CACHE"), variant("chr1", 150, "CACHE")]),
        );
        GcsCacheBackend {
            fallback: Box::new(TagBackend { tag: "COLD" }),
            gene_boundaries,
            store: CacheStore::Mem(blobs),
        }
    }

    fn tag_of(variants: &[Variant]) -> String {
        variants[0].gene_symbol.clone().unwrap()
    }

    #[tokio::test]
    async fn gene_boundary_query_served_from_cache() {
        let b = mem_backend();
        let v = b.get_variants("chr1", 100, 200, false).await.unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(tag_of(&v), "CACHE");
        // Contig-prefix agnostic: bare "1" resolves to the same boundary.
        let v = b.get_variants("1", 100, 200, false).await.unwrap();
        assert_eq!(tag_of(&v), "CACHE");
    }

    #[tokio::test]
    async fn non_gene_region_falls_through() {
        let b = mem_backend();
        // Same chrom, but not an exact gene boundary -> fallback.
        let v = b.get_variants("chr1", 100, 199, false).await.unwrap();
        assert_eq!(tag_of(&v), "COLD");
        let v = b.get_variants("chr1", 5000, 6000, false).await.unwrap();
        assert_eq!(tag_of(&v), "COLD");
    }

    #[tokio::test]
    async fn force_fallback_bypasses_cache_on_gene_boundary() {
        let b = mem_backend();
        let v = b.get_variants("chr1", 100, 200, true).await.unwrap();
        assert_eq!(tag_of(&v), "COLD");
    }

    #[tokio::test]
    async fn missing_blob_degrades_to_fallback() {
        // Gene boundary is indexed, but no blob was built for it.
        let mut gene_boundaries = HashMap::new();
        gene_boundaries.insert(("1".to_string(), 100, 200), "ENSG1".to_string());
        let b = GcsCacheBackend {
            fallback: Box::new(TagBackend { tag: "COLD" }),
            gene_boundaries,
            store: CacheStore::Mem(HashMap::new()),
        };
        let v = b.get_variants("chr1", 100, 200, false).await.unwrap();
        assert_eq!(tag_of(&v), "COLD");
    }

    #[tokio::test]
    async fn search_and_variant_detail_fall_through() {
        let b = mem_backend();
        let results = b.search_genes("PCSK9", 5).await.unwrap();
        assert_eq!(results[0].gene_id, "COLD");
        let detail = b.get_variant_detail("1-100-A-C", false).await.unwrap();
        assert_eq!(detail.unwrap().chrom, "COLD");
    }

    #[tokio::test]
    async fn lazy_mode_warms_on_first_hit() {
        let genes = vec![gene("ENSG1", "chr1", 100, 200)];
        let b = GcsCacheBackend::new(
            Box::new(TagBackend { tag: "COLD" }),
            &genes,
            CacheMode::Lazy,
            None,
        )
        .unwrap();
        // First hit is cold (served by fallback, then warmed).
        let v = b.get_variants("chr1", 100, 200, false).await.unwrap();
        assert_eq!(tag_of(&v), "COLD");
        // Second hit returns the warmed entry (same value, now from moka).
        let v = b.get_variants("chr1", 100, 200, false).await.unwrap();
        assert_eq!(tag_of(&v), "COLD");
    }

    #[test]
    fn new_mem_requires_cache_dir() {
        let genes = vec![gene("ENSG1", "chr1", 100, 200)];
        let result = GcsCacheBackend::new(
            Box::new(TagBackend { tag: "COLD" }),
            &genes,
            CacheMode::Mem,
            None,
        );
        let err = result.err().expect("mem mode without cache_dir should error");
        assert!(err.to_string().contains("cache_dir"));
    }
}
