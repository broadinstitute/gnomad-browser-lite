import { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import styled from 'styled-components';
import { api } from '../api/client';
import type { Gene, Variant, Exon } from '../api/types';
import { getGeneSymbol } from '../api/types';
import { VariantsTable } from '../components/VariantsTable';
import { GenomeBrowser } from '../components/GenomeBrowser';
import {
  VariantFilterControls,
  DEFAULT_VARIANT_FILTER,
  filterVariants,
  type VariantFilter,
} from '../components/VariantFilterControls';

const Container = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  padding: 1rem;
`;

const Header = styled.div`
  margin-bottom: 1rem;
`;

const GeneTitle = styled.h1`
  margin: 0;
  font-size: 1.75rem;
  display: inline;
`;

const GeneDescription = styled.span`
  color: #666;
  font-size: 1.1rem;
  font-weight: normal;
  margin-left: 0.5rem;
`;

const GeneInfo = styled.div`
  margin-bottom: 1.5rem;
  font-size: 14px;
  line-height: 1.8;
`;

const InfoRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
`;

const InfoLabel = styled.span`
  font-weight: 700;
  color: #333;
`;

const InfoValue = styled.span`
  color: #333;
`;

const InfoLink = styled.a`
  color: #185da8;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`;

const SectionTitle = styled.h2`
  font-size: 1.25rem;
  margin: 1.5rem 0 1rem 0;
  border-bottom: 2px solid #333;
  padding-bottom: 0.5rem;
`;

const LoadingMessage = styled.div`
  text-align: center;
  padding: 2rem;
  color: #666;
`;

const ErrorMessage = styled.div`
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  padding: 1rem;
  color: #c00;
`;

const Breadcrumb = styled.nav`
  margin-bottom: 1rem;
  font-size: 0.9rem;

  a {
    color: #0066cc;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }
`;

const ZoomControlsWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1rem;
  margin-bottom: 0.5rem;
  background: #f8f9fa;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  font-size: 14px;
`;

const ZoomInfo = styled.span`
  color: #333;
`;

const ZoomButton = styled.button`
  padding: 0.375rem 0.75rem;
  border: 1px solid #1976d2;
  border-radius: 4px;
  background: #1976d2;
  color: white;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    background: #1565c0;
    border-color: #1565c0;
  }
