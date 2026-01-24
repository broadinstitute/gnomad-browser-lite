import React, { useMemo } from 'react';
import styled from 'styled-components';
import { scaleBand, scaleLinear } from '@visx/scale';
import { Group } from '@visx/group';
import { Bar } from '@visx/shape';
import { AxisBottom, AxisLeft, AxisRight } from '@visx/axis';
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
  /** Secondary histogram data for variant carriers (for overlaid mode - genome) */
  secondaryVariantData?: HistogramBinData;
  /** Secondary histogram data for all individuals (for overlaid mode - genome) */
  secondaryAllData?: HistogramBinData;
  /** Whether to show comparison with all individuals */
  showComparison?: boolean;
  /** Whether to show overlaid exome + genome */
  overlaid?: boolean;
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
const ALL_INDIVIDUALS_COLOR = '#999';

// Format large numbers for axis ticks (integers only for counts)
function formatAxisTick(value: number): string {
  if (!Number.isInteger(value)) return '';
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
  return value.toString();
}

export function QualityMetricsHistogram({
  variantData,
  allData,
  secondaryVariantData,
  secondaryAllData,
  showComparison = false,
  overlaid = false,
  width = 450,
  height = 260,
  xLabel = 'Quality Score',
  dataSource = 'exome',
}: QualityMetricsHistogramProps) {
  const exomeColor = EXOME_COLOR;
  const genomeColor = GENOME_COLOR;
  const barColor = dataSource === 'exome' ? exomeColor : genomeColor;

  // Margins - increase right margin when showing comparison for dual y-axis
  const margin = useMemo(() => ({
    top: 20,
    right: showComparison ? 90 : 30,
    bottom: 50,
    left: 70,
  }), [showComparison]);

  // Prepare data for visualization
  const chartData = useMemo(() => {
    if (!variantData?.bin_edges || !variantData?.bin_freq) return [];

    const bins: Array<{
      label: string;
      variantCount: number;
      allCount: number;
      secondaryVariantCount: number;
      secondaryAllCount: number;
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
        secondaryVariantCount: secondaryVariantData?.bin_freq?.[i] ?? 0,
        secondaryAllCount: secondaryAllData?.bin_freq?.[i] ?? 0,
        binStart,
        binEnd,
      });
    }

    return bins;
  }, [variantData, allData, secondaryVariantData, secondaryAllData]);

  if (!variantData || chartData.length === 0) {
    return <NoDataMessage>No histogram data available</NoDataMessage>;
  }

  // Calculate dimensions
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  // Calculate max values for each y-axis
  // In stacked mode, max is the sum of exome + genome
  const maxVariantCount = overlaid
    ? Math.max(...chartData.map(d => d.variantCount + d.secondaryVariantCount), 1)
    : Math.max(...chartData.map(d => d.variantCount), 1);
  const maxAllCount = showComparison
    ? (overlaid
        ? Math.max(...chartData.map(d => d.allCount + d.secondaryAllCount), 1)
        : Math.max(...chartData.map(d => d.allCount), 1))
    : 0;

  // Scales
  const xScale = scaleBand<string>({
    domain: chartData.map(d => d.label),
    range: [0, innerWidth],
    padding: 0.2,
  });

  // Left y-axis scale for variant carriers
  const yScaleVariant = scaleLinear<number>({
    domain: [0, maxVariantCount * 1.1],
    range: [innerHeight, 0],
    nice: true,
  });

  // Right y-axis scale for all individuals (different scale)
  const yScaleAll = scaleLinear<number>({
    domain: [0, maxAllCount * 1.1],
    range: [innerHeight, 0],
    nice: true,
  });

  return (
    <Container>
      <ChartWrapper>
        <svg width={width} height={height}>
          <Group left={margin.left} top={margin.top}>
            {/* Grid lines based on variant scale */}
            <GridRows
              scale={yScaleVariant}
              width={innerWidth}
              stroke="#e0e0e0"
              strokeOpacity={0.5}
            />

            {/* Bars for all individuals (if showing comparison) - use right y-axis scale */}
            {showComparison && chartData.map((d, i) => {
              const barWidth = xScale.bandwidth();
              const barX = xScale(d.label) ?? 0;

              if (overlaid) {
                // Stacked bars: exome on bottom, genome on top
                const exomeHeight = innerHeight - (yScaleAll(d.allCount) ?? 0);
                const genomeHeight = innerHeight - (yScaleAll(d.secondaryAllCount) ?? 0);
                const exomeY = innerHeight - exomeHeight;
                const genomeY = exomeY - genomeHeight;

                return (
                  <React.Fragment key={`all-${i}`}>
                    {/* Exome bar (bottom) */}
                    <Bar
                      x={barX}
                      y={exomeY}
                      width={barWidth}
                      height={exomeHeight}
                      fill={`url(#stripe-pattern-exome)`}
                      stroke={exomeColor}
                      strokeWidth={1}
                      opacity={0.8}
                    />
                    {/* Genome bar (stacked on top) */}
                    <Bar
                      x={barX}
                      y={genomeY}
                      width={barWidth}
                      height={genomeHeight}
                      fill={`url(#stripe-pattern-genome)`}
                      stroke={genomeColor}
                      strokeWidth={1}
                      opacity={0.8}
                    />
                  </React.Fragment>
                );
              }

              // Non-stacked single bar - use pattern matching the data source
              return (
                <Bar
                  key={`all-${i}`}
                  x={barX}
                  y={yScaleAll(d.allCount) ?? 0}
                  width={barWidth}
                  height={innerHeight - (yScaleAll(d.allCount) ?? 0)}
                  fill={`url(#stripe-pattern-${dataSource})`}
                  stroke={barColor}
                  strokeWidth={1}
                  opacity={0.8}
                />
              );
            })}

            {/* Bars for variant carriers - use left y-axis scale */}
            {chartData.map((d, i) => {
              const barWidth = xScale.bandwidth();
              const barX = xScale(d.label) ?? 0;

              if (overlaid) {
                // Stacked bars: exome on bottom, genome on top
                const exomeHeight = innerHeight - (yScaleVariant(d.variantCount) ?? 0);
                const genomeHeight = innerHeight - (yScaleVariant(d.secondaryVariantCount) ?? 0);
                const exomeY = innerHeight - exomeHeight;
                const genomeY = exomeY - genomeHeight;

                return (
                  <React.Fragment key={`variant-${i}`}>
                    {/* Exome bar (bottom) */}
                    <Bar
                      x={barX}
                      y={exomeY}
                      width={barWidth}
                      height={exomeHeight}
                      fill={exomeColor}
                      opacity={0.8}
                    />
                    {/* Genome bar (stacked on top) */}
                    <Bar
                      x={barX}
                      y={genomeY}
                      width={barWidth}
                      height={genomeHeight}
                      fill={genomeColor}
                      opacity={0.8}
                    />
                  </React.Fragment>
                );
              }

              // Non-stacked single bar
              return (
                <Bar
                  key={`variant-${i}`}
                  x={barX}
                  y={yScaleVariant(d.variantCount) ?? 0}
                  width={barWidth}
                  height={innerHeight - (yScaleVariant(d.variantCount) ?? 0)}
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
                fontSize: 9,
                textAnchor: 'middle',
              })}
              label={xLabel}
              labelProps={{
                fill: '#333',
                fontSize: 11,
                textAnchor: 'middle',
              }}
              labelOffset={15}
              tickLength={4}
            />

            {/* Left Y Axis - Variant Carriers */}
            <AxisLeft
              scale={yScaleVariant}
              tickLabelProps={() => ({
                fill: barColor,
                fontSize: 10,
                textAnchor: 'end',
                dy: '0.33em',
              })}
              label="Variant carriers"
              labelProps={{
                fill: barColor,
                fontSize: 11,
                textAnchor: 'middle',
              }}
              labelOffset={40}
              tickLength={4}
              stroke={barColor}
              tickStroke={barColor}
              tickFormat={formatAxisTick}
              numTicks={Math.min(maxVariantCount, 6)}
              tickValues={maxVariantCount <= 10
                ? Array.from({ length: maxVariantCount + 1 }, (_, i) => i)
                : undefined}
            />

            {/* Right Y Axis - All Individuals (only when showing comparison) */}
            {showComparison && (
              <AxisRight
                left={innerWidth}
                scale={yScaleAll}
                tickLabelProps={() => ({
                  fill: ALL_INDIVIDUALS_COLOR,
                  fontSize: 10,
                  textAnchor: 'start',
                  dx: '0.5em',
                  dy: '0.33em',
                })}
                label="All individuals"
                labelProps={{
                  fill: ALL_INDIVIDUALS_COLOR,
                  fontSize: 11,
                  textAnchor: 'middle',
                }}
                labelOffset={55}
                tickLength={4}
                stroke={ALL_INDIVIDUALS_COLOR}
                tickStroke={ALL_INDIVIDUALS_COLOR}
                tickFormat={formatAxisTick}
              />
            )}

            {/* Stripe pattern definitions */}
            <defs>
              <pattern
                id="stripe-pattern-exome"
                patternUnits="userSpaceOnUse"
                width="5"
                height="5"
              >
                <path
                  d="M-1,1 l2,-2 M0,5 l5,-5 M4,6 l2,-2"
                  stroke={exomeColor}
                  strokeWidth="2"
                />
              </pattern>
              <pattern
                id="stripe-pattern-genome"
                patternUnits="userSpaceOnUse"
                width="5"
                height="5"
              >
                <path
                  d="M-1,1 l2,-2 M0,5 l5,-5 M4,6 l2,-2"
                  stroke={genomeColor}
                  strokeWidth="2"
                />
              </pattern>
            </defs>
          </Group>
        </svg>
      </ChartWrapper>

      {/* Legend */}
      <Legend>
        {overlaid ? (
          <>
            <LegendItem>
              <LegendSwatch $color={exomeColor} />
              <span>Exome</span>
            </LegendItem>
            <LegendItem>
              <LegendSwatch $color={genomeColor} />
              <span>Genome</span>
            </LegendItem>
            {showComparison && (
              <LegendItem>
                <LegendSwatch $color={ALL_INDIVIDUALS_COLOR} $striped />
                <span>All individuals</span>
              </LegendItem>
            )}
          </>
        ) : (
          <>
            <LegendItem>
              <LegendSwatch $color={barColor} />
              <span>Variant carriers</span>
            </LegendItem>
            {showComparison && (
              <LegendItem>
                <LegendSwatch $color={ALL_INDIVIDUALS_COLOR} $striped />
                <span>All individuals</span>
              </LegendItem>
            )}
          </>
        )}
      </Legend>
    </Container>
  );
}

export default QualityMetricsHistogram;
