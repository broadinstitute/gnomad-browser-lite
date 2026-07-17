import { useState } from 'react';
import styled from 'styled-components';
import type { QCCheckResult } from '../../api/types';
import type { CatalogCheck } from '../../qc/checkCatalog';
import { StatusBadge } from './StatusBadge';

const Card = styled.div<{ $pending: boolean; $accent: string }>`
  border: 1px solid ${(p) => (p.$pending ? '#e6e6e6' : '#e0e0e0')};
  border-left: 4px solid ${(p) => p.$accent};
  border-radius: 8px;
  padding: 1rem 1.25rem;
  background: ${(p) => (p.$pending ? '#fafafa' : '#fff')};
  opacity: ${(p) => (p.$pending ? 0.85 : 1)};
`;

const CardHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
`;

const NameRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  flex-wrap: wrap;
`;

const Name = styled.span`
  font-weight: 600;
  font-size: 1rem;
`;

const CheckId = styled.code`
  font-size: 12px;
  color: #999;
`;

const Message = styled.p`
  margin: 0.6rem 0 0;
  font-size: 14px;
  color: #444;
  line-height: 1.5;
`;

const Description = styled.p`
  margin: 0.6rem 0 0;
  font-size: 14px;
  color: #777;
  line-height: 1.5;
`;

const MetaRow = styled.div`
  margin-top: 0.6rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
  font-size: 13px;
  color: #555;
`;

const MetaItem = styled.span`
  min-width: 0;
  overflow-wrap: anywhere;
  strong {
    color: #333;
    font-weight: 600;
  }
`;

const Pill = styled.span`
  display: inline-block;
  background: #eef1f5;
  color: #556;
  border-radius: 4px;
  padding: 1px 7px;
  font-size: 12px;
  margin-left: 0.4rem;
`;

const ExpandButton = styled.button`
  margin-top: 0.75rem;
  background: none;
  border: none;
  color: var(--accent-color, #0066cc);
  font-size: 13px;
  cursor: pointer;
  padding: 0;

  &:hover {
    text-decoration: underline;
  }
`;

const ExamplesScroll = styled.div`
  margin-top: 0.6rem;
  overflow-x: auto;
`;

const ExamplesTable = styled.table`
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;

  th,
  td {
    padding: 4px 10px;
    text-align: left;
    border-bottom: 1px solid #eee;
  }

  th {
    background: #f7f7f7;
    font-weight: 600;
    color: #444;
  }

  td {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #333;
  }
`;

const ExpectationBox = styled.div`
  margin-top: 0.6rem;
  font-size: 13px;
  color: #555;
  background: #f7f9fc;
  border: 1px solid #e6ebf2;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
`;

function TIER_ACCENT(pending: boolean, status: string | undefined): string {
  if (pending) return '#d9d9d9';
  switch (status) {
    case 'pass':
      return '#28a745';
    case 'warn':
      return '#f0a500';
    case 'fail':
      return '#dc3545';
    default:
      return '#d9d9d9';
  }
}

function formatValue(v: unknown): string {
  if (v == null) return '—';
  if (Array.isArray(v))
    return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

interface QCCheckCardProps {
  catalog: CatalogCheck;
  result?: QCCheckResult;
}

export function QCCheckCard({ catalog, result }: QCCheckCardProps) {
  const [expanded, setExpanded] = useState(false);
  const pending = !result;
  const accent = TIER_ACCENT(pending, result?.status);

  const examples = result?.examples ?? [];
  const exampleColumns = examples.length > 0 ? Object.keys(examples[0]) : [];

  // Metric entries to surface inline (skip n_violations — shown separately).
  const metricEntries =
    result?.metric && typeof result.metric === 'object'
      ? Object.entries(result.metric as Record<string, unknown>).filter(
          ([k]) => k !== 'n_violations'
        )
      : [];

  return (
    <Card $pending={pending} $accent={accent}>
      <CardHeader>
        <NameRow>
          <Name>{catalog.name}</Name>
          <CheckId>{catalog.id}</CheckId>
        </NameRow>
        <StatusBadge status={result?.status ?? 'pending'} />
      </CardHeader>

      {pending ? (
        <>
          <Description>{catalog.description}</Description>
          <MetaRow>
            {catalog.plot && (
              <MetaItem>
                <strong>Intended plot:</strong> {catalog.plot}
              </MetaItem>
            )}
            {catalog.needs?.map((n) => (
              <Pill key={n}>needs {n}</Pill>
            ))}
          </MetaRow>
        </>
      ) : (
        <>
          <Message>{result!.message}</Message>

          {(result!.n_violations != null || metricEntries.length > 0) && (
            <MetaRow>
              {result!.n_violations != null && (
                <MetaItem>
                  <strong>Violations:</strong> {result!.n_violations.toLocaleString()}
                </MetaItem>
              )}
              {metricEntries.map(([k, v]) => (
                <MetaItem key={k}>
                  <strong>{k}:</strong> {formatValue(v)}
                </MetaItem>
              ))}
            </MetaRow>
          )}

          {result!.expectation != null && (
            <ExpectationBox>
              <strong>Expectation:</strong>{' '}
              {typeof result!.expectation === 'object'
                ? Object.entries(result!.expectation as Record<string, unknown>)
                    .map(([k, v]) => `${k}: ${formatValue(v)}`)
                    .join(' · ')
                : formatValue(result!.expectation)}
            </ExpectationBox>
          )}

          {examples.length > 0 && (
            <>
              <ExpandButton onClick={() => setExpanded((e) => !e)}>
                {expanded ? 'Hide' : 'Show'} {examples.length} example
                {examples.length === 1 ? '' : 's'}
              </ExpandButton>
              {expanded && (
                <ExamplesScroll>
                  <ExamplesTable>
                    <thead>
                      <tr>
                        {exampleColumns.map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {examples.map((ex, i) => (
                        <tr key={i}>
                          {exampleColumns.map((col) => (
                            <td key={col}>{formatValue(ex[col])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </ExamplesTable>
                </ExamplesScroll>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

export default QCCheckCard;
