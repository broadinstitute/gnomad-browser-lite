import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { api } from '../api/client';
import type { SearchResult } from '../api/types';

const Container = styled.div`
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
`;

const Title = styled.h1`
  text-align: center;
  margin-bottom: 0.5rem;
  font-size: 2rem;
`;

const Subtitle = styled.p`
  text-align: center;
  color: #666;
  margin-bottom: 2rem;
`;

const SearchContainer = styled.div`
  position: relative;
  margin-bottom: 2rem;
`;

const SearchInput = styled.input`
  width: 100%;
  padding: 1rem;
  font-size: 1.1rem;
  border: 2px solid #ddd;
  border-radius: 8px;
  outline: none;

  &:focus {
    border-color: #0066cc;
  }
`;

const SearchResults = styled.div`
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: white;
  border: 1px solid #ddd;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  max-height: 400px;
  overflow-y: auto;
`;

const SearchResultItem = styled(Link)`
  display: block;
  padding: 0.75rem 1rem;
  text-decoration: none;
  color: inherit;
  border-bottom: 1px solid #eee;

  &:last-child {
    border-bottom: none;
  }

  &:hover {
    background: #f5f5f5;
  }
`;

const GeneSymbol = styled.span`
  font-weight: 600;
  color: #0066cc;
`;

const GeneId = styled.span`
  color: #666;
  font-size: 0.9rem;
  margin-left: 0.5rem;
`;

const GeneLocation = styled.div`
  font-size: 0.8rem;
  color: #999;
  margin-top: 0.25rem;
`;

const QuickLinks = styled.div`
  margin-top: 2rem;
`;

const QuickLinksTitle = styled.h2`
  font-size: 1.1rem;
  margin-bottom: 1rem;
  color: #666;
`;

const LinkGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
`;

const QuickLink = styled(Link)`
  display: block;
  padding: 1rem;
  background: #f9f9f9;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  text-decoration: none;
  color: inherit;

  &:hover {
    background: #f0f0f0;
    border-color: #ccc;
  }
`;

const QuickLinkTitle = styled.div`
  font-weight: 600;
  color: #0066cc;
`;

const QuickLinkDesc = styled.div`
  font-size: 0.8rem;
  color: #666;
  margin-top: 0.25rem;
`;

const StatusMessage = styled.div<{ $isError?: boolean }>`
  text-align: center;
  padding: 1rem;
  margin-top: 1rem;
  background: ${(props) => (props.$isError ? '#fee' : '#efe')};
  border: 1px solid ${(props) => (props.$isError ? '#fcc' : '#cec')};
  border-radius: 4px;
  color: ${(props) => (props.$isError ? '#c00' : '#060')};
`;

export function HomePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [apiStatus, setApiStatus] = useState<'checking' | 'ok' | 'error'>('checking');

  // Check API health on mount
  useEffect(() => {
    api
      .health()
      .then(() => setApiStatus('ok'))
      .catch(() => setApiStatus('error'));
  }, []);

  // Debounced search
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const response = await api.searchGenes(query);
        setResults(response.results);
        setShowResults(true);
      } catch {
        setResults([]);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && query) {
      // Navigate to the first result or search by gene symbol
      if (results.length > 0) {
        navigate(`/gene/${results[0].gene_symbol}`);
      } else {
        navigate(`/gene/${query}`);
      }
      setShowResults(false);
    }
  };

  const handleBlur = useCallback(() => {
    // Delay hiding results to allow click to register
    setTimeout(() => setShowResults(false), 200);
  }, []);

  return (
    <Container>
      <Title>gnomAD Browser Lite</Title>
      <Subtitle>A lightweight variant browser powered by DuckDB</Subtitle>

      <SearchContainer>
        <SearchInput
          type="text"
          placeholder="Search for a gene (e.g., PCSK9, BRCA1)..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setShowResults(true)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
        />

        {showResults && results.length > 0 && (
          <SearchResults>
            {results.map((r) => (
              <SearchResultItem key={r.gene_id} to={`/gene/${r.gene_symbol}`}>
                <div>
                  <GeneSymbol>{r.gene_symbol}</GeneSymbol>
                  <GeneId>{r.gene_id}</GeneId>
                </div>
                {r.chrom && r.start && r.stop && (
                  <GeneLocation>
                    {r.chrom}:{r.start.toLocaleString()}-{r.stop.toLocaleString()}
                  </GeneLocation>
                )}
              </SearchResultItem>
            ))}
          </SearchResults>
        )}
      </SearchContainer>

      {apiStatus === 'checking' && (
        <StatusMessage>Checking API connection...</StatusMessage>
      )}

      {apiStatus === 'error' && (
        <StatusMessage $isError>
          API not available. Make sure the backend is running on port 3000.
        </StatusMessage>
      )}

      {apiStatus === 'ok' && (
        <QuickLinks>
          <QuickLinksTitle>Example Genes</QuickLinksTitle>
          <LinkGrid>
            <QuickLink to="/gene/PCSK9">
              <QuickLinkTitle>PCSK9</QuickLinkTitle>
              <QuickLinkDesc>Cholesterol metabolism gene</QuickLinkDesc>
            </QuickLink>
            <QuickLink to="/gene/BRCA1">
              <QuickLinkTitle>BRCA1</QuickLinkTitle>
              <QuickLinkDesc>DNA repair gene</QuickLinkDesc>
            </QuickLink>
            <QuickLink to="/region/chr1-55039000-55065000">
              <QuickLinkTitle>chr1:55039000-55065000</QuickLinkTitle>
              <QuickLinkDesc>PCSK9 region</QuickLinkDesc>
            </QuickLink>
            <QuickLink to="/region/chr17-43044000-43126000">
              <QuickLinkTitle>chr17:43044000-43126000</QuickLinkTitle>
              <QuickLinkDesc>BRCA1 region</QuickLinkDesc>
            </QuickLink>
          </LinkGrid>
        </QuickLinks>
      )}
    </Container>
  );
}

export default HomePage;
