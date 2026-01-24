import React, { useMemo } from 'react';
import styled from 'styled-components';
import { scaleBand, scaleLinear } from '@visx/scale';
import { Group } from '@visx/group';
import { Bar } from '@visx/shape';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';

// Types
interface HistogramBinData {
  bin_edges: number[];
  bin_freq: number[];
  n_larger?: number;
  n_smaller?: number;
}

interface QualityMetricsHistogramProps {
  /** Histogram data for variant carriers (alt) */
  variantData?: HistogramBinData;
  /** Histogram data for all individuals (optional, for comparison) */
  allData?: HistogramBinData;
  /** Whether to show comparison with all individuals */
  showComparison?: boolean;
  /** Width of the chart */
  width?: number;
  /** Height of the chart */
  height?: number;
  /** X-axis label */
  xLabel?: string;
  /** Y-axis label */
  yLabel?: string;
  /** Color for exome data */
  exomeColor?: string;
  /** Color for genome data */
  genomeColor?: string;
  /** Data source: 'exome' or 'genome' */
  dataSource?: 'exome' | 'genome';
}

// Styled components
const Container = styled.div`
  position: relative;
`;

const ChartWrapper = styled.div`
  overflow: hidden;
`;

const NoDataMessage = styled.div`
  padding: 2rem;
  text-align: center;
  color: #666;
  background: #f8f8f8;
  border-radius: 4px;
`;

const Legend = styled.div`
  display: flex;
  gap: 1rem;
  justify-content: center;
  margin-top: 0.5rem;
  font-size: 12px;
`;

const LegendItem = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`;

const LegendSwatch = styled.div<{ $color: string; $striped?: boolean }>`
  width: 16px;
  height: 12px;
  background: ${props => props.$striped
    ? `repeating-linear-gradient(45deg, ${props.$color}, ${props.$color} 2px, transparent 2px, transparent 4px)`
    : props.$color};
  border: 1px solid ${props => props.$color};
`;

// Constants
const EXOME_COLOR = '#428bca';
const GENOME_COLOR = '#73ab3d';
const MARGIN = { top: 20, right: 30, bottom: 50, left: 60 };

export function QualityMetricsHistogram({
  variantData,
  allData,
  showComparison = false,
  width = 400,
  height = 250,
  xLabel = 'Quality Score',
  yLabel = 'Count',
  dataSource = 'exome',
}: QualityMetricsHistogramProps) {
  const barColor = dataSource === 'exome' ? EXOME_COLOR : GENOME_COLOR;

  // Prepare data for visualization
  const chartData = useMemo(() => {
    if (!variantData?.bin_edges || !variantData?.bin_freq) return [];

    const bins: Array<{
      label: string;
      variantCount: number;
      allCount: number;
      binStart: number;
      binEnd: number;
    }> = [];

    for (let i = 0; i < variantData.bin_freq.length; i++) {
      const binStart = variantData.bin_edges[i];
      const binEnd = variantData.bin_edges[i + 1] ?? binStart + 5;

      bins.push({
        label: i === variantData.bin_freq.length - 1 ? `>${binStart}` : `${binStart}-${binEnd}`,
        variantCount: variantData.bin_freq[i],
        allCount: allData?.bin_freq?.[i] ?? 0,
        binStart,
        binEnd,
      });
    }

    return bins;
  }, [variantData, allData]);

  if (!variantData || chartData.length === 0) {
    return <NoDataMessage>No histogram data available</NoDataMessage>;
  }

  // Calculate dimensions
  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  // Calculate max value for y-axis
  const maxCount = Math.max(
    ...chartData.map(d => Math.max(d.variantCount, showComparison ? d.allCount : 0))
  );

  // Scales
  const xScale = scaleBand<string>({
    domain: chartData.map(d => d.label),
    range: [0, innerWidth],
    padding: 0.2,
  });

  const yScale = scaleLinear<number>({
    domain: [0, maxCount * 1.1], // Add 10% padding
    range: [innerHeight, 0],
    nice: true,
  });

  return (
    <Container>
      <ChartWrapper>
        <svg width={width} height={height}>
          <Group left={MARGIN.left} top={MARGIN.top}>
            {/* Grid lines */}
            <GridRows
              scale={yScale}
              width={innerWidth}
              stroke="#e0e0e0"
              strokeOpacity={0.5}
            />

            {/* Bars for all individuals (if showing comparison) */}
            {showComparison && chartData.map((d, i) => {
              const barWidth = xScale.bandwidth();
              const barHeight = innerHeight - (yScale(d.allCount) ?? 0);
              const barX = xScale(d.label) ?? 0;
              const barY = yScale(d.allCount) ?? 0;

              return (
                <Bar
                  key={`all-${i}`}
                  x={barX}
                  y={barY}
                  width={barWidth}
                  height={barHeight}
                  fill={`url(#stripe-pattern-${dataSource})`}
                  stroke={barColor}
                  strokeWidth={1}
                  opacity={0.5}
                />
              );
            })}

            {/* Bars for variant carriers */}
            {chartData.map((d, i) => {
              const barWidth = xScale.bandwidth();
              const barHeight = innerHeight - (yScale(d.variantCount) ?? 0);
              const barX = xScale(d.label) ?? 0;
              const barY = yScale(d.variantCount) ?? 0;

              return (
                <Bar
                  key={`variant-${i}`}
                  x={barX}
                  y={barY}
                  width={barWidth}
                  height={barHeight}
                  fill={barColor}
                  opacity={0.8}
                />
              );
            })}

            {/* X Axis */}
            <AxisBottom
              top={innerHeight}
              scale={xScale}
              tickLabelProps={() => ({
                fill: '#666',
                fontSize: 10,
                textAnchor: 'middle',
              })}
              label={xLabel}
              labelProps={{
                fill: '#333',
                fontSize: 12,
                textAnchor: 'middle',
              }}
              labelOffset={15}
              numTicks={Math.min(chartData.length, 10)}
            />

            {/* Y Axis */}
            <AxisLeft
              scale={yScale}
              tickLabelProps={() => ({
                fill: '#666',
                fontSize: 10,
                textAnchor: 'end',
                dy: '0.33em',
              })}
              label={yLabel}
              labelProps={{
                fill: '#333',
                fontSize: 12,
                textAnchor: 'middle',
              }}
              labelOffset={40}
            />

            {/* Stripe pattern definition */}
            <defs>
              <pattern
                id={`stripe-pattern-${dataSource}`}
                patternUnits="userSpaceOnUse"
                width="4"
                height="4"
              >
                <path
                  d="M-1,1 l2,-2 M0,4 l4,-4 M3,5 l2,-2"
                  stroke={barColor}
                  strokeWidth="1"
                />
              </pattern>
            </defs>
          </Group>
        </svg>
      </ChartWrapper>

      {/* Legend */}
      <Legend>
        <LegendItem>
          <LegendSwatch $color={barColor} />
          <span>Variant carriers</span>
        </LegendItem>
        {showComparison && (
          <LegendItem>
            <LegendSwatch $color={barColor} $striped />
            <span>All individuals</span>
          </LegendItem>
        )}
      </Legend>
    </Container>
  );
}

export default QualityMetricsHistogram;
