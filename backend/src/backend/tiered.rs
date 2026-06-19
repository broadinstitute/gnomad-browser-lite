use std::collections::HashMap;

use anyhow::Result;
use async_trait::async_trait;
use rust_lapper::{Interval, Lapper};
use tracing::debug;

use super::{QueryStats, VariantBackend};
use crate::config::TierRouting;
use crate::models::api::{Gene, SearchResult, Variant, VariantDetails};

/// Region-aware two-tier backend.
///
/// At startup the gene-derived "hot set" (CDS exons or gene bodies, per the
/// configured [`TierRouting`]) is loaded into an in-memory interval tree
/// ([`HotIntervals`]). Routing is then purely geometric:
///
/// - A region query **100%-contained** in the hot set → `fast` tier.
/// - A query that falls in a cold gap, or **spans** hot and cold → the *entire*
///   region goes to the `fallback` (cold) tier. We never split a region and
///   scatter/gather across tiers at the API layer: reading the whole Hail block
///   from the cold tier beats merging a Postgres stream with a Parquet/Hail
///   stream and re-sorting (DESIGN.md "Region-aware tier router").
///
/// gnomAD v4 records are *unified* (each carries both `exome.freq` and
/// `genome.freq`), so the hot/cold split is region-based, not a callset split —
/// the fast tier holds the same rows as the cold tier for the regions it covers,
/// which is why a contained query can be answered entirely from `fast`.
pub struct TieredBackend {
    pub fast: Box<dyn VariantBackend>,
    pub fallback: Box<dyn VariantBackend>,
    pub hot: HotIntervals,
}

/// Per-contig interval trees describing the hot (fast-tier) region set.
///
/// Intervals are stored half-open in `u32` coordinate space. The map key is the
/// contig with any `chr` prefix stripped, so `chr1` and `1` resolve to the same
/// tree (the genes table and incoming queries disagree on the prefix — see
/// `dual_contig_intervals` in `hail.rs`).
#[derive(Default)]
pub struct HotIntervals {
    trees: HashMap<String, Lapper<u32, ()>>,
}

/// Normalize a contig to its bare form (`chr1` → `1`, `chrX` → `X`).
fn norm_contig(contig: &str) -> String {
    contig.strip_prefix("chr").unwrap_or(contig).to_string()
}

impl HotIntervals {
    /// Build the hot-interval trees from gene geometry.
    ///
    /// For [`TierRouting::Genebody`] each gene contributes one interval
    /// `[start - buffer, stop + buffer]`. For [`TierRouting::Cds`] each CDS exon
    /// contributes `[start - splice_buffer, stop + splice_buffer]`; introns
    /// (gaps between CDS exons) are deliberately *not* covered, so a gene-view
    /// region query spanning them is not contained and routes to cold.
    pub fn from_genes(
        genes: &[Gene],
        routing: TierRouting,
        cds_splice_buffer: i64,
        genebody_buffer: i64,
    ) -> Self {
        let mut by_contig: HashMap<String, Vec<Interval<u32, ()>>> = HashMap::new();

        let mut push = |contig: &str, lo: i64, hi: i64| {
            if hi < lo {
                return;
            }
            // Inclusive [lo, hi] → half-open [lo, hi + 1); clamp to non-negative.
            let start = lo.max(0) as u32;
            let stop = (hi.max(0) as u32).saturating_add(1);
            by_contig
                .entry(norm_contig(contig))
                .or_default()
                .push(Interval { start, stop, val: () });
        };

        for gene in genes {
            match routing {
                TierRouting::Genebody => {
                    push(
                        &gene.chrom,
                        gene.start - genebody_buffer,
                        gene.stop + genebody_buffer,
                    );
                }
                TierRouting::Cds => {
                    if let Some(exons) = &gene.exons {
                        for exon in exons {
                            if exon.feature_type.eq_ignore_ascii_case("CDS") {
                                push(
                                    &gene.chrom,
                                    exon.start - cds_splice_buffer,
                                    exon.stop + cds_splice_buffer,
                                );
                            }
                        }
                    }
                }
            }
        }

        let trees = by_contig
            .into_iter()
            .map(|(contig, intervals)| (contig, Lapper::new(intervals)))
            .collect();
        HotIntervals { trees }
    }

