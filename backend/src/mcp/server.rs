use std::sync::Arc;

use rmcp::{
    ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::Deserialize;

#[allow(unused_imports)]
use genohype_mcp::GenomicDataProvider;
use genohype_mcp::tools::{gene::*, region::*, variant::*};

use crate::mcp::provider::GnomadMcpProvider;

/// Combined MCP server for gnomAD Browser Lite.
///
/// Contains all generic genomic tools (variant, gene, region) as thin wrappers
/// over the [`GenomicDataProvider`], plus domain-specific stubs for clinical
/// interpretation tools.
#[derive(Clone)]
pub struct GnomadMcpServer {
    provider: Arc<GnomadMcpProvider>,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

impl GnomadMcpServer {
    pub fn new(provider: Arc<GnomadMcpProvider>) -> Self {
        Self {
            provider,
            tool_router: Self::tool_router(),
        }
    }
}

impl std::fmt::Debug for GnomadMcpServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GnomadMcpServer").finish()
    }
}

// ---------------------------------------------------------------------------
// Domain-specific parameter types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, JsonSchema)]
pub struct InterpretPathogenicityParams {
    /// Variant ID (e.g., '1-55051215-G-GA').
    pub variant_id: String,
    /// The gnomAD dataset to query (e.g., 'gnomad_r4'). Defaults to 'gnomad_r4'.
    pub dataset: Option<String>,
    /// Disease prevalence (e.g., 0.002 for 1/500). Optional.
    pub disease_prevalence: Option<f64>,
    /// Inheritance pattern: 'dominant' or 'recessive'. Required if disease_prevalence is provided.
    pub inheritance: Option<String>,
    /// Disease penetrance (0-1). Default is 1.0.
    pub penetrance: Option<f64>,
    /// Proportion of disease caused by this gene (0-1). Default is 1.0.
    pub genetic_heterogeneity: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AnalyzeCooccurrenceParams {
    /// Variant ID (e.g., '1-55051215-G-GA').
    pub variant_id: String,
    /// The gnomAD dataset to query.
    pub dataset: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AnalyzePextParams {
    /// Variant ID (e.g., '1-55051215-G-GA').
    pub variant_id: String,
    /// The gnomAD dataset to query.
    pub dataset: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetMendelianGeneSummaryParams {
    /// Gene symbol (e.g., 'BRCA1') or Ensembl gene ID.
    pub gene: String,
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

#[tool_router]
impl GnomadMcpServer {
    // -- Generic variant tools (thin wrappers) --

    #[tool(description = "Get detailed information about a specific genetic variant including allele frequencies across populations, transcript consequences, in silico predictor scores, and quality flags. Use variant IDs in the format 'chrom-pos-ref-alt' (e.g., '1-55039447-G-A').")]
    async fn get_variant_details(
        &self,
        Parameters(params): Parameters<GetVariantDetailsParams>,
    ) -> String {
        let dataset = params.dataset.as_deref().unwrap_or("gnomad_r4");
        match self.provider.get_variant_details(&params.variant_id, dataset).await {
            Ok(Some(details)) => serde_json::to_string_pretty(&details).unwrap_or_default(),
            Ok(None) => format!("Variant {} not found", params.variant_id),
            Err(e) => format!("Error: {e}"),
        }
    }

    #[tool(description = "Get a concise summary of a variant including its consequence, gene, and allele frequency. Lighter than get_variant_details.")]
    async fn get_variant_summary(
        &self,
        Parameters(params): Parameters<GetVariantSummaryParams>,
    ) -> String {
        let dataset = params.dataset.as_deref().unwrap_or("gnomad_r4");
        match self.provider.get_variant_summary(&params.variant_id, dataset).await {
            Ok(Some(summary)) => serde_json::to_string_pretty(&summary).unwrap_or_default(),
            Ok(None) => format!("Variant {} not found", params.variant_id),
            Err(e) => format!("Error: {e}"),
        }
    }

    #[tool(description = "Get allele frequencies for a variant across all ancestry populations. Returns per-population allele count, allele number, frequency, and homozygote/hemizygote counts.")]
    async fn get_variant_frequencies(
        &self,
        Parameters(params): Parameters<GetVariantFrequenciesParams>,
    ) -> String {
        let dataset = params.dataset.as_deref().unwrap_or("gnomad_r4");
        match self.provider.get_variant_frequencies(&params.variant_id, dataset).await {
            Ok(Some(freqs)) => serde_json::to_string_pretty(&freqs).unwrap_or_default(),
            Ok(None) => format!("Variant {} not found", params.variant_id),
            Err(e) => format!("Error: {e}"),
        }
    }

    #[tool(description = "Get detailed information for multiple variants in a single request. More efficient than calling get_variant_details repeatedly.")]
    async fn get_multiple_variant_details(
        &self,
        Parameters(params): Parameters<GetMultipleVariantDetailsParams>,
    ) -> String {
        let dataset = params.dataset.as_deref().unwrap_or("gnomad_r4");
        match self.provider.get_multiple_variant_details(&params.variant_ids, dataset).await {
            Ok(details) => serde_json::to_string_pretty(&details).unwrap_or_default(),
            Err(e) => format!("Error: {e}"),
        }
    }

    // -- Generic gene tools --

    #[tool(description = "Get summary information for a gene including its genomic coordinates, canonical transcript, and constraint metrics (pLI, LOEUF, missense Z). Accepts Ensembl gene IDs (ENSG...) or gene symbols (e.g., BRCA1).")]
    async fn get_gene_summary(
        &self,
        Parameters(params): Parameters<GetGeneSummaryParams>,
    ) -> String {
        match self.provider.get_gene_summary(&params.gene).await {
            Ok(Some(summary)) => serde_json::to_string_pretty(&summary).unwrap_or_default(),
            Ok(None) => format!("Gene {} not found", params.gene),
            Err(e) => format!("Error: {e}"),
        }
    }

    #[tool(description = "Get variants found within a gene. Optionally filter by consequence type (e.g., 'missense_variant', 'stop_gained', 'pLoF'). Returns variant summaries with consequence, frequency, and gene annotation.")]
    async fn get_gene_variants(
        &self,
        Parameters(params): Parameters<GetGeneVariantsParams>,
    ) -> String {
        let dataset = params.dataset.as_deref().unwrap_or("gnomad_r4");
        match self.provider.get_gene_variants(&params.gene_id, dataset, params.consequence.as_deref()).await {
            Ok(variants) => serde_json::to_string_pretty(&variants).unwrap_or_default(),
            Err(e) => format!("Error: {e}"),
        }
    }

    #[tool(description = "Get tissue-level gene expression data (TPM values from GTEx). Useful for understanding where a gene is expressed and interpreting the clinical relevance of variants.")]
    async fn get_gene_expression_summary(
        &self,
        Parameters(params): Parameters<GetGeneExpressionParams>,
    ) -> String {
        match self.provider.get_gene_expression(&params.gene_id).await {
            Ok(Some(expr)) => serde_json::to_string_pretty(&expr).unwrap_or_default(),
            Ok(None) => format!("Expression data not found for {}", params.gene_id),
            Err(e) => format!("Error: {e}"),
        }
    }

    #[tool(description = "List all transcripts for a gene with their biotype, canonical status, MANE Select status, and RefSeq ID.")]
    async fn list_gene_transcripts(
        &self,
        Parameters(params): Parameters<ListGeneTranscriptsParams>,
    ) -> String {
        match self.provider.list_gene_transcripts(&params.gene_id).await {
            Ok(transcripts) => serde_json::to_string_pretty(&transcripts).unwrap_or_default(),
            Err(e) => format!("Error: {e}"),
        }
    }

    #[tool(description = "Get full details for a specific transcript including exon coordinates, biotype, and identifiers.")]
    async fn get_transcript_details(
        &self,
        Parameters(params): Parameters<GetTranscriptDetailsParams>,
    ) -> String {
        match self.provider.get_transcript_details(&params.transcript_id).await {
            Ok(Some(details)) => serde_json::to_string_pretty(&details).unwrap_or_default(),
            Ok(None) => format!("Transcript {} not found", params.transcript_id),
            Err(e) => format!("Error: {e}"),
        }
    }

    // -- Generic region tools --

    #[tool(description = "Get variants in a genomic region defined by chromosome and start/end coordinates. Returns variant summaries with consequence, frequency, and gene annotation. Coordinates are 1-based, inclusive.")]
    async fn get_region_variants(
        &self,
        Parameters(params): Parameters<GetRegionVariantsParams>,
    ) -> String {
        let dataset = params.dataset.as_deref().unwrap_or("gnomad_r4");
        match self.provider.get_region_variants(&params.chrom, params.start, params.end, dataset).await {
            Ok(variants) => serde_json::to_string_pretty(&variants).unwrap_or_default(),
            Err(e) => format!("Error: {e}"),
        }
    }

    // -- Domain-specific tools (stubs) --

    #[tool(description = "Provides a preliminary interpretation of a variant's potential pathogenicity by synthesizing allele frequency, gene constraint, and predicted consequence. Can optionally calculate disease-specific maximum credible allele frequency.")]
    async fn interpret_variant_pathogenicity(
        &self,
        Parameters(params): Parameters<InterpretPathogenicityParams>,
    ) -> String {
        let dataset = params.dataset.as_deref().unwrap_or("gnomad_r4");
        let details = match self.provider.get_variant_details(&params.variant_id, dataset).await {
            Ok(Some(d)) => d,
            Ok(None) => return format!("Variant {} not found", params.variant_id),
            Err(e) => return format!("Error: {e}"),
        };

        // Stub: return basic info. Full clinical interpretation will be implemented in Phase B.
        format!(
            "Pathogenicity interpretation for {}:\n\
             - Allele frequency: {}\n\
             - Consequence: {}\n\
             \n(Full clinical interpretation not yet implemented)",
            params.variant_id,
            details.af.map(|f| format!("{:.6}", f)).unwrap_or("N/A".into()),
            details.transcript_consequences.first()
                .map(|tc| tc.major_consequence.as_str())
                .unwrap_or("unknown"),
        )
    }

    #[tool(description = "Analyzes variant co-occurrence data to predict phase (cis vs trans) using the Guo et al. 2024 method.")]
    async fn analyze_variant_cooccurrence(
        &self,
        Parameters(params): Parameters<AnalyzeCooccurrenceParams>,
    ) -> String {
        format!(
            "Co-occurrence analysis for {} is not yet implemented. \
             This tool will provide phase predictions using Guo et al. 2024 methodology.",
            params.variant_id
        )
    }

    #[tool(description = "Analyzes a variant's regional expression using pext (proportion expressed across transcripts) data to determine if the variant falls in a region with low or high expression.")]
    async fn analyze_variant_pext(
        &self,
        Parameters(params): Parameters<AnalyzePextParams>,
    ) -> String {
        format!(
            "Pext analysis for {} is not yet implemented. \
             This tool will analyze regional transcript expression levels.",
            params.variant_id
        )
    }

    #[tool(description = "Returns Mendelian disease associations for a gene from curated gene-disease databases.")]
    async fn get_mendelian_gene_summary(
        &self,
        Parameters(params): Parameters<GetMendelianGeneSummaryParams>,
    ) -> String {
        format!(
            "Mendelian gene summary for {} is not yet implemented. \
             This tool will return gene-disease associations from curated databases.",
            params.gene
        )
    }

    #[tool(description = "Provides information about this gnomAD MCP agent, including version, capabilities, and available tools.")]
    async fn get_agent_info(&self) -> String {
        serde_json::to_string_pretty(&serde_json::json!({
            "name": "gnomAD Browser Lite MCP Server",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "MCP server for querying gnomAD genomic data via Hail tables",
            "capabilities": [
                "variant_lookup",
                "gene_lookup",
                "region_query",
                "population_frequencies",
                "transcript_details",
            ],
            "data_source": "gnomAD v4.1.1 (GRCh38)",
        })).unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// ServerHandler implementation
// ---------------------------------------------------------------------------

#[tool_handler]
impl ServerHandler for GnomadMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(
                "gnomAD Browser Lite MCP server providing tools for querying \
                 variants, genes, and genomic regions from gnomAD population \
                 databases. Supports variant pathogenicity interpretation, \
                 co-occurrence analysis, and gene expression data."
            )
    }
}
