use std::sync::Arc;

use async_trait::async_trait;
use genohype_mcp::types as mcp;
use genohype_mcp::GenomicDataProvider;

use crate::backend::VariantBackend;
use crate::models::api;

pub struct GnomadMcpProvider {
    pub backend: Arc<dyn VariantBackend>,
}

impl GnomadMcpProvider {
    pub fn new(backend: Arc<dyn VariantBackend>) -> Self {
        Self { backend }
    }
}

// ---------------------------------------------------------------------------
// From impls: api types → mcp types
// ---------------------------------------------------------------------------

impl From<api::Variant> for mcp::VariantSummary {
    fn from(v: api::Variant) -> Self {
        let variant_id = v.variant_id.clone().unwrap_or_default();
        let parts: Vec<&str> = variant_id.split('-').collect();
        let (ref_allele, alt_allele) = if v.alleles.len() >= 2 {
            (v.alleles[0].clone(), v.alleles[1].clone())
        } else if parts.len() == 4 {
            (parts[2].to_string(), parts[3].to_string())
        } else {
            (String::new(), String::new())
        };
        mcp::VariantSummary {
            variant_id,
            chrom: v.chrom,
            pos: v.pos,
            ref_allele,
            alt_allele,
            rsids: v.rsids.unwrap_or_default(),
            consequence: v.consequence,
            hgvsc: v.hgvsc,
            hgvsp: v.hgvsp,
            gene_id: v.gene_id,
            gene_symbol: v.gene_symbol,
            transcript_id: v.transcript_id,
            lof: v.lof,
            ac: v.ac,
            an: v.an,
            af: v.af,
        }
    }
}

impl From<api::TranscriptConsequence> for mcp::TranscriptConsequence {
    fn from(tc: api::TranscriptConsequence) -> Self {
        mcp::TranscriptConsequence {
            gene_id: tc.gene_id,
            gene_symbol: tc.gene_symbol,
            transcript_id: tc.transcript_id.clone(),
            transcript_version: tc.transcript_version,
            consequence_terms: tc.consequence_terms.unwrap_or_default(),
            major_consequence: tc.major_consequence,
            hgvsc: tc.hgvsc,
            hgvsp: tc.hgvsp,
            is_canonical: tc.is_canonical.unwrap_or(false),
            is_mane_select: tc.is_mane_select.unwrap_or(false),
            lof: tc.lof,
            lof_filter: tc.lof_filter,
            lof_flags: tc.lof_flags,
            biotype: tc.biotype,
            domains: tc.domains.unwrap_or_default(),
            refseq_id: tc.refseq_id,
        }
    }
}

impl From<api::Population> for mcp::PopulationFrequency {
    fn from(p: api::Population) -> Self {
        let an = p.an;
        let ac = p.ac;
        mcp::PopulationFrequency {
            id: p.id,
            ac,
            an,
            af: if an > 0 { ac as f64 / an as f64 } else { 0.0 },
            homozygote_count: p.homozygote_count,
            hemizygote_count: p.hemizygote_count,
        }
    }
}

impl From<api::VariantDetails> for mcp::VariantDetails {
    fn from(d: api::VariantDetails) -> Self {
        let variant_id = d.variant_id.clone().unwrap_or_default();
        let (ref_allele, alt_allele) = if d.alleles.len() >= 2 {
            (d.alleles[0].clone(), d.alleles[1].clone())
        } else {
            let parts: Vec<&str> = variant_id.split('-').collect();
            if parts.len() == 4 {
                (parts[2].to_string(), parts[3].to_string())
            } else {
                (String::new(), String::new())
            }
        };

        let in_silico = d.in_silico_predictors.as_ref().and_then(|v| {
            Some(mcp::InSilicoPredictors {
                revel: v.get("revel_max").and_then(|x| x.as_f64()),
                cadd: v.get("cadd").and_then(|c| c.get("phred")).and_then(|x| x.as_f64()),
                splice_ai: v.get("spliceai_ds_max").and_then(|x| x.as_f64()),
                pangolin: v.get("pangolin_largest_ds").and_then(|x| x.as_f64()),
                phylop: v.get("phylop").and_then(|x| x.as_f64()),
                polyphen: v.get("polyphen_max").and_then(|x| {
                    x.as_f64().map(|score| {
                        if score > 0.908 { "probably_damaging" }
                        else if score > 0.446 { "possibly_damaging" }
                        else { "benign" }
                    }).map(String::from)
                }),
                sift: v.get("sift_max").and_then(|x| {
                    x.as_f64().map(|score| {
                        if score < 0.05 { "deleterious" } else { "tolerated" }
                    }).map(String::from)
                }),
            })
        });

        // Parse exome/genome from serde_json::Value into typed structs
        let exome = d.exome.as_ref().and_then(|v| parse_sequencing_type_data(v));
        let genome = d.genome.as_ref().and_then(|v| parse_sequencing_type_data(v));

        let transcript_consequences: Vec<mcp::TranscriptConsequence> = d
            .transcript_consequences
            .unwrap_or_default()
            .into_iter()
            .map(Into::into)
            .collect();

        mcp::VariantDetails {
            variant_id,
            chrom: d.chrom,
            pos: d.pos,
            ref_allele,
            alt_allele,
            rsids: d.rsids.unwrap_or_default(),
            caid: d.caid,
            ac: Some(d.ac),
            an: Some(d.an),
            af: Some(d.af),
            homozygote_count: None,
            hemizygote_count: None,
            exome,
            genome,
            joint: None, // TODO: parse joint data when needed
            transcript_consequences,
            in_silico_predictors: in_silico,
            flags: vec![],
            coverage: None,
        }
    }
}

