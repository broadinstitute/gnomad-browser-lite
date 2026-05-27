import React from 'react'
import styled from 'styled-components'

const Badge = styled.span<{ level?: string }>`
  display: inline-block;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
  background: ${p => p.level === 'warning' ? '#fff3e0' : p.level === 'info' ? '#e3f2fd' : '#f5f5f5'};
  color: ${p => p.level === 'warning' ? '#e65100' : p.level === 'info' ? '#1976d2' : '#666'};
  border: 1px solid ${p => p.level === 'warning' ? '#ffcc02' : p.level === 'info' ? '#90caf9' : '#e0e0e0'};
`

const ExternalLink = styled.a.attrs({ target: '_blank', rel: 'noopener noreferrer' })`
  color: #0d79d0;
  text-decoration: none;
  &:hover { text-decoration: underline; }
`

const CardWrapper = styled.div`
  background: #ffffff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 20px;
  margin: 10px 0;
  width: 100%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
`

const CardHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 15px;
`

const VariantTitle = styled.h3`
  margin: 0;
  font-size: 1.1em;
  font-weight: 600;
  color: #333;
`

const VariantSubtitle = styled.div`
  color: #666;
  font-size: 0.9em;
  margin-top: 5px;
`

const Section = styled.div`
  margin-top: 15px;
`

const SectionTitle = styled.h4`
  margin: 0 0 10px 0;
  font-size: 0.9em;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.05em;
`

const FrequencyGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin-top: 10px;
`

const FrequencyItem = styled.div`
  background: #f8f8f8;
  padding: 10px;
  border-radius: 4px;
`

const FrequencyLabel = styled.div`
  font-size: 0.8em;
  color: #666;
  margin-bottom: 2px;
`

const FrequencyValue = styled.div`
  font-size: 1.1em;
  font-weight: 600;
  color: #333;
`

const ActionBar = styled.div`
  display: flex;
  gap: 10px;
  margin-top: 20px;
  padding-top: 15px;
  border-top: 1px solid #e0e0e0;
`

const ActionButton = styled.button`
  padding: 8px 16px;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  background: white;
  cursor: pointer;
  font-size: 14px;

  &:hover {
    background: #f7f7f7;
    border-color: #0d79d0;
  }
`

const AttrList = styled.dl`
  margin: 0;
  padding: 0;
`

const AttrItem = styled.div`
  display: flex;
  gap: 8px;
  padding: 4px 0;
  font-size: 14px;
`

const AttrLabel = styled.dt`
  font-weight: 600;
  color: #666;
  min-width: 60px;
`

const AttrValue = styled.dd`
  margin: 0;
  color: #333;
`

interface VariantData {
  variant_id: string
  reference_genome?: string
  chrom?: string
  pos?: number
  ref?: string
  alt?: string
  rsids?: string[]
  flags?: string[]
  exome?: {
    ac: number
    an: number
    af?: number
    homozygote_count: number
    hemizygote_count?: number
    faf95?: { popmax: number; popmax_population: string }
    populations?: Array<{ id: string; ac: number; an: number; homozygote_count: number }>
  }
  genome?: {
    ac: number
    an: number
    af?: number
    homozygote_count: number
    hemizygote_count?: number
    faf95?: { popmax: number; popmax_population: string }
    populations?: Array<{ id: string; ac: number; an: number; homozygote_count: number }>
  }
  transcript_consequences?: Array<{
    gene_id: string
    gene_symbol: string
    transcript_id: string
    consequence_terms: string[]
    major_consequence: string
    is_canonical: boolean
    hgvs?: string
    hgvsc?: string
    hgvsp?: string
    lof?: string
    lof_flags?: string
    lof_filter?: string
  }>
  in_silico_predictors?: Array<{
    id: string
    value: string
    flags?: string[]
  }>
}

interface VariantCardProps {
  variant: VariantData
  onViewDetails?: () => void
  onNavigateToVariant?: () => void
}

const formatFrequency = (frequency: number): string => {
  if (frequency === 0) return '0'
  if (frequency < 0.00001) return frequency.toExponential(2)
  return frequency.toFixed(5)
}

const calculateAF = (ac: number, an: number): number => {
  return an > 0 ? ac / an : 0
}

