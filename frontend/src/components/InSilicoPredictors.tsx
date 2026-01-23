import styled from 'styled-components';
import type { InSilicoPredictors as InSilicoPredictorsType } from '../api/types';

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
`;

const TdRight = styled(Td)`
  text-align: right;
  font-variant-numeric: tabular-nums;
`;

const ScoreValue = styled.span<{ $severity?: 'high' | 'medium' | 'low' | 'none' }>`
  font-weight: 500;
  color: ${props => {
    switch (props.$severity) {
      case 'high': return '#c62828';
      case 'medium': return '#e65100';
      case 'low': return '#2e7d32';
      default: return '#333';
    }
  }};
`;

const Interpretation = styled.span`
  color: #666;
  font-size: 13px;
  margin-left: 8px;
`;

const NoData = styled.div`
  padding: 1rem;
  color: #666;
  text-align: center;
`;

const InfoIcon = styled.span`
  color: #999;
  cursor: help;
  margin-left: 4px;
  font-size: 12px;
`;

interface PredictorInfo {
  name: string;
  description: string;
  interpret: (value: number | undefined) => { severity: 'high' | 'medium' | 'low' | 'none'; text: string } | null;
}

const PREDICTORS: Record<string, PredictorInfo> = {
  cadd: {
    name: 'CADD',
    description: 'Combined Annotation Dependent Depletion (Phred-scaled)',
    interpret: (value) => {
      if (value === undefined) return null;
      if (value >= 30) return { severity: 'high', text: 'Likely deleterious' };
      if (value >= 20) return { severity: 'medium', text: 'Possibly deleterious' };
      if (value >= 10) return { severity: 'low', text: 'Likely benign' };
      return { severity: 'none', text: 'Benign' };
    },
  },
  revel_max: {
    name: 'REVEL',
    description: 'Rare Exome Variant Ensemble Learner',
    interpret: (value) => {
      if (value === undefined) return null;
      if (value >= 0.75) return { severity: 'high', text: 'Likely pathogenic' };
      if (value >= 0.5) return { severity: 'medium', text: 'Uncertain' };
      if (value >= 0.25) return { severity: 'low', text: 'Likely benign' };
      return { severity: 'none', text: 'Benign' };
    },
  },
  spliceai_ds_max: {
    name: 'SpliceAI',
    description: 'Splice-altering variant prediction',
    interpret: (value) => {
      if (value === undefined) return null;
      if (value >= 0.8) return { severity: 'high', text: 'High splice impact' };
      if (value >= 0.5) return { severity: 'medium', text: 'Likely splice-altering' };
      if (value >= 0.2) return { severity: 'low', text: 'Low splice impact' };
      return { severity: 'none', text: 'No splice impact' };
    },
  },
  pangolin_largest_ds: {
    name: 'Pangolin',
    description: 'Deep learning-based splice site prediction',
    interpret: (value) => {
      if (value === undefined) return null;
      if (value >= 0.5) return { severity: 'high', text: 'Likely splice-altering' };
      if (value >= 0.2) return { severity: 'medium', text: 'Possible splice impact' };
      return { severity: 'none', text: 'Low/no splice impact' };
    },
  },
  phylop: {
    name: 'phyloP',
    description: 'Phylogenetic conservation score',
    interpret: (value) => {
      if (value === undefined) return null;
      if (value >= 4) return { severity: 'high', text: 'Highly conserved' };
      if (value >= 2) return { severity: 'medium', text: 'Moderately conserved' };
      if (value >= 0) return { severity: 'low', text: 'Low conservation' };
      return { severity: 'none', text: 'Not conserved' };
    },
  },
  sift_max: {
    name: 'SIFT',
    description: 'Sorting Intolerant From Tolerant',
    interpret: (value) => {
      if (value === undefined) return null;
      // SIFT: lower is more deleterious
      if (value <= 0.05) return { severity: 'high', text: 'Deleterious' };
      if (value <= 0.1) return { severity: 'medium', text: 'Possibly deleterious' };
      return { severity: 'none', text: 'Tolerated' };
    },
  },
  polyphen_max: {
    name: 'PolyPhen',
    description: 'Polymorphism Phenotyping v2',
    interpret: (value) => {
      if (value === undefined) return null;
      if (value >= 0.957) return { severity: 'high', text: 'Probably damaging' };
      if (value >= 0.453) return { severity: 'medium', text: 'Possibly damaging' };
      return { severity: 'none', text: 'Benign' };
    },
  },
};

function formatScore(value: number | undefined, decimals = 3): string {
  if (value === undefined || value === null) return '—';
  return value.toFixed(decimals);
}

interface InSilicoPredictorsProps {
  predictors?: InSilicoPredictorsType;
}

export function InSilicoPredictors({ predictors }: InSilicoPredictorsProps) {
  if (!predictors) {
    return <NoData>No in silico predictor data available</NoData>;
  }

  // Check if we have any data
  const hasAnyData = Object.keys(PREDICTORS).some(key => {
    if (key === 'cadd') {
      return predictors.cadd?.phred !== undefined;
    }
    return (predictors as Record<string, unknown>)[key] !== undefined;
  });

  if (!hasAnyData) {
    return <NoData>No in silico predictor data available</NoData>;
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Predictor</Th>
          <Th style={{ textAlign: 'right' }}>Score</Th>
          <Th>Interpretation</Th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(PREDICTORS).map(([key, info]) => {
          let value: number | undefined;

          if (key === 'cadd') {
            value = predictors.cadd?.phred;
          } else {
            value = (predictors as Record<string, number | undefined>)[key];
          }

          const interpretation = info.interpret(value);

          return (
            <tr key={key}>
              <Td>
                {info.name}
                <InfoIcon title={info.description}>?</InfoIcon>
              </Td>
              <TdRight>
                <ScoreValue $severity={interpretation?.severity}>
                  {formatScore(value, key === 'cadd' ? 1 : 3)}
                </ScoreValue>
              </TdRight>
              <Td>
                {interpretation && (
                  <Interpretation>{interpretation.text}</Interpretation>
                )}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export default InSilicoPredictors;