    /// Number of contigs with at least one hot interval.
    pub fn num_contigs(&self) -> usize {
        self.trees.len()
    }

    pub fn is_empty(&self) -> bool {
        self.trees.is_empty()
    }

    /// True iff the inclusive, 1-based region `[start, end]` is *fully* covered
    /// by hot intervals on `chrom` (no gaps). A region that overlaps the hot set
    /// only partially — i.e. spans a cold gap — returns `false`.
    pub fn fully_contains(&self, chrom: &str, start: i64, end: i64) -> bool {
        if start > end {
            return false;
        }
        let Some(tree) = self.trees.get(&norm_contig(chrom)) else {
            return false;
        };

        // Inclusive [start, end] → half-open [qs, qe).
        let qs = start.max(0) as u32;
        let qe = (end.max(0) as u32).saturating_add(1);

        // Sweep the overlapping intervals (yielded in start order) and require
        // the union to cover [qs, qe) without a gap.
        let mut cursor = qs;
        for iv in tree.find(qs, qe) {
            if iv.start > cursor {
                return false; // gap before this interval
            }
            if iv.stop > cursor {
                cursor = iv.stop;
            }
            if cursor >= qe {
                return true;
            }
        }
        cursor >= qe
    }
}

/// Parse the `chrom`/`pos` out of a `chrom-pos-ref-alt` variant id for routing.
fn variant_locus(variant_id: &str) -> Option<(String, i64)> {
    let mut parts = variant_id.splitn(3, '-');
    let chrom = parts.next()?.to_string();
    let pos: i64 = parts.next()?.parse().ok()?;
    Some((chrom, pos))
}

#[async_trait]
impl VariantBackend for TieredBackend {
    async fn get_gene(&self, gene_id: &str) -> Result<Option<Gene>> {
        match self.fast.get_gene(gene_id).await {
            Ok(Some(gene)) => Ok(Some(gene)),
            Ok(None) => {
                debug!("gene {} not in fast backend, falling back", gene_id);
                self.fallback.get_gene(gene_id).await
            }
            Err(e) => {
                debug!("fast backend error for gene {}: {}, falling back", gene_id, e);
                self.fallback.get_gene(gene_id).await
            }
        }
    }

    async fn get_gene_by_symbol(&self, symbol: &str) -> Result<Option<Gene>> {
        match self.fast.get_gene_by_symbol(symbol).await {
            Ok(Some(gene)) => Ok(Some(gene)),
            Ok(None) => {
                debug!("gene symbol {} not in fast backend, falling back", symbol);
                self.fallback.get_gene_by_symbol(symbol).await
            }
            Err(e) => {
                debug!("fast backend error for symbol {}: {}, falling back", symbol, e);
                self.fallback.get_gene_by_symbol(symbol).await
            }
        }
    }

    async fn search_genes(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        match self.fast.search_genes(query, limit).await {
            Ok(results) if !results.is_empty() => Ok(results),
            Ok(_) => {
                debug!("search '{}' empty in fast backend, falling back", query);
                self.fallback.search_genes(query, limit).await
            }
            Err(e) => {
                debug!("fast backend error for search '{}': {}, falling back", query, e);
                self.fallback.search_genes(query, limit).await
            }
        }
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
        if force_fallback {
            debug!("force_fallback set, routing {}:{}-{} to cold tier", chrom, start, end);
            return self.fallback.get_variants_timed(chrom, start, end, false).await;
        }

        if self.hot.fully_contains(chrom, start, end) {
            debug!("region {}:{}-{} fully contained in hot set -> fast tier", chrom, start, end);
            match self.fast.get_variants_timed(chrom, start, end, false).await {
                Ok(result) => Ok(result),
                Err(e) => {
                    debug!("fast tier error for {}:{}-{}: {}, falling back to cold", chrom, start, end, e);
                    self.fallback.get_variants_timed(chrom, start, end, false).await
                }
            }
        } else {
            debug!("region {}:{}-{} spans a cold gap -> entire region to cold tier", chrom, start, end);
            self.fallback.get_variants_timed(chrom, start, end, false).await
        }
    }