const VariantCard: React.FC<VariantCardProps> = ({
  variant,
  onViewDetails,
  onNavigateToVariant
}) => {
  const canonicalTranscript = variant.transcript_consequences?.find(t => t.is_canonical) || variant.transcript_consequences?.[0]
  const exomeAF = variant.exome ? calculateAF(variant.exome.ac, variant.exome.an) : undefined
  const genomeAF = variant.genome ? calculateAF(variant.genome.ac, variant.genome.an) : undefined
  const hasExomeData = variant.exome && variant.exome.an > 0
  const hasGenomeData = variant.genome && variant.genome.an > 0

  return (
    <CardWrapper>
      <CardHeader>
        <div>
          <VariantTitle>{variant.variant_id}</VariantTitle>
          <VariantSubtitle>
            {canonicalTranscript?.gene_symbol && (
              <>
                {canonicalTranscript.gene_symbol}
                {canonicalTranscript.major_consequence && ` \u2022 ${canonicalTranscript.major_consequence.replace(/_/g, ' ')}`}
              </>
            )}
          </VariantSubtitle>
        </div>
        {variant.flags && variant.flags.length > 0 && (
          <div>
            {variant.flags.map((flag) => (
              <Badge key={flag} level="warning" style={{ marginLeft: 5 }}>
                {flag}
              </Badge>
            ))}
          </div>
        )}
      </CardHeader>

      <AttrList>
        {canonicalTranscript?.hgvsp && (
          <AttrItem>
            <AttrLabel>HGVSp</AttrLabel>
            <AttrValue>{canonicalTranscript.hgvsp}</AttrValue>
          </AttrItem>
        )}
        {canonicalTranscript?.hgvsc && (
          <AttrItem>
            <AttrLabel>HGVSc</AttrLabel>
            <AttrValue>{canonicalTranscript.hgvsc}</AttrValue>
          </AttrItem>
        )}
        {variant.rsids && variant.rsids.length > 0 && (
          <AttrItem>
            <AttrLabel>rsID</AttrLabel>
            <AttrValue>
              {variant.rsids.map((rsid, index) => (
                <React.Fragment key={rsid}>
                  {index > 0 && ', '}
                  <ExternalLink href={`https://www.ncbi.nlm.nih.gov/snp/${rsid}`}>
                    {rsid}
                  </ExternalLink>
                </React.Fragment>
              ))}
            </AttrValue>
          </AttrItem>
        )}
      </AttrList>

      {(hasExomeData || hasGenomeData) && (
        <Section>
          <SectionTitle>Allele Frequency</SectionTitle>
          <FrequencyGrid>
            {hasExomeData && (
              <>
                <FrequencyItem>
                  <FrequencyLabel>Exome AF</FrequencyLabel>
                  <FrequencyValue>{formatFrequency(exomeAF!)}</FrequencyValue>
                </FrequencyItem>
                <FrequencyItem>
                  <FrequencyLabel>Exome AC/AN</FrequencyLabel>
                  <FrequencyValue>{variant.exome!.ac} / {variant.exome!.an}</FrequencyValue>
                </FrequencyItem>
                {variant.exome!.homozygote_count !== undefined && (
                  <FrequencyItem>
                    <FrequencyLabel>Exome Homozygotes</FrequencyLabel>
                    <FrequencyValue>{variant.exome!.homozygote_count}</FrequencyValue>
                  </FrequencyItem>
                )}
              </>
            )}
            {hasGenomeData && (
              <>
                <FrequencyItem>
                  <FrequencyLabel>Genome AF</FrequencyLabel>
                  <FrequencyValue>{formatFrequency(genomeAF!)}</FrequencyValue>
                </FrequencyItem>
                <FrequencyItem>
                  <FrequencyLabel>Genome AC/AN</FrequencyLabel>
                  <FrequencyValue>{variant.genome!.ac} / {variant.genome!.an}</FrequencyValue>
                </FrequencyItem>
                {variant.genome!.homozygote_count !== undefined && (
                  <FrequencyItem>
                    <FrequencyLabel>Genome Homozygotes</FrequencyLabel>
                    <FrequencyValue>{variant.genome!.homozygote_count}</FrequencyValue>
                  </FrequencyItem>
                )}
              </>
            )}
          </FrequencyGrid>

          {(variant.exome?.faf95 || variant.genome?.faf95) && (
            <FrequencyGrid style={{ marginTop: '10px' }}>
              {variant.exome?.faf95 && (
                <FrequencyItem>
                  <FrequencyLabel>Exome FAF95 ({variant.exome.faf95.popmax_population})</FrequencyLabel>
                  <FrequencyValue>{formatFrequency(variant.exome.faf95.popmax)}</FrequencyValue>
                </FrequencyItem>
              )}
              {variant.genome?.faf95 && (
                <FrequencyItem>
                  <FrequencyLabel>Genome FAF95 ({variant.genome.faf95.popmax_population})</FrequencyLabel>
                  <FrequencyValue>{formatFrequency(variant.genome.faf95.popmax)}</FrequencyValue>
                </FrequencyItem>
              )}
            </FrequencyGrid>
          )}
        </Section>
      )}

      {variant.in_silico_predictors && variant.in_silico_predictors.length > 0 && (
        <Section>
          <SectionTitle>In Silico Predictors</SectionTitle>
          <AttrList>
            {variant.in_silico_predictors.map((predictor) => (
              <AttrItem key={predictor.id}>
                <AttrLabel>{predictor.id.toUpperCase()}</AttrLabel>
                <AttrValue>
                  {predictor.value}
                  {predictor.flags && predictor.flags.length > 0 && (
                    <span style={{ marginLeft: '10px' }}>
                      {predictor.flags.map((flag) => (
                        <Badge key={flag} level="info" style={{ marginLeft: 5 }}>
                          {flag}
                        </Badge>
                      ))}
                    </span>
                  )}
                </AttrValue>
              </AttrItem>
            ))}
          </AttrList>
        </Section>
      )}

      <ActionBar>
        {onNavigateToVariant && (
          <ActionButton onClick={onNavigateToVariant}>
            View in Browser
          </ActionButton>
        )}
        {onViewDetails && (
          <ActionButton onClick={onViewDetails}>
            More Details
          </ActionButton>
        )}
      </ActionBar>
    </CardWrapper>
  )
}

export default VariantCard
