import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import styled from 'styled-components';
import { api } from '../api/client';
import type { Gene, Variant, Exon, GeneConstraint } from '../api/types';
import type { Region } from '../utils/coordinates';
import { getGeneSymbol } from '../api/types';
import { VariantsTable } from '../components/VariantsTable';
import { GenomeBrowser } from '../components/GenomeBrowser';
import { ZoomOverview } from '../components/ZoomOverview';
import {
  VariantFilterControls,
  DEFAULT_VARIANT_FILTER,
  filterVariants,
  type VariantFilter,
} from '../components/VariantFilterControls';
import { useVariantCache } from '../hooks/useVariantCache';
import { mergeIntervals } from '../utils/intervals';
import { useBranding } from '../contexts/BrandingContext';
import { ConstraintTable } from '../components/ConstraintTable';

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

const GeneInfoRow = styled.div`
  display: flex;
  gap: 2rem;
  margin-bottom: 1.5rem;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
`;

const GeneInfo = styled.div`
  font-size: 14px;
  line-height: 1.8;
  flex-shrink: 0;
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

const StreamingBadge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  font-weight: normal;
  color: #1976d2;
  margin-left: 0.75rem;
`;

const ProgressBarContainer = styled.span`
  display: inline-block;
  width: 120px;
  height: 6px;
  background: #e0e0e0;
  border-radius: 3px;
  overflow: hidden;
  vertical-align: middle;
`;

const ProgressBarIndeterminate = styled.span`
  display: block;
  height: 100%;
  width: 30%;
  background: #1976d2;
  border-radius: 3px;

  @keyframes slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }
  animation: slide 1.5s ease-in-out infinite;
`;

// Helper to check if a position falls within any exon region
function isInExonRegion(pos: number, exons: Exon[]): boolean {
  return exons.some(exon => pos >= exon.start && pos <= exon.stop);
}