fn parse_sequencing_type_data(v: &serde_json::Value) -> Option<mcp::SequencingTypeData> {
    let ac = v.get("ac").and_then(|x| x.as_i64()).unwrap_or(0);
    let an = v.get("an").and_then(|x| x.as_i64()).unwrap_or(0);
    let af = v.get("af").and_then(|x| x.as_f64())
        .unwrap_or(if an > 0 { ac as f64 / an as f64 } else { 0.0 });
    let homozygote_count = v.get("homozygote_count").and_then(|x| x.as_i64()).unwrap_or(0);
    let hemizygote_count = v.get("hemizygote_count").and_then(|x| x.as_i64()).unwrap_or(0);
    let filters: Vec<String> = v.get("filters")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let ancestry_groups: Vec<mcp::PopulationFrequency> = v.get("populations")
        .or_else(|| v.get("ancestry_groups"))
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter().filter_map(|p| {
                let id = p.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let pac = p.get("ac").and_then(|x| x.as_i64()).unwrap_or(0);
                let pan = p.get("an").and_then(|x| x.as_i64()).unwrap_or(0);
                Some(mcp::PopulationFrequency {
                    id,
                    ac: pac,
                    an: pan,
                    af: if pan > 0 { pac as f64 / pan as f64 } else { 0.0 },
                    homozygote_count: p.get("homozygote_count").and_then(|x| x.as_i64()).unwrap_or(0),
                    hemizygote_count: p.get("hemizygote_count").and_then(|x| x.as_i64()).unwrap_or(0),
                })
            }).collect()
        })
        .unwrap_or_default();

    Some(mcp::SequencingTypeData {
        ac,
        an,
        af,
        homozygote_count,
        hemizygote_count,
        ancestry_groups,
        filters,
    })
}

impl From<api::Gene> for mcp::GeneSummary {
    fn from(g: api::Gene) -> Self {
        mcp::GeneSummary {
            gene_id: g.gene_id,
            gene_symbol: g.gene_symbol.or(g.gencode_symbol).unwrap_or_default(),
            name: None,
            chrom: g.chrom,
            start: g.start,
            stop: g.stop,
            strand: g.strand,
            canonical_transcript_id: g.canonical_transcript_id,
            constraint: None, // constraint not available in api::Gene
        }
    }
}

impl From<api::Transcript> for mcp::TranscriptSummary {
    fn from(t: api::Transcript) -> Self {
        mcp::TranscriptSummary {
            transcript_id: t.transcript_id,
            transcript_version: None,
            biotype: "protein_coding".to_string(),
            is_canonical: false,
            is_mane_select: false,
            refseq_id: None,
        }
    }
}

