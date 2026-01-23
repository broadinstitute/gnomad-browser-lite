import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import styled from 'styled-components';
import { api } from '../api/client';
import type { Variant } from '../api/types';
import { VariantsTable } from '../components/VariantsTable';

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

interface Region {
  chrom: string;
  start: number;
  end: number;
}

export function RegionPage() {
  const { regionId } = useParams<{ regionId: string }>();
  const [region, setRegion] = useState<Region | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!regionId) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await api.getRegionVariants(regionId);
        setRegion(response.region);
        setVariants(response.variants);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load region data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [regionId]);

  if (loading) {
    return (
      <Container>
        <LoadingMessage>Loading region data...</LoadingMessage>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <Breadcrumb>
          <Link to="/">Home</Link> / Region
        </Breadcrumb>
        <ErrorMessage>
          <strong>Error:</strong> {error}
        </ErrorMessage>
      </Container>
    );
  }

  if (!region) {
    return (
      <Container>
        <Breadcrumb>
          <Link to="/">Home</Link> / Region
        </Breadcrumb>
        <ErrorMessage>Region not found</ErrorMessage>
      </Container>
    );
  }

  const regionDisplay = `${region.chrom}:${region.start.toLocaleString()}-${region.end.toLocaleString()}`;
  const size = region.end - region.start;

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
            <InfoValue>{region.chrom}</InfoValue>
          </InfoItem>
          <InfoItem>
            <InfoLabel>Start</InfoLabel>
            <InfoValue>{region.start.toLocaleString()}</InfoValue>
          </InfoItem>
          <InfoItem>
            <InfoLabel>End</InfoLabel>
            <InfoValue>{region.end.toLocaleString()}</InfoValue>
          </InfoItem>
          <InfoItem>
            <InfoLabel>Size</InfoLabel>
            <InfoValue>{size.toLocaleString()} bp</InfoValue>
          </InfoItem>
        </InfoGrid>
      </RegionInfo>

      <SectionTitle>Variants ({variants.length.toLocaleString()})</SectionTitle>

      {variants.length > 0 ? (
        <VariantsTable variants={variants} />
      ) : (
        <LoadingMessage>No variants found in this region.</LoadingMessage>
      )}
    </Container>
  );
}

export default RegionPage;