export function GenePage() {
  const { geneId } = useParams<{ geneId: string }>();
  const branding = useBranding();
  const [searchParams, setSearchParams] = useSearchParams();
  const [gene, setGene] = useState<Gene | null>(null);
  const [exons, setExons] = useState<Exon[]>([]);
  const [geneLoading, setGeneLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<VariantFilter>(DEFAULT_VARIANT_FILTER);
  const [showIntrons, setShowIntrons] = useState(false);
  const [includeUTRs, setIncludeUTRs] = useState(false);
  const [includeNonCodingTranscripts, setIncludeNonCodingTranscripts] = useState(false);
  const [selectedVariantIds, setSelectedVariantIds] = useState<Set<string>>(new Set());

  const prevGeneIdRef = useRef<string | undefined>(geneId);
  const cache = useVariantCache();

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

  const isZoomed = zoomRegion !== null;

  const handleRegionChange = useCallback((region: { start: number; stop: number }) => {
    setSearchParams({
      start: region.start.toString(),
      stop: region.stop.toString(),
    });
  }, [setSearchParams]);

  const handleResetZoom = useCallback(() => {
    setSearchParams({});
  }, [setSearchParams]);

  const handleToggleVariantSelection = useCallback((variantId: string) => {
    setSelectedVariantIds(prev => {
      const next = new Set(prev);
      if (next.has(variantId)) {
        next.delete(variantId);
      } else {
        next.add(variantId);
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedVariantIds(new Set());
  }, []);

  // Fetch gene metadata when geneId changes
  useEffect(() => {
    if (!geneId) return;

    const isGeneChange = geneId !== prevGeneIdRef.current;
    prevGeneIdRef.current = geneId;

    if (isGeneChange) {
      setGene(null);
      setExons([]);
      setError(null);
      cache.reset();
    }

    setGeneLoading(true);

    api.getGene(geneId)
      .then((geneData) => {
        setGene(geneData);
        if (geneData.exons && geneData.exons.length > 0) {
          setExons(geneData.exons);
        } else {
          const geneSymbol = geneData.gene_symbol || geneData.gencode_symbol || geneId;
          api.fetchExonsFromGnomAD(geneSymbol, geneData.canonical_transcript_id)
            .then(setExons)
            .catch(() => {});
        }
      })
      .catch((err) => {
        setError(err.message);
      })
      .finally(() => {
        setGeneLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geneId]);

  // Compute desired intervals from toggles and feed to cache
  useEffect(() => {
    if (!gene || exons.length === 0) return;

    const desiredIntervals: Region[] = [];

    if (showIntrons) {
      // Full gene region
      desiredIntervals.push({ start: gene.start, stop: gene.stop });
    } else {
      // Collect active exon types
      const activeTypes = new Set<string>(['CDS']);
      if (includeUTRs) activeTypes.add('UTR');
      if (includeNonCodingTranscripts) activeTypes.add('exon');

      const shoulder = 50;
      for (const exon of exons) {
        if (activeTypes.has(exon.feature_type)) {
          desiredIntervals.push({
            start: Math.max(0, exon.start - shoulder),
            stop: exon.stop + shoulder,
          });
        }
      }
    }

    // Include zoom region if outside current coverage
    if (zoomRegion) {
      desiredIntervals.push({ start: zoomRegion.start, stop: zoomRegion.stop });
    }

    const merged = mergeIntervals(desiredIntervals);
    if (merged.length > 0) {
      cache.ensureIntervalsCovered(gene.chrom, merged);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gene, exons, showIntrons, includeUTRs, includeNonCodingTranscripts, zoomRegion]);

  // Derive display-filtered variants from cache
  const variants = cache.variants;
  const streamingStatus: 'idle' | 'loading' | 'streaming' | 'complete' =
    geneLoading ? 'loading' : cache.isLoading ? 'streaming' : variants.length > 0 ? 'complete' : 'idle';

  const filteredVariants = useMemo(() => {
    let result = filterVariants(variants, filter);

    if (zoomRegion) {
      result = result.filter(v => {
        const pos = v.pos || v.locus?.position || 0;
        return pos >= zoomRegion.start && pos <= zoomRegion.stop;
      });
    }

    // Filter by exon regions if introns are hidden (display filter only)
    if (!showIntrons && exons.length > 0) {
      result = result.filter(v => {
        const pos = v.pos || v.locus?.position || 0;
        return isInExonRegion(pos, exons);
      });
    }

    return result;
  }, [variants, filter, showIntrons, exons, zoomRegion]);

  if (streamingStatus === 'loading' || (streamingStatus === 'idle' && !gene)) {
    return (
      <Container>
        <LoadingMessage>Loading gene data...</LoadingMessage>
      </Container>
    );
  }

  if (error && !gene) {
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

      <GeneInfoRow>
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
            {branding.external_links?.map((link) => (
              <span key={link.url}>
                {', '}
                <InfoLink
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {link.label}
                </InfoLink>
              </span>
            ))}
          </InfoRow>
        </GeneInfo>

        {gene.constraint && (
          <ConstraintTable constraint={gene.constraint} />
        )}
      </GeneInfoRow>

      {(variants.length > 0 || streamingStatus === 'streaming') && (
        <>
          {isZoomed && zoomRegion && (
            <ZoomOverview
              gene={gene}
              exons={exons}
              zoomRegion={zoomRegion}
              onRegionChange={handleRegionChange}
              onReset={handleResetZoom}
            />
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
            isStreaming={streamingStatus === 'streaming'}
            includeUTRs={includeUTRs}
            onIncludeUTRsChange={setIncludeUTRs}
            includeNonCodingTranscripts={includeNonCodingTranscripts}
            onIncludeNonCodingTranscriptsChange={setIncludeNonCodingTranscripts}
            selectedVariantIds={selectedVariantIds}
            onToggleVariantSelection={handleToggleVariantSelection}
          />
          <VariantFilterControls value={filter} onChange={setFilter} />
        </>
      )}

      <SectionTitle>
        Variants ({filteredVariants.length.toLocaleString()}
        {filteredVariants.length !== variants.length && (
          <span style={{ fontWeight: 'normal', fontSize: '0.9rem', color: '#666' }}>
            {' '}of {variants.length.toLocaleString()}
          </span>
        )})
        {streamingStatus === 'streaming' && (
          <StreamingBadge>
            <ProgressBarContainer>
              <ProgressBarIndeterminate />
            </ProgressBarContainer>
            Loading...
          </StreamingBadge>
        )}
      </SectionTitle>

      {variants.length > 0 ? (
        <VariantsTable
          variants={filteredVariants}
          selectedVariantIds={selectedVariantIds}
          onToggleSelection={handleToggleVariantSelection}
          onClearSelection={handleClearSelection}
        />
      ) : streamingStatus === 'streaming' ? (
        <LoadingMessage>Waiting for variants...</LoadingMessage>
      ) : (
        <LoadingMessage>No variants found in this gene region.</LoadingMessage>
      )}
    </Container>
  );
}

export default GenePage;
