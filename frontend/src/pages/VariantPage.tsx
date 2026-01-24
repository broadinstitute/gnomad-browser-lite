import { useEffect, useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import styled from 'styled-components';
import { api } from '../api/client';
import type { VariantDetails, Population } from '../api/types';
import { PopulationsTable } from '../components/PopulationsTable';
import { TranscriptConsequenceList } from '../components/TranscriptConsequenceList';
import { InSilicoPredictors } from '../components/InSilicoPredictors';
import { VariantOccurrenceTable } from '../components/VariantOccurrenceTable';
import { VariantSiteQualityMetrics } from '../components/VariantSiteQualityMetrics';
import { VariantGenotypeQualityMetrics } from '../components/VariantGenotypeQualityMetrics';

// Population display names (matching gnomAD)
const POPULATION_NAMES: Record<string, string> = {
  afr: 'African/African American',
  ami: 'Amish',
  amr: 'Admixed American',
  asj: 'Ashkenazi Jewish',
  eas: 'East Asian',
  fin: 'Finnish',
  mid: 'Middle Eastern',
  nfe: 'Non-Finnish European',
  sas: 'South Asian',
  remaining: 'Remaining',
  XX: 'XX',
  XY: 'XY',
};

// Main population IDs (not sex-stratified, in display order)
const POPULATION_ORDER = ['afr', 'ami', 'amr', 'asj', 'eas', 'fin', 'mid', 'nfe', 'sas', 'remaining'];

const Container = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  padding: 1rem;
`;

const Header = styled.div`
  margin-bottom: 1.5rem;
`;

const VariantTitle = styled.h1`
  margin: 0 0 0.5rem 0;
  font-size: 1.75rem;
  font-family: monospace;
`;

const BadgeRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
`;

const Badge = styled.span<{ $color?: string; $bg?: string }>`
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  background: ${props => props.$bg || '#e0e0e0'};
  color: ${props => props.$color || '#333'};
`;

const RsidBadge = styled.a`
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  background: #e3f2fd;
  color: #1565c0;
  text-decoration: none;

  &:hover {
    background: #bbdefb;
    text-decoration: underline;
  }
`;

const LinkBadge = styled(Link)`
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  background: #f5f5f5;
  color: #333;
  text-decoration: none;
  border: 1px solid #ddd;

  &:hover {
    background: #e0e0e0;
  }
`;

const ExternalLinkBadge = styled.a`
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  background: #f5f5f5;
  color: #333;
  text-decoration: none;
  border: 1px solid #ddd;

  &:hover {
    background: #e0e0e0;
  }
`;

const FlagBadge = styled(Badge)`
  background: #fff3e0;
  color: #e65100;
`;

const ButtonRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1rem;
`;

const Button = styled(Link)`
  display: inline-flex;
  align-items: center;
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  background: #f5f5f5;
  color: #333;
  border: 1px solid #ddd;

  &:hover {
    background: #e0e0e0;
  }
`;

const ExternalButton = styled.a`
  display: inline-flex;
  align-items: center;
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  background: #f5f5f5;
  color: #333;
  border: 1px solid #ddd;

  &:hover {
    background: #e0e0e0;
  }
`;

const SummaryTable = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
  padding: 1rem;
  background: #f8f8f8;
  border-radius: 4px;
`;

const SummaryItem = styled.div``;

const SummaryLabel = styled.div`
  font-size: 12px;
  color: #666;
  text-transform: uppercase;
  margin-bottom: 4px;
`;

const SummaryValue = styled.div`
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
`;

const SectionTitle = styled.h2`
  font-size: 1.25rem;
  margin: 2rem 0 1rem 0;
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

const TopSection = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 2rem;
  margin-bottom: 1rem;
`;

const OccurrenceTableWrapper = styled.div`
  flex: 0 0 auto;
`;

const ExternalResourcesSection = styled.div`
  flex: 1;
  min-width: 200px;
`;

const ExternalResourcesTitle = styled.h3`
  font-size: 1.1rem;
  font-weight: bold;
  margin: 1.25em 0 0.75em 0;
`;

const ResourceList = styled.ul`
  list-style: disc;
  padding-left: 1.5em;
  margin: 0;
  line-height: 1.8;
`;

const ResourceLink = styled.a`
  color: #185da8;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`;

const ExternalResources = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
`;

const CoverageGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1rem;
  padding: 1rem;
  background: #f8f8f8;
  border-radius: 4px;
`;

const QualityMetricsWrapper = styled.div`
  display: flex;
  flex-flow: row wrap;
  justify-content: space-between;
  gap: 2rem;
`;

const QualityMetricsSection = styled.section`
  flex: 1;
  min-width: 300px;

  @media (max-width: 992px) {
    width: 100%;
  }
`;

const QualityMetricsPlaceholder = styled.div`
  padding: 2rem;
  text-align: center;
  color: #666;
  background: #f8f8f8;
  border-radius: 4px;
`;

function formatFrequency(ac?: number, an?: number): string {
  if (ac === undefined || an === undefined || an === 0) return '—';
  const af = ac / an;
  if (af === 0) return '0';
  if (af < 0.0001) return af.toExponential(2);
  return af.toPrecision(4);
}

function formatNumber(n?: number): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
}

