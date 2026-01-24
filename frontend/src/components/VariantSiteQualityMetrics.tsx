import React, { useState } from 'react';
import styled from 'styled-components';
import type { VariantDetails } from '../api/types';

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
  padding: 0.75rem 1rem;
  border: none;
  background: ${props => props.$active ? '#fff' : '#f5f5f5'};
  border-bottom: ${props => props.$active ? '2px solid #185da8' : '2px solid transparent'};
  cursor: pointer;
  font-size: 14px;
  font-weight: ${props => props.$active ? '600' : '400'};
  color: ${props => props.$active ? '#185da8' : '#666'};

  &:hover {
    background: ${props => props.$active ? '#fff' : '#eee'};
  }
`;

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
`;

const Th = styled.th<{ $align?: 'left' | 'right' }>`
  text-align: ${props => props.$align || 'left'};
  padding: 0.75rem 0.5rem;
  border-bottom: 2px solid #333;
  font-weight: 600;
`;

const Td = styled.td<{ $align?: 'left' | 'right' }>`
  text-align: ${props => props.$align || 'left'};
  padding: 0.75rem 0.5rem;
  border-bottom: 1px solid #eee;
  font-variant-numeric: tabular-nums;
`;

const MetricName = styled.span`
  background-image: linear-gradient(to right, #666 75%, transparent 75%);
  background-position: 0 1.15em;
  background-size: 4px 2px;
  background-repeat: repeat-x;
  cursor: help;
`;

const PlaceholderContent = styled.div`
  padding: 2rem;
  text-align: center;
  color: #666;
  background: #f8f8f8;
  border-radius: 4px;
`;

const NoDataMessage = styled.p`
  color: #666;
  font-style: italic;
`;

// Metric descriptions for tooltips
const qualityMetricDescriptions: Record<string, string> = {
  SiteQuality: 'Phred-scaled quality score for the assertion made in ALT. i.e. -10log10 prob(no variant).',
  inbreeding_coeff: 'Inbreeding coefficient as estimated from the genotype likelihoods per-sample when compared against the Hardy-Weinberg expectation.',
  AS_FS: "Allele-specific phred-scaled p-value of Fisher's exact test for strand bias.",
  AS_MQ: 'Allele-specific root mean square of the mapping quality of reads across all samples.',
  AS_MQRankSum: 'Allele-specific Z-score from Wilcoxon rank sum test of alternate vs. reference read mapping qualities.',
  AS_pab_max: 'Maximum p-value over callset for binomial test of observed allele balance for a heterozygous genotype.',
  AS_QUALapprox: 'Allele-specific variant call confidence.',
  AS_QD: 'Allele-specific variant call confidence normalized by depth of sample reads supporting a variant.',
  AS_ReadPosRankSum: 'Allele-specific Z-score from Wilcoxon rank sum test of alternate vs. reference read position bias.',
  AS_SOR: 'Allele-specific strand bias estimated by the symmetric odds ratio test.',
  AS_VarDP: 'Allele-specific depth over variant genotypes.',
  AS_VQSLOD: 'Allele-specific log-odds ratio of being a true variant versus being a false positive under the trained VQSR Gaussian mixture model.',
};

// Ordered list of metrics to display
const METRIC_ORDER = [
  'SiteQuality',
  'inbreeding_coeff',
  'AS_FS',
  'AS_MQ',
  'AS_MQRankSum',
  'AS_pab_max',
  'AS_QUALapprox',
  'AS_QD',
  'AS_ReadPosRankSum',
  'AS_SOR',
  'AS_VarDP',
  'AS_VQSLOD',
];

function formatMetricValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  if (value === 0) return '0';
  if (Math.abs(value) < 0.001) return value.toExponential(3);
  if (Math.abs(value) > 10000) return value.toExponential(3);
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

interface SiteQualityMetricsTableProps {
  variant: VariantDetails;
}

function SiteQualityMetricsTable({ variant }: SiteQualityMetricsTableProps) {
  const hasExome = Boolean(variant.exome?.quality_metrics?.site_quality_metrics);
  const hasGenome = Boolean(variant.genome?.quality_metrics?.site_quality_metrics);

  // Build metric lookup maps
  const exomeMetrics: Record<string, number | null> = {};
  const genomeMetrics: Record<string, number | null> = {};

  if (variant.exome?.quality_metrics?.site_quality_metrics) {
    variant.exome.quality_metrics.site_quality_metrics.forEach((m) => {
      exomeMetrics[m.metric] = m.value;
    });
  }

  if (variant.genome?.quality_metrics?.site_quality_metrics) {
    variant.genome.quality_metrics.site_quality_metrics.forEach((m) => {
      genomeMetrics[m.metric] = m.value;
    });
  }

  if (!hasExome && !hasGenome) {
    return <NoDataMessage>No site quality metrics available for this variant.</NoDataMessage>;
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Metric</Th>
          {hasExome && <Th $align="right">Exome samples</Th>}
          {hasGenome && <Th $align="right">Genome samples</Th>}
        </tr>
      </thead>
      <tbody>
        {METRIC_ORDER.map(metric => {
          const description = qualityMetricDescriptions[metric];
          return (
            <tr key={metric}>
              <Td>
                {description ? (
                  <MetricName title={description}>{metric}</MetricName>
                ) : (
                  metric
                )}
              </Td>
              {hasExome && (
                <Td $align="right">{formatMetricValue(exomeMetrics[metric])}</Td>
              )}
              {hasGenome && (
                <Td $align="right">{formatMetricValue(genomeMetrics[metric])}</Td>
              )}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function HistogramPlaceholder() {
  return (
    <PlaceholderContent>
      Metric distribution histogram will be implemented in a future phase.
      <br />
      <small>This requires pre-computed histogram data for each metric binned by allele frequency.</small>
    </PlaceholderContent>
  );
}

interface VariantSiteQualityMetricsProps {
  variant: VariantDetails;
}

export function VariantSiteQualityMetrics({ variant }: VariantSiteQualityMetricsProps) {
  const [activeTab, setActiveTab] = useState<'distribution' | 'values'>('values');

  // Check if we have any quality metrics data
  const hasData = Boolean(
    variant.exome?.quality_metrics?.site_quality_metrics ||
    variant.genome?.quality_metrics?.site_quality_metrics
  );

  if (!hasData) {
    return <NoDataMessage>Site quality metrics are not available for this variant.</NoDataMessage>;
  }

  return (
    <Container>
      <TabList>
        <Tab
          $active={activeTab === 'distribution'}
          onClick={() => setActiveTab('distribution')}
        >
          Metric distribution
        </Tab>
        <Tab
          $active={activeTab === 'values'}
          onClick={() => setActiveTab('values')}
        >
          All metric values
        </Tab>
      </TabList>

      {activeTab === 'distribution' && <HistogramPlaceholder />}
      {activeTab === 'values' && <SiteQualityMetricsTable variant={variant} />}
    </Container>
  );
}

export default VariantSiteQualityMetrics;