    async fn get_variant_detail(
        &self,
        variant_id: &str,
        force_fallback: bool,
    ) -> Result<Option<VariantDetails>> {
        Ok(self.get_variant_detail_timed(variant_id, force_fallback).await?.0)
    }

    async fn get_variant_detail_timed(
        &self,
        variant_id: &str,
        force_fallback: bool,
    ) -> Result<(Option<VariantDetails>, QueryStats)> {
        if force_fallback {
            debug!("force_fallback set, routing variant {} to cold tier", variant_id);
            return self.fallback.get_variant_detail_timed(variant_id, false).await;
        }

        // Route by the variant's locus: a point fully inside the hot set goes to
        // the fast tier, everything else to cold (full coverage). If the id can't
        // be parsed, route to cold — it has complete coverage.
        let hot = variant_locus(variant_id)
            .map(|(chrom, pos)| self.hot.fully_contains(&chrom, pos, pos))
            .unwrap_or(false);

        if hot {
            debug!("variant {} is in hot set -> fast tier", variant_id);
            match self.fast.get_variant_detail_timed(variant_id, false).await {
                Ok(result) => Ok(result),
                Err(e) => {
                    debug!("fast tier error for variant {}: {}, falling back to cold", variant_id, e);
                    self.fallback.get_variant_detail_timed(variant_id, false).await
                }
            }
        } else {
            debug!("variant {} not in hot set -> cold tier", variant_id);
            self.fallback.get_variant_detail_timed(variant_id, false).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::api::Exon;

    /// Build a minimal `Gene` with the given bounds and CDS exons.
    fn gene(chrom: &str, start: i64, stop: i64, cds: &[(i64, i64)]) -> Gene {
        Gene {
            gene_id: "ENSG0".into(),
            gene_symbol: Some("FAKE".into()),
            gencode_symbol: None,
            chrom: chrom.into(),
            start,
            stop,
            strand: None,
            canonical_transcript_id: None,
            transcripts: None,
            exons: Some(
                cds.iter()
                    .map(|(s, e)| Exon {
                        feature_type: "CDS".into(),
                        start: *s,
                        stop: *e,
                    })
                    .collect(),
            ),
            constraint: None,
        }
    }

    /// One gene on chr1: body [100, 300], two CDS exons [100,120] and [200,220]
    /// separated by an intron, plus a UTR exon that must be ignored for CDS
    /// routing.
    fn fixture() -> Vec<Gene> {
        let mut g = gene("chr1", 100, 300, &[(100, 120), (200, 220)]);
        // Add a non-CDS exon to prove CDS routing filters on feature_type.
        g.exons.as_mut().unwrap().push(Exon {
            feature_type: "UTR".into(),
            start: 400,
            stop: 450,
        });
        vec![g]
    }

    #[test]
    fn cds_contained_disjoint_and_spans_both() {
        let hot = HotIntervals::from_genes(&fixture(), TierRouting::Cds, 0, 0);

        // Contained: entirely inside a single CDS exon.
        assert!(hot.fully_contains("chr1", 100, 120));
        assert!(hot.fully_contains("chr1", 205, 215));
        // Contig-prefix agnostic.
        assert!(hot.fully_contains("1", 100, 120));

        // Disjoint: in the intron gap, or off the gene, or in the ignored UTR.
        assert!(!hot.fully_contains("chr1", 130, 150)); // intron
        assert!(!hot.fully_contains("chr1", 1000, 2000)); // off gene
        assert!(!hot.fully_contains("chr1", 400, 450)); // UTR exon, not CDS
        assert!(!hot.fully_contains("chr2", 100, 120)); // unknown contig

        // Spans both: starts in a CDS exon but extends across the intron.
        assert!(!hot.fully_contains("chr1", 110, 210)); // exon1 → intron → exon2
        assert!(!hot.fully_contains("chr1", 115, 125)); // exon1 → past its end
    }

    #[test]
    fn cds_splice_buffer_widens_exons() {
        let hot = HotIntervals::from_genes(&fixture(), TierRouting::Cds, 10, 0);
        // 10bp splice buffer extends exon [100,120] to [90,130].
        assert!(hot.fully_contains("chr1", 90, 130));
        assert!(!hot.fully_contains("chr1", 89, 130));
    }

    #[test]
    fn genebody_contained_disjoint_and_spans_both() {
        let hot = HotIntervals::from_genes(&fixture(), TierRouting::Genebody, 0, 0);

        // Contained: anywhere within the gene body, including the intron — the
        // whole [100,300] span is hot under genebody routing.
        assert!(hot.fully_contains("chr1", 100, 300));
        assert!(hot.fully_contains("chr1", 130, 150)); // intron is hot here
        assert!(hot.fully_contains("chr1", 110, 210));

        // Disjoint: entirely outside the gene body.
        assert!(!hot.fully_contains("chr1", 500, 600));

        // Spans both: starts inside the body, extends past its end.
        assert!(!hot.fully_contains("chr1", 250, 350));
        assert!(!hot.fully_contains("chr1", 50, 150));
    }

    #[test]
    fn genebody_buffer_widens_body() {
        let hot = HotIntervals::from_genes(&fixture(), TierRouting::Genebody, 0, 50);
        // 50bp flank extends body [100,300] to [50,350].
        assert!(hot.fully_contains("chr1", 50, 350));
        assert!(!hot.fully_contains("chr1", 49, 350));
    }

    #[test]
    fn empty_hot_set_contains_nothing() {
        let hot = HotIntervals::default();
        assert!(hot.is_empty());
        assert!(!hot.fully_contains("chr1", 100, 120));
    }

    // ---- Routing through a TieredBackend with tagged mock tiers ----

    /// A backend that tags every result with a marker symbol so tests can tell
    /// which tier answered.
    struct TagBackend {
        tag: &'static str,
    }

    #[async_trait]
    impl VariantBackend for TagBackend {
        async fn get_gene(&self, _gene_id: &str) -> Result<Option<Gene>> {
            Ok(None)
        }
        async fn get_gene_by_symbol(&self, _symbol: &str) -> Result<Option<Gene>> {
            Ok(None)
        }
        async fn search_genes(&self, _query: &str, _limit: usize) -> Result<Vec<SearchResult>> {
            Ok(vec![])
        }
        async fn get_variants(
            &self,
            chrom: &str,
            start: i64,
            _end: i64,
            _force_fallback: bool,
        ) -> Result<Vec<Variant>> {
            let af = 0.0;
            Ok(vec![Variant {
                variant_id: Some(self.tag.to_string()),
                pos: start,
                chrom: chrom.to_string(),
                alleles: vec!["A".into(), "C".into()],
                rsids: None,
                consequence: None,
                hgvsc: None,
                hgvsp: None,
                gene_id: None,
                gene_symbol: Some(self.tag.to_string()),
                transcript_id: None,
                lof: None,
                ac: 0,
                an: 0,
                af,
                allele_freq: af,
            }])
        }
        async fn get_variant_detail(
            &self,
            _variant_id: &str,
            _force_fallback: bool,
        ) -> Result<Option<VariantDetails>> {
            Ok(None)
        }
    }

    fn tiered() -> TieredBackend {
        TieredBackend {
            fast: Box::new(TagBackend { tag: "FAST" }),
            fallback: Box::new(TagBackend { tag: "COLD" }),
            hot: HotIntervals::from_genes(&fixture(), TierRouting::Cds, 0, 0),
        }
    }

    async fn answering_tier(b: &TieredBackend, start: i64, end: i64, force: bool) -> String {
        let v = b.get_variants("chr1", start, end, force).await.unwrap();
        v[0].gene_symbol.clone().unwrap()
    }

    #[tokio::test]
    async fn routes_contained_to_fast_and_rest_to_cold() {
        let b = tiered();
        // Contained CDS exon → fast.
        assert_eq!(answering_tier(&b, 100, 120, false).await, "FAST");
        // Intron gap → cold.
        assert_eq!(answering_tier(&b, 130, 150, false).await, "COLD");
        // Spans exon → intron → exon → entire region to cold.
        assert_eq!(answering_tier(&b, 110, 210, false).await, "COLD");
        // force_fallback overrides even a contained region.
        assert_eq!(answering_tier(&b, 100, 120, true).await, "COLD");
    }
}