export function VariantPage() {
  const { variantId } = useParams<{ variantId: string }>();
  const [variant, setVariant] = useState<VariantDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!variantId) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await api.getVariant(variantId);
        setVariant(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load variant data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [variantId]);

  // Transform ancestry groups into format expected by PopulationsTable
  const populations = useMemo(() => {
    const rawGroups = variant?.joint?.freq?.all?.ancestry_groups;
    if (!rawGroups || rawGroups.length === 0) return [];

    // Build a map of raw populations by id
    const popMap = new Map<string, Population>();
    rawGroups.forEach((pop: Population) => {
      popMap.set(pop.id, pop);
    });

    // Build the populations list with subpopulations
    type FormattedPopulation = {
      id: string;
      name: string;
      ac: number;
      an: number;
      ac_hom?: number;
      ac_hemi?: number;
      subpopulations?: Array<{
        id: string;
        name: string;
        ac: number;
        an: number;
        ac_hom?: number;
        ac_hemi?: number;
      }>;
    };

    const result: FormattedPopulation[] = [];

    POPULATION_ORDER.forEach(popId => {
      const mainPop = popMap.get(popId);
      if (!mainPop) return;

      const subpopulations: FormattedPopulation['subpopulations'] = [];

      // Look for XX and XY subpopulations
      const xxPop = popMap.get(`${popId}_XX`);
      const xyPop = popMap.get(`${popId}_XY`);

      if (xxPop) {
        subpopulations.push({
          id: xxPop.id,
          name: 'XX',
          ac: xxPop.ac,
          an: xxPop.an,
          ac_hom: xxPop.homozygote_count,
          ac_hemi: xxPop.hemizygote_count,
        });
      }

      if (xyPop) {
        subpopulations.push({
          id: xyPop.id,
          name: 'XY',
          ac: xyPop.ac,
          an: xyPop.an,
          ac_hom: xyPop.homozygote_count,
          ac_hemi: xyPop.hemizygote_count,
        });
      }

      result.push({
        id: popId,
        name: POPULATION_NAMES[popId] || popId,
        ac: mainPop.ac,
        an: mainPop.an,
        ac_hom: mainPop.homozygote_count,
        ac_hemi: mainPop.hemizygote_count,
        subpopulations: subpopulations.length > 0 ? subpopulations : undefined,
      });
    });

    // Note: XX/XY totals are shown only as subpopulations under each ancestry group
    // matching gnomAD's layout where populations expand to show Overall/XX/XY

    return result;
  }, [variant]);

  // Find primary gene for "Gene page" button
  const primaryGene = useMemo(() => {
    if (!variant?.transcript_consequences) return null;

    // Prefer MANE Select, then canonical
    const mane = variant.transcript_consequences.find(tc => tc.is_mane_select);
    if (mane) return { gene_id: mane.gene_id, gene_symbol: mane.gene_symbol };

    const canonical = variant.transcript_consequences.find(tc => tc.is_canonical);
    if (canonical) return { gene_id: canonical.gene_id, gene_symbol: canonical.gene_symbol };

    // Fallback to first transcript
    const first = variant.transcript_consequences[0];
    if (first) return { gene_id: first.gene_id, gene_symbol: first.gene_symbol };

    return null;
  }, [variant]);

  // Get frequency data
  const freqData = useMemo(() => {
    const jointFreq = variant?.joint?.freq?.all;
    const grpmax = variant?.joint?.grpmax;
    const fafmax = variant?.joint?.fafmax;

    return {
      ac: jointFreq?.ac ?? variant?.ac,
      an: jointFreq?.an ?? variant?.an,
      homozygote_count: jointFreq?.homozygote_count,
      grpmax,
      fafmax,
    };
  }, [variant]);

  if (loading) {
    return (
      <Container>
        <LoadingMessage>Loading variant data...</LoadingMessage>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <Breadcrumb>
          <Link to="/">Home</Link> / Variant
        </Breadcrumb>
        <ErrorMessage>
          <strong>Error:</strong> {error}
        </ErrorMessage>
      </Container>
    );
  }

  if (!variant) {
    return (
      <Container>
        <Breadcrumb>
          <Link to="/">Home</Link> / Variant
        </Breadcrumb>
        <ErrorMessage>Variant not found</ErrorMessage>
      </Container>
    );
  }

  const chrom = variant.chrom || '';
  const pos = variant.pos || 0;

  return (
    <Container>
      <Breadcrumb>
        <Link to="/">Home</Link> / Variant / {variantId}
      </Breadcrumb>

      <Header>
        <VariantTitle>{variantId}</VariantTitle>

        <BadgeRow>
          {variant.rsids?.map(rsid => (
            <RsidBadge
              key={rsid}
              href={`https://www.ncbi.nlm.nih.gov/snp/${rsid}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {rsid}
            </RsidBadge>
          ))}
          {variant.caid && (
            <RsidBadge
              href={`https://reg.clinicalgenome.org/redmine/projects/registry/genboree_registry/by_caid?caid=${variant.caid}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {variant.caid}
            </RsidBadge>
          )}
          {variant.joint?.flags?.map(flag => (
            <FlagBadge key={flag}>{flag}</FlagBadge>
          ))}
          {primaryGene && (
            <LinkBadge to={`/gene/${primaryGene.gene_id}`}>
              Gene page
            </LinkBadge>
          )}
          <ExternalLinkBadge
            href={`https://gnomad.broadinstitute.org/variant/${variantId}?dataset=gnomad_r4`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View in full gnomAD
          </ExternalLinkBadge>
        </BadgeRow>
      </Header>

      {/* Frequency Summary and External Resources - side by side like gnomAD */}
      <TopSection>
        <OccurrenceTableWrapper>
          <VariantOccurrenceTable
            ac={freqData.ac}
            an={freqData.an}
            homozygoteCount={freqData.homozygote_count}
            faf95={freqData.fafmax?.faf95_max}
            faf95PopMax={freqData.fafmax?.faf95_max_gen_anc}
            filters={variant.joint?.flags}
            chrom={chrom}
          />
        </OccurrenceTableWrapper>
        <ExternalResourcesSection>
          <ExternalResourcesTitle>External Resources</ExternalResourcesTitle>
          <ResourceList>
            {variant.rsids?.[0] && (
              <li>
                <ResourceLink
                  href={`https://www.ncbi.nlm.nih.gov/snp/${variant.rsids[0]}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  dbSNP ({variant.rsids[0]})
                </ResourceLink>
              </li>
            )}
            <li>
              <ResourceLink
                href={`https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38&position=${chrom}:${pos - 25}-${pos + 25}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                UCSC
              </ResourceLink>
            </li>
            {variant.caid && (
              <li>
                <ResourceLink
                  href={`https://reg.clinicalgenome.org/redmine/projects/registry/genboree_registry/by_caid?caid=${variant.caid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ClinGen Allele Registry ({variant.caid})
                </ResourceLink>
              </li>
            )}
            <li>
              <ResourceLink
                href={`https://gnomad.broadinstitute.org/variant/${variantId}?dataset=gnomad_r4`}
                target="_blank"
                rel="noopener noreferrer"
              >
                gnomAD
              </ResourceLink>
            </li>
          </ResourceList>
        </ExternalResourcesSection>
      </TopSection>

      {/* Population Frequencies */}
      {populations.length > 0 && (
        <>
          <SectionTitle>Population Frequencies</SectionTitle>
          <PopulationsTable
            populations={populations}
            showHemizygotes={chrom === 'chrX' || chrom === 'X'}
          />
        </>
      )}

      {/* Transcript Consequences */}
      {variant.transcript_consequences && variant.transcript_consequences.length > 0 && (
        <>
          <SectionTitle>
            Transcript Consequences ({variant.transcript_consequences.length})
          </SectionTitle>
          <TranscriptConsequenceList consequences={variant.transcript_consequences} />
        </>
      )}

      {/* In Silico Predictors */}
      {variant.in_silico_predictors && (
        <>
          <SectionTitle>In Silico Predictors</SectionTitle>
          <InSilicoPredictors predictors={variant.in_silico_predictors} />
        </>
      )}

      {/* Genotype and Site Quality Metrics - two column layout */}
      <QualityMetricsWrapper>
        <QualityMetricsSection>
          <SectionTitle>Genotype Quality Metrics</SectionTitle>
          <VariantGenotypeQualityMetrics variant={variant} />
        </QualityMetricsSection>
        <QualityMetricsSection>
          <SectionTitle>Site Quality Metrics</SectionTitle>
          <VariantSiteQualityMetrics variant={variant} />
        </QualityMetricsSection>
      </QualityMetricsWrapper>

    </Container>
  );
}

export default VariantPage;
