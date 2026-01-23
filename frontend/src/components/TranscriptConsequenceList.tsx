import { Link } from 'react-router-dom';
import styled from 'styled-components';
import type { TranscriptConsequence } from '../api/types';

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
`;

const Th = styled.th`
  text-align: left;
  padding: 8px 12px;
  border-bottom: 2px solid #333;
  font-weight: 600;
  background: #f8f8f8;
`;

const Td = styled.td`
  padding: 8px 12px;
  border-bottom: 1px solid #eee;
  vertical-align: top;
`;

const GeneLink = styled(Link)`
  color: #185da8;
  text-decoration: none;
  font-weight: 500;

  &:hover {
    text-decoration: underline;
  }
`;

const ExternalLink = styled.a`
  color: #185da8;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`;

const Badge = styled.span<{ $color?: string; $bg?: string }>`
  display: inline-block;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 500;
  margin-left: 6px;
  background: ${props => props.$bg || '#e0e0e0'};
  color: ${props => props.$color || '#333'};
`;

const ConsequenceBadge = styled(Badge)<{ $category: string }>`
  margin-left: 0;
  margin-right: 6px;
  background: ${props => {
    switch (props.$category) {
      case 'lof': return '#ffebee';
      case 'missense': return '#fff3e0';
      case 'synonymous': return '#e8f5e9';
      default: return '#f5f5f5';
    }
  }};
  color: ${props => {
    switch (props.$category) {
      case 'lof': return '#c62828';
      case 'missense': return '#e65100';
      case 'synonymous': return '#2e7d32';
      default: return '#616161';
    }
  }};
`;

const HgvsText = styled.span`
  font-family: monospace;
  font-size: 13px;
  word-break: break-all;
`;

const LofBadge = styled(Badge)`
  background: #ffebee;
  color: #c62828;
`;

const NoData = styled.div`
  padding: 1rem;
  color: #666;
  text-align: center;
`;

// Consequence colors and categories
function getConsequenceCategory(consequence: string): string {
  const lower = consequence.toLowerCase();
  if (
    lower.includes('frameshift') ||
    lower.includes('stop_gained') ||
    lower.includes('splice_acceptor') ||
    lower.includes('splice_donor') ||
    lower.includes('start_lost') ||
    lower.includes('stop_lost')
  ) {
    return 'lof';
  }
  if (lower.includes('missense') || lower.includes('inframe')) {
    return 'missense';
  }
  if (lower.includes('synonymous')) {
    return 'synonymous';
  }
  return 'other';
}

function formatConsequence(consequence: string): string {
  return consequence
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

interface TranscriptConsequenceListProps {
  consequences: TranscriptConsequence[];
}

export function TranscriptConsequenceList({ consequences }: TranscriptConsequenceListProps) {
  if (!consequences || consequences.length === 0) {
    return <NoData>No transcript consequences available</NoData>;
  }

  // Sort: MANE Select first, then canonical, then by gene symbol
  const sortedConsequences = [...consequences].sort((a, b) => {
    if (a.is_mane_select && !b.is_mane_select) return -1;
    if (!a.is_mane_select && b.is_mane_select) return 1;
    if (a.is_canonical && !b.is_canonical) return -1;
    if (!a.is_canonical && b.is_canonical) return 1;
    return (a.gene_symbol || '').localeCompare(b.gene_symbol || '');
  });

  return (
    <Table>
      <thead>
        <tr>
          <Th>Gene</Th>
          <Th>Transcript</Th>
          <Th>Consequence</Th>
          <Th>HGVS</Th>
          <Th>LoF</Th>
        </tr>
      </thead>
      <tbody>
        {sortedConsequences.map((tc, idx) => {
          const category = getConsequenceCategory(tc.major_consequence || '');
          const transcriptWithVersion = tc.transcript_version
            ? `${tc.transcript_id}.${tc.transcript_version}`
            : tc.transcript_id;

          return (
            <tr key={`${tc.transcript_id}-${idx}`}>
              <Td>
                {tc.gene_id ? (
                  <GeneLink to={`/gene/${tc.gene_id}`}>
                    {tc.gene_symbol || tc.gene_id}
                  </GeneLink>
                ) : (
                  tc.gene_symbol || ''
                )}
              </Td>
              <Td>
                <ExternalLink
                  href={`https://ensembl.org/Homo_sapiens/Transcript/Summary?t=${tc.transcript_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {transcriptWithVersion}
                </ExternalLink>
                {tc.is_mane_select && (
                  <Badge $bg="#e3f2fd" $color="#1565c0">MANE Select</Badge>
                )}
                {tc.is_canonical && !tc.is_mane_select && (
                  <Badge $bg="#f3e5f5" $color="#7b1fa2">Canonical</Badge>
                )}
              </Td>
              <Td>
                <ConsequenceBadge $category={category}>
                  {formatConsequence(tc.major_consequence || '')}
                </ConsequenceBadge>
              </Td>
              <Td>
                {tc.hgvsc && <HgvsText title={tc.hgvsc}>{tc.hgvsc}</HgvsText>}
                {tc.hgvsc && tc.hgvsp && <br />}
                {tc.hgvsp && <HgvsText title={tc.hgvsp}>{tc.hgvsp}</HgvsText>}
              </Td>
              <Td>
                {tc.lof && (
                  <LofBadge title={tc.lof_filter || ''}>
                    {tc.lof}
                    {tc.lof_flags && ` (${tc.lof_flags})`}
                  </LofBadge>
                )}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export default TranscriptConsequenceList;