`;

// Helper to check if a position falls within any exon region
function isInExonRegion(pos: number, exons: Exon[]): boolean {
  return exons.some(exon => pos >= exon.start && pos <= exon.stop);
}

export function GenePage() {
  const { geneId } = useParams<{ geneId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [gene, setGene] = useState<Gene | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [exons, setExons] = useState<Exon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<VariantFilter>(DEFAULT_VARIANT_FILTER);
  const [showIntrons, setShowIntrons] = useState(false); // Default: hide introns

  // Parse zoom region from URL params
  const zoomRegion = useMemo(() => {
    const startParam = searchParams.get('start');
    const stopParam = searchParams.get('stop');
    if (startParam && stopParam) {
      const start = parseInt(startParam, 10);
      const stop = parseInt(stopParam, 10);
      if (!isNaN(start) && !isNaN(stop) && start < stop) {
        return { start, stop };
      }
    }
    return null;
  }, [searchParams]);

  // Determine if we're zoomed in
  const isZoomed = zoomRegion !== null;

  // Handle region change from GenomeBrowser drag selection
  const handleRegionChange = useCallback((region: { start: number; stop: number }) => {
    setSearchParams({
      start: region.start.toString(),
      stop: region.stop.toString(),
    });
  }, [setSearchParams]);

  // Handle reset zoom
  const handleResetZoom = useCallback(() => {
    setSearchParams({});
  }, [setSearchParams]);

  // Filter variants based on filter state, exon visibility, and zoom region
  const filteredVariants = useMemo(() => {
    let result = filterVariants(variants, filter);

    // Filter by zoom region if zoomed
    if (zoomRegion) {
      result = result.filter(v => {
        const pos = v.pos || v.locus?.position || 0;
        return pos >= zoomRegion.start && pos <= zoomRegion.stop;
      });
    }

    // Also filter by exon regions if introns are hidden
    if (!showIntrons && exons.length > 0) {
      result = result.filter(v => {
        const pos = v.pos || v.locus?.position || 0;
        return isInExonRegion(pos, exons);
      });
    }

    return result;
  }, [variants, filter, showIntrons, exons, zoomRegion]);

  useEffect(() => {
    if (!geneId) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await api.getGeneVariants(geneId);
        setGene(response.gene);
        setVariants(response.variants);

        // Fetch exon data from gnomAD API
        const geneSymbol = response.gene.gene_symbol || response.gene.gencode_symbol || geneId;
        const fetchedExons = await api.fetchExonsFromGnomAD(
          geneSymbol,
          response.gene.canonical_transcript_id
        );
        setExons(fetchedExons);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load gene data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [geneId]);

  if (loading) {
    return (
      <Container>
        <LoadingMessage>Loading gene data...</LoadingMessage>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <Breadcrumb>
          <Link to="/">Home</Link> / Gene
        </Breadcrumb>
        <ErrorMessage>
          <strong>Error:</strong> {error}
        </ErrorMessage>
      </Container>
    );
  }

  if (!gene) {
    return (
      <Container>
        <Breadcrumb>
          <Link to="/">Home</Link> / Gene
        </Breadcrumb>
        <ErrorMessage>Gene not found</ErrorMessage>
      </Container>
    );
  }

  const regionString = `${gene.chrom}-${gene.start}-${gene.stop}`;
  const geneSymbol = getGeneSymbol(gene);

  return (
    <Container>
      <Breadcrumb>
        <Link to="/">Home</Link> / Gene / {geneSymbol}
      </Breadcrumb>

      <Header>
        <GeneTitle>{geneSymbol}</GeneTitle>
      </Header>

      <GeneInfo>
        <InfoRow>
          <InfoLabel>Ensembl gene ID</InfoLabel>{' '}
          <InfoLink
            href={`https://ensembl.org/Homo_sapiens/Gene/Summary?g=${gene.gene_id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {gene.gene_id}
          </InfoLink>
        </InfoRow>
        {gene.canonical_transcript_id && (
          <InfoRow>
            <InfoLabel>Canonical transcript</InfoLabel>{' '}
            <InfoLink
              href={`https://ensembl.org/Homo_sapiens/Transcript/Summary?t=${gene.canonical_transcript_id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {gene.canonical_transcript_id}
            </InfoLink>
          </InfoRow>
        )}
        <InfoRow>
          <InfoLabel>Region</InfoLabel>{' '}
          <InfoValue>{gene.chrom}:{gene.start}-{gene.stop}</InfoValue>
          {gene.strand && <InfoValue> (GRCh38, {gene.strand} strand)</InfoValue>}
        </InfoRow>
        <InfoRow>
          <InfoLabel>External resources</InfoLabel>{' '}
          <InfoLink
            href={`https://ensembl.org/Homo_sapiens/Gene/Summary?g=${gene.gene_id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Ensembl
          </InfoLink>
          {', '}
          <InfoLink
            href={`https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38&position=chr${gene.chrom}:${gene.start}-${gene.stop}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            UCSC Browser
          </InfoLink>
        </InfoRow>
      </GeneInfo>

      {variants.length > 0 && (
        <>
          {isZoomed && zoomRegion && (
            <ZoomControlsWrapper>
              <ZoomInfo>
                Viewing: <strong>{gene.chrom}:{zoomRegion.start.toLocaleString()}-{zoomRegion.stop.toLocaleString()}</strong>
                {' '}({(zoomRegion.stop - zoomRegion.start).toLocaleString()} bp)
              </ZoomInfo>
              <ZoomButton onClick={handleResetZoom}>
                Reset to full gene
              </ZoomButton>
            </ZoomControlsWrapper>
          )}
          <GenomeBrowser
            gene={gene}
            variants={filteredVariants}
            exons={exons}
            showIntrons={showIntrons}
            onShowIntronsChange={setShowIntrons}
            regionUrl={`/region/${regionString}`}
            region={zoomRegion ?? undefined}
            onRegionChange={handleRegionChange}
          />
          <VariantFilterControls value={filter} onChange={setFilter} />
        </>
      )}

      <SectionTitle>
        Variants ({filteredVariants.length.toLocaleString()}
        {filteredVariants.length !== variants.length && (
          <span style={{ fontWeight: 'normal', fontSize: '0.9rem', color: '#666' }}>
            {' '}of {variants.length.toLocaleString()} total
          </span>
        )})
      </SectionTitle>

      {variants.length > 0 ? (
        <VariantsTable variants={filteredVariants} />
      ) : (
        <LoadingMessage>No variants found in this gene region.</LoadingMessage>
      )}
    </Container>
  );
}

export default GenePage;
