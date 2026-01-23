import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import styled from 'styled-components';
import { api } from '../api/client';
import type { Gene, Variant } from '../api/types';
import { getGeneSymbol } from '../api/types';
import { VariantsTable } from '../components/VariantsTable';
import { GenomeBrowser } from '../components/GenomeBrowser';

const Container = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  padding: 1rem;
`;

const Header = styled.div`
  margin-bottom: 1.5rem;
`;

const GeneTitle = styled.h1`
  margin: 0 0 0.5rem 0;
  font-size: 1.75rem;
`;

const GeneSubtitle = styled.div`
  color: #666;
  font-size: 0.9rem;
`;

const GeneInfo = styled.div`
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

export function GenePage() {
  const { geneId } = useParams<{ geneId: string }>();
  const [gene, setGene] = useState<Gene | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!geneId) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await api.getGeneVariants(geneId);
        setGene(response.gene);
        setVariants(response.variants);
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
        <GeneSubtitle>{gene.gene_id}</GeneSubtitle>
      </Header>

      <GeneInfo>
        <InfoGrid>
          <InfoItem>
            <InfoLabel>Chromosome</InfoLabel>
            <InfoValue>{gene.chrom}</InfoValue>
          </InfoItem>
          <InfoItem>
            <InfoLabel>Start</InfoLabel>
            <InfoValue>{gene.start?.toLocaleString()}</InfoValue>
          </InfoItem>
          <InfoItem>
            <InfoLabel>Stop</InfoLabel>
            <InfoValue>{gene.stop?.toLocaleString()}</InfoValue>
          </InfoItem>
          <InfoItem>
            <InfoLabel>Size</InfoLabel>
            <InfoValue>
              {gene.start && gene.stop
                ? `${(gene.stop - gene.start).toLocaleString()} bp`
                : '-'}
            </InfoValue>
          </InfoItem>
          {gene.strand && (
            <InfoItem>
              <InfoLabel>Strand</InfoLabel>
              <InfoValue>{gene.strand}</InfoValue>
            </InfoItem>
          )}
          {gene.canonical_transcript_id && (
            <InfoItem>
              <InfoLabel>Canonical Transcript</InfoLabel>
              <InfoValue>{gene.canonical_transcript_id}</InfoValue>
            </InfoItem>
          )}
        </InfoGrid>
      </GeneInfo>

      <div>
        <Link to={`/region/${regionString}`}>View region: {regionString}</Link>
      </div>

      {variants.length > 0 && (
        <GenomeBrowser
          gene={gene}
          variants={variants}
        />
      )}

      <SectionTitle>Variants ({variants.length.toLocaleString()})</SectionTitle>

      {variants.length > 0 ? (
        <VariantsTable variants={variants} />
      ) : (
        <LoadingMessage>No variants found in this gene region.</LoadingMessage>
      )}
    </Container>
  );
}

export default GenePage;
