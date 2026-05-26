import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import styled from 'styled-components';
import type { Gene, Variant } from '../api/types';
import { VariantsTable } from '../components/VariantsTable';
import { GenomeBrowser } from '../components/GenomeBrowser';
import {
  VariantFilterControls,
  DEFAULT_VARIANT_FILTER,
  filterVariants,
  type VariantFilter,
} from '../components/VariantFilterControls';
import { useVariantCache } from '../hooks/useVariantCache';

const Container = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  padding: 1rem;
`;

const Header = styled.div`
  margin-bottom: 1.5rem;
`;

const RegionTitle = styled.h1`
  margin: 0 0 0.5rem 0;
  font-size: 1.75rem;
`;

const RegionInfo = styled.div`
  background: #f9f9f9;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  padding: 1rem;
  margin-bottom: 1.5rem;
`;

const InfoGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
`;

const InfoItem = styled.div`
  display: flex;
  flex-direction: column;
`;

const InfoLabel = styled.span`
  font-size: 0.8rem;
  color: #666;
  text-transform: uppercase;
  margin-bottom: 0.25rem;
`;

const InfoValue = styled.span`
  font-size: 1rem;
  font-weight: 500;
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

interface ParsedRegion {
  chrom: string;
  start: number;
  stop: number;
}

function parseRegionId(regionId: string): ParsedRegion | null {
  const match = regionId.match(/^(?:chr)?([a-zA-Z0-9]+)[:\-](\d+)-(\d+)$/);
  if (!match) return null;
  const chrom = match[1];
  const start = parseInt(match[2], 10);
  const stop = parseInt(match[3], 10);
  if (isNaN(start) || isNaN(stop) || start >= stop) return null;
  return { chrom, start, stop };
}

export function RegionPage() {
  const { regionId } = useParams<{ regionId: string }>();
  const [filter, setFilter] = useState<VariantFilter>(DEFAULT_VARIANT_FILTER);
  const [selectedVariantIds, setSelectedVariantIds] = useState<Set<string>>(new Set());
  const prevRegionIdRef = useRef<string | undefined>(regionId);
  const cache = useVariantCache();

  const parsedRegion = useMemo(() => {
    if (!regionId) return null;
    return parseRegionId(regionId);
  }, [regionId]);

  // Reset cache when region changes
  useEffect(() => {
    if (regionId !== prevRegionIdRef.current) {
      cache.reset();
      prevRegionIdRef.current = regionId;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  // Trigger streaming fetch
  useEffect(() => {
    if (!parsedRegion) return;
    cache.ensureIntervalsCovered(parsedRegion.chrom, [
      { start: parsedRegion.start, stop: parsedRegion.stop },
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedRegion?.chrom, parsedRegion?.start, parsedRegion?.stop]);

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

  const variants = cache.variants;
  const streamingStatus: 'idle' | 'loading' | 'streaming' | 'complete' =
    cache.isLoading ? 'streaming' : variants.length > 0 ? 'complete' : 'idle';

  const filteredVariants = useMemo(
    () => filterVariants(variants, filter),
    [variants, filter],
  );

  // Synthesize a mock Gene for the GenomeBrowser
  const mockGene: Gene | null = useMemo(() => {
    if (!parsedRegion) return null;
    return {
      gene_id: regionId || '',
      gene_symbol: `${parsedRegion.chrom}:${parsedRegion.start.toLocaleString()}-${parsedRegion.stop.toLocaleString()}`,
      chrom: parsedRegion.chrom,
      start: parsedRegion.start,
      stop: parsedRegion.stop,
    };
  }, [parsedRegion, regionId]);

  if (!regionId || !parsedRegion) {
    return (
      <Container>
        <Breadcrumb>
          <Link to="/">Home</Link> / Region
        </Breadcrumb>
        <ErrorMessage>
          Invalid region format. Expected: chr1-12345-67890, 1-12345-67890, or chr1:12345-67890
        </ErrorMessage>
      </Container>
    );
  }

  const regionDisplay = `${parsedRegion.chrom}:${parsedRegion.start.toLocaleString()}-${parsedRegion.stop.toLocaleString()}`;
  const size = parsedRegion.stop - parsedRegion.start;

  return (
    <Container>
      <Breadcrumb>
        <Link to="/">Home</Link> / Region / {regionDisplay}
      </Breadcrumb>

      <Header>
        <RegionTitle>Region: {regionDisplay}</RegionTitle>
      </Header>

      <RegionInfo>
        <InfoGrid>
          <InfoItem>
            <InfoLabel>Chromosome</InfoLabel>
            <InfoValue>{parsedRegion.chrom}</InfoValue>
          </InfoItem>
          <InfoItem>
            <InfoLabel>Start</InfoLabel>
            <InfoValue>{parsedRegion.start.toLocaleString()}</InfoValue>
          </InfoItem>
          <InfoItem>
            <InfoLabel>End</InfoLabel>
            <InfoValue>{parsedRegion.stop.toLocaleString()}</InfoValue>
          </InfoItem>
          <InfoItem>
            <InfoLabel>Size</InfoLabel>
            <InfoValue>{size.toLocaleString()} bp</InfoValue>
          </InfoItem>
        </InfoGrid>
      </RegionInfo>

      {mockGene && (variants.length > 0 || streamingStatus === 'streaming') && (
        <>
          <GenomeBrowser
            gene={mockGene}
            variants={filteredVariants}
            exons={[]}
            showIntrons={true}
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
        <LoadingMessage>No variants found in this region.</LoadingMessage>
      )}
    </Container>
  );
}

export default RegionPage;
