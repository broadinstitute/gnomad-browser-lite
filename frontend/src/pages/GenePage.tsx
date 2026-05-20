import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import styled from 'styled-components';
import { api, streamGeneVariants, type StreamSource } from '../api/client';
import type { Gene, Variant, Exon } from '../api/types';
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

const ProgressBarFill = styled.span<{ $percent: number }>`
  display: block;
  height: 100%;
  width: ${p => p.$percent}%;
  background: #1976d2;
  border-radius: 3px;
  transition: width 0.2s ease-out;
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [gene, setGene] = useState<Gene | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [exons, setExons] = useState<Exon[]>([]);
  const [streamingStatus, setStreamingStatus] = useState<'idle' | 'loading' | 'streaming' | 'complete'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<VariantFilter>(DEFAULT_VARIANT_FILTER);
  const [showIntrons, setShowIntrons] = useState(false); // Default: hide introns
  const [selectedVariantIds, setSelectedVariantIds] = useState<Set<string>>(new Set());
  const [totalEstimate, setTotalEstimate] = useState<number | null>(null);
  const [streamSource, setStreamSource] = useState<StreamSource | null>(null);

  // Ref-based accumulation to avoid O(n²) copies
  const variantsRef = useRef<Variant[]>([]);
  const streamDoneRef = useRef(false);

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

  // Handle variant selection toggle
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

  // Clear all selections
  const handleClearSelection = useCallback(() => {
    setSelectedVariantIds(new Set());
  }, []);

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

    const isGeneChange = variantsRef.current.length === 0 && !gene;
    const abortController = new AbortController();
    variantsRef.current = [];
    streamDoneRef.current = false;
    if (isGeneChange) {
      setGene(null);
      setExons([]);
    }
    setVariants([]);
    setError(null);
    setTotalEstimate(null);
    setStreamSource(null);
    setStreamingStatus('loading');

    const mode = showIntrons ? 'full' as const : 'exons' as const;

    // 200ms interval to flush accumulated variants to React state
    const flushInterval = setInterval(() => {
      if (variantsRef.current.length > 0) {
        setVariants([...variantsRef.current]);
      }
    }, 200);

    streamGeneVariants(
      geneId,
      {
        onMetadata: (geneData, total, source) => {
          setGene(geneData);
          if (total != null) setTotalEstimate(total);
          if (source) setStreamSource(source);
          setStreamingStatus('streaming');

          // Use exons from gene data (already in the Hail table) — no external API call needed
          if (geneData.exons && geneData.exons.length > 0) {
            setExons(geneData.exons);
          } else {
            // Fallback to external gnomAD API if local exons not available
            const geneSymbol = geneData.gene_symbol || geneData.gencode_symbol || geneId;
            api.fetchExonsFromGnomAD(geneSymbol, geneData.canonical_transcript_id)
              .then(setExons)
              .catch(() => {});
          }
        },
        onVariants: (batch) => {
          variantsRef.current.push(...batch);
        },
        onComplete: () => {
          streamDoneRef.current = true;
          // Final flush
          setVariants([...variantsRef.current]);
          setStreamingStatus('complete');
          clearInterval(flushInterval);
        },
        onError: (err) => {
          streamDoneRef.current = true;
          // Flush whatever we have
          if (variantsRef.current.length > 0) {
            setVariants([...variantsRef.current]);
          }
          setError(err.message);
          setStreamingStatus('complete');
          clearInterval(flushInterval);
        },
      },
      abortController.signal,
      mode,
    );

    return () => {
      abortController.abort();
      clearInterval(flushInterval);
    };
  }, [geneId, showIntrons]);

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
        )}
        {streamingStatus === 'streaming' && totalEstimate != null && (
          <span style={{ fontWeight: 'normal', fontSize: '0.9rem', color: '#666' }}>
            {' '}/ {totalEstimate.toLocaleString()}
          </span>
        )})
        {streamingStatus === 'streaming' && (
          <StreamingBadge>
            <ProgressBarContainer>
              {totalEstimate != null ? (
                <ProgressBarFill $percent={Math.min(100, (variants.length / totalEstimate) * 100)} />
              ) : (
                <ProgressBarIndeterminate />
              )}
            </ProgressBarContainer>
            {totalEstimate != null
              ? `${Math.round((variants.length / totalEstimate) * 100)}%`
              : 'Loading...'}
            {streamSource && (
              <span style={{ color: '#999', fontSize: '0.75rem' }}>
                from {streamSource.path.split('/').pop()?.replace('.ht', '')} ({streamSource.total_partitions} partitions)
              </span>
            )}
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