// ---------------------------------------------------------------------------
// GenomicDataProvider implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl GenomicDataProvider for GnomadMcpProvider {
    async fn get_variant_details(
        &self,
        variant_id: &str,
        _dataset: &str,
    ) -> anyhow::Result<Option<mcp::VariantDetails>> {
        let detail = self.backend.get_variant_detail(variant_id, false).await?;
        Ok(detail.map(Into::into))
    }

    async fn get_variant_summary(
        &self,
        variant_id: &str,
        _dataset: &str,
    ) -> anyhow::Result<Option<mcp::VariantSummary>> {
        // Use the same variant detail endpoint, convert to summary
        let detail = self.backend.get_variant_detail(variant_id, false).await?;
        Ok(detail.map(|d| {
            let variant_id_str = d.variant_id.clone().unwrap_or_default();
            let (ref_allele, alt_allele) = if d.alleles.len() >= 2 {
                (d.alleles[0].clone(), d.alleles[1].clone())
            } else {
                (String::new(), String::new())
            };
            mcp::VariantSummary {
                variant_id: variant_id_str,
                chrom: d.chrom,
                pos: d.pos,
                ref_allele,
                alt_allele,
                rsids: d.rsids.unwrap_or_default(),
                consequence: d.consequence,
                hgvsc: d.hgvsc,
                hgvsp: d.hgvsp,
                gene_id: d.gene_id,
                gene_symbol: d.gene_symbol,
                transcript_id: d.transcript_id,
                lof: None,
                ac: d.ac,
                an: d.an,
                af: d.af,
            }
        }))
    }

    async fn get_variant_frequencies(
        &self,
        variant_id: &str,
        _dataset: &str,
    ) -> anyhow::Result<Option<Vec<mcp::PopulationFrequency>>> {
        let detail = self.backend.get_variant_detail(variant_id, false).await?;
        Ok(detail.and_then(|d| {
            // Extract populations from exome or genome data
            let source = d.exome.as_ref().or(d.genome.as_ref())?;
            let pops = source.get("populations")
                .or_else(|| source.get("ancestry_groups"))
                .and_then(|x| x.as_array())?;
            Some(pops.iter().filter_map(|p| {
                let id = p.get("id").and_then(|x| x.as_str())?.to_string();
                let ac = p.get("ac").and_then(|x| x.as_i64()).unwrap_or(0);
                let an = p.get("an").and_then(|x| x.as_i64()).unwrap_or(0);
                Some(mcp::PopulationFrequency {
                    id,
                    ac,
                    an,
                    af: if an > 0 { ac as f64 / an as f64 } else { 0.0 },
                    homozygote_count: p.get("homozygote_count").and_then(|x| x.as_i64()).unwrap_or(0),
                    hemizygote_count: p.get("hemizygote_count").and_then(|x| x.as_i64()).unwrap_or(0),
                })
            }).collect())
        }))
    }

    async fn get_multiple_variant_details(
        &self,
        variant_ids: &[String],
        _dataset: &str,
    ) -> anyhow::Result<Vec<mcp::VariantDetails>> {
        let mut results = Vec::with_capacity(variant_ids.len());
        for vid in variant_ids {
            if let Some(detail) = self.backend.get_variant_detail(vid, false).await? {
                results.push(detail.into());
            }
        }
        Ok(results)
    }

    async fn get_gene_summary(
        &self,
        gene_id_or_symbol: &str,
    ) -> anyhow::Result<Option<mcp::GeneSummary>> {
        let gene = if gene_id_or_symbol.starts_with("ENSG") {
            self.backend.get_gene(gene_id_or_symbol).await?
        } else {
            self.backend.get_gene_by_symbol(gene_id_or_symbol).await?
        };
        Ok(gene.map(Into::into))
    }

    async fn get_gene_variants(
        &self,
        gene_id: &str,
        _dataset: &str,
        _consequence_filter: Option<&str>,
    ) -> anyhow::Result<Vec<mcp::VariantSummary>> {
        // Look up gene to get coordinates
        let gene = if gene_id.starts_with("ENSG") {
            self.backend.get_gene(gene_id).await?
        } else {
            self.backend.get_gene_by_symbol(gene_id).await?
        };
        let gene = match gene {
            Some(g) => g,
            None => return Ok(vec![]),
        };
        let chrom = if gene.chrom.starts_with("chr") {
            gene.chrom.clone()
        } else {
            format!("chr{}", gene.chrom)
        };
        let variants = self.backend.get_variants(&chrom, gene.start, gene.stop, false).await?;
        Ok(variants.into_iter().map(Into::into).collect())
    }

    async fn get_gene_expression(
        &self,
        _gene_id: &str,
    ) -> anyhow::Result<Option<mcp::GeneExpression>> {
        // Not yet available from the Hail backend
        Ok(None)
    }

    async fn get_region_variants(
        &self,
        chrom: &str,
        start: i64,
        end: i64,
        _dataset: &str,
    ) -> anyhow::Result<Vec<mcp::VariantSummary>> {
        let chrom = if chrom.starts_with("chr") {
            chrom.to_string()
        } else {
            format!("chr{}", chrom)
        };
        let variants = self.backend.get_variants(&chrom, start, end, false).await?;
        Ok(variants.into_iter().map(Into::into).collect())
    }

    async fn list_gene_transcripts(
        &self,
        gene_id: &str,
    ) -> anyhow::Result<Vec<mcp::TranscriptSummary>> {
        let gene = if gene_id.starts_with("ENSG") {
            self.backend.get_gene(gene_id).await?
        } else {
            self.backend.get_gene_by_symbol(gene_id).await?
        };
        Ok(gene
            .and_then(|g| g.transcripts)
            .unwrap_or_default()
            .into_iter()
            .map(Into::into)
            .collect())
    }

    async fn get_transcript_details(
        &self,
        _transcript_id: &str,
    ) -> anyhow::Result<Option<mcp::TranscriptDetails>> {
        // Not yet available as a direct lookup from the Hail backend
        Ok(None)
    }
}
