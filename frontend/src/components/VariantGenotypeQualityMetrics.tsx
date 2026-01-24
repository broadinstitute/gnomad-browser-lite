import React, { useState } from 'react';
import styled from 'styled-components';
import type { VariantDetails } from '../api/types';
import { QualityMetricsHistogram } from './QualityMetricsHistogram';

// Styled components
const Container = styled.div`
  margin-bottom: 1rem;
`;

const TabList = styled.div`
  display: flex;
  border-bottom: 1px solid #ddd;
  margin-bottom: 1rem;
`;

const Tab = styled.button<{ $active: boolean }>`
  padding: 0.5rem 0.75rem;
  border: none;
  background: ${props => props.$active ? '#fff' : '#f5f5f5'};
  border-bottom: ${props => props.$active ? '2px solid #185da8' : '2px solid transparent'};
  cursor: pointer;
  font-size: 13px;
  font-weight: ${props => props.$active ? '600' : '400'};
  color: ${props => props.$active ? '#185da8' : '#666'};

  &:hover {
    background: ${props => props.$active ? '#fff' : '#eee'};
  }
`;

const Controls = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 1rem;
  align-items: center;
`;

const ControlGroup = styled.label`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 13px;
  color: #333;
`;

const Select = styled.select`
  padding: 4px 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 13px;
`;

const Checkbox = styled.input`
  cursor: pointer;
`;

const NoDataMessage = styled.p`
  color: #666;
  font-style: italic;
  text-align: center;
  padding: 2rem;
  background: #f8f8f8;
  border-radius: 4px;
`;

const ChartContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: center;
`;

const ChartPanel = styled.div`
  flex: 1;
  min-width: 280px;
  max-width: 450px;
`;

const ChartTitle = styled.h4`
  font-size: 13px;
  font-weight: 600;
  color: #333;
  margin: 0 0 0.5rem 0;
  text-align: center;
`;

type MetricTab = 'quality' | 'depth' | 'allele_balance';
type SequencingType = 'both' | 'exome' | 'genome';

interface Props {
  variant: VariantDetails;
}

export function VariantGenotypeQualityMetrics({ variant }: Props) {
  const [activeTab, setActiveTab] = useState<MetricTab>('quality');
  const [showComparison, setShowComparison] = useState(true);
  const [sequencingType, setSequencingType] = useState<SequencingType>('both');

  // Get data based on selected tab
  const getMetricData = (source: 'exome' | 'genome', tab: MetricTab) => {
    const data = source === 'exome' ? variant.exome : variant.genome;
    if (!data?.quality_metrics) return null;

    const qm = data.quality_metrics;

    switch (tab) {
      case 'quality':
        return {
          variant: qm.genotype_quality?.alt_adj || qm.genotype_quality?.alt,
          all: qm.genotype_quality?.all_adj || qm.genotype_quality?.all,
        };
      case 'depth':
        return {
          variant: qm.genotype_depth?.alt_adj || qm.genotype_depth?.alt,
          all: qm.genotype_depth?.all_adj || qm.genotype_depth?.all,
        };
      case 'allele_balance':
        return {
          variant: qm.allele_balance?.alt_adj || qm.allele_balance?.alt,
          all: null, // Allele balance doesn't have "all" data
        };
      default:
        return null;
    }
  };

  const hasExomeData = Boolean(variant.exome?.quality_metrics);
  const hasGenomeData = Boolean(variant.genome?.quality_metrics);

  if (!hasExomeData && !hasGenomeData) {
    return <NoDataMessage>Genotype quality metrics are not available for this variant.</NoDataMessage>;
  }

  const getTabLabel = (tab: MetricTab) => {
    switch (tab) {
      case 'quality': return 'Genotype Quality';
      case 'depth': return 'Depth';
      case 'allele_balance': return 'Allele Balance';
    }
  };

  const getXLabel = (tab: MetricTab) => {
    switch (tab) {
      case 'quality': return 'Genotype Quality (GQ)';
      case 'depth': return 'Depth (DP)';
      case 'allele_balance': return 'Allele Balance';
    }
  };

  const showExome = sequencingType === 'both' || sequencingType === 'exome';
  const showGenome = sequencingType === 'both' || sequencingType === 'genome';

  const exomeData = getMetricData('exome', activeTab);
  const genomeData = getMetricData('genome', activeTab);

  return (
    <Container>
      {/* Tabs */}
      <TabList>
        {(['quality', 'depth', 'allele_balance'] as MetricTab[]).map(tab => (
          <Tab
            key={tab}
            $active={activeTab === tab}
            onClick={() => setActiveTab(tab)}
          >
            {getTabLabel(tab)}
          </Tab>
        ))}
      </TabList>

      {/* Controls */}
      <Controls>
        {activeTab !== 'allele_balance' && (
          <ControlGroup>
            <Checkbox
              type="checkbox"
              checked={showComparison}
              onChange={(e) => setShowComparison(e.target.checked)}
            />
            Compare to all individuals
          </ControlGroup>
        )}
        <ControlGroup>
          Sequencing type:
          <Select
            value={sequencingType}
            onChange={(e) => setSequencingType(e.target.value as SequencingType)}
          >
            <option value="both">Exome and Genome</option>
            <option value="exome" disabled={!hasExomeData}>Exome only</option>
            <option value="genome" disabled={!hasGenomeData}>Genome only</option>
          </Select>
        </ControlGroup>
      </Controls>

      {/* Charts */}
      <ChartContainer>
        {showExome && hasExomeData && exomeData && (
          <ChartPanel>
            <ChartTitle>Exome</ChartTitle>
            <QualityMetricsHistogram
              variantData={exomeData.variant}
              allData={exomeData.all}
              showComparison={showComparison && activeTab !== 'allele_balance'}
              xLabel={getXLabel(activeTab)}
              yLabel="Variant Carriers"
              dataSource="exome"
              width={380}
              height={220}
            />
          </ChartPanel>
        )}
        {showGenome && hasGenomeData && genomeData && (
          <ChartPanel>
            <ChartTitle>Genome</ChartTitle>
            <QualityMetricsHistogram
              variantData={genomeData.variant}
              allData={genomeData.all}
              showComparison={showComparison && activeTab !== 'allele_balance'}
              xLabel={getXLabel(activeTab)}
              yLabel="Variant Carriers"
              dataSource="genome"
              width={380}
              height={220}
            />
          </ChartPanel>
        )}
      </ChartContainer>
    </Container>
  );
}

export default VariantGenotypeQualityMetrics;
