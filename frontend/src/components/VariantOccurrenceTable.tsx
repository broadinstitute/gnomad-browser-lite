import styled from 'styled-components';

const Table = styled.table`
  margin-top: 1.25em;

  th {
    font-weight: bold;
  }

  th[scope='col'] {
    padding-left: 30px;
    text-align: left;
  }

  th[scope='row'] {
    text-align: right;
  }

  td {
    padding-left: 30px;
    line-height: 1.5;
  }
`;

const TooltipHint = styled.span`
  background-image: linear-gradient(to right, #000 75%, transparent 75%);
  background-position: 0 1.15em;
  background-size: 4px 2px;
  background-repeat: repeat-x;
  cursor: help;
`;

const NoWrap = styled.span`
  white-space: nowrap;
`;

const Badge = styled.span<{ $level: 'success' | 'warning' | 'error' }>`
  display: inline-block;
  padding: 0.25em 0.5em;
  border-radius: 0.25em;
  font-size: 0.875em;
  font-weight: bold;
  background: ${props => {
    switch (props.$level) {
      case 'success': return '#4caf50';
      case 'warning': return '#ff9800';
      case 'error': return '#f44336';
      default: return '#9e9e9e';
    }
  }};
  color: white;
`;

type VariantOccurrenceTableProps = {
  ac?: number;
  an?: number;
  homozygoteCount?: number;
  hemizygoteCount?: number;
  faf95?: number;
  faf95PopMax?: string;
  filters?: string[];
  chrom?: string;
};

// Population display names for FAF
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
};

export function VariantOccurrenceTable({
  ac,
  an,
  homozygoteCount,
  hemizygoteCount,
  faf95,
  faf95PopMax,
  filters,
  chrom,
}: VariantOccurrenceTableProps) {
  const af = an && an > 0 ? ac! / an : 0;
  const showHemizygotes = chrom === 'X' || chrom === 'chrX' || chrom === 'Y' || chrom === 'chrY';
  const isYChrom = chrom === 'Y' || chrom === 'chrY';

  const renderFilters = () => {
    if (!filters || filters.length === 0) {
      return <Badge $level="success">Pass</Badge>;
    }
    return filters.map(f => (
      <Badge key={f} $level="warning" style={{ marginRight: 4 }}>
        {f}
      </Badge>
    ));
  };

  const renderFaf = () => {
    if (faf95 === undefined || faf95 === null || faf95 === 0) {
      return '—';
    }
    const popName = faf95PopMax ? POPULATION_NAMES[faf95PopMax.toLowerCase()] || faf95PopMax : '';
    return (
      <span title={popName}>
        <TooltipHint>{faf95.toPrecision(4)}</TooltipHint>
      </span>
    );
  };

  return (
    <Table>
      <tbody>
        <tr>
          <td />
          <th scope="col">Total</th>
        </tr>
        <tr>
          <th scope="row">
            <TooltipHint title="Quality control filters that this variant failed (if any)">
              Filters
            </TooltipHint>
          </th>
          <td>{renderFilters()}</td>
        </tr>
        <tr>
          <th scope="row">
            <TooltipHint title="Alternate allele count in high quality genotypes">
              Allele Count
            </TooltipHint>
          </th>
          <td>{ac?.toLocaleString() ?? '—'}</td>
        </tr>
        <tr>
          <th scope="row">
            <TooltipHint title="Total number of called high quality genotypes">
              Allele Number
            </TooltipHint>
          </th>
          <td>{an?.toLocaleString() ?? '—'}</td>
        </tr>
        <tr>
          <th scope="row">
            <TooltipHint title="Alternate allele frequency in high quality genotypes">
              Allele Frequency
            </TooltipHint>
          </th>
          <td>{af > 0 ? af.toPrecision(4) : '—'}</td>
        </tr>
        <tr>
          <th scope="row">
            <NoWrap>
              Grpmax Filtering AF
            </NoWrap>
            <br />
            (95% confidence)
          </th>
          <td>{renderFaf()}</td>
        </tr>
        {!isYChrom && (
          <tr>
            <th scope="row">
              <TooltipHint title="Number of individuals homozygous for alternate allele">
                Number of homozygotes
              </TooltipHint>
            </th>
            <td>{homozygoteCount?.toLocaleString() ?? 0}</td>
          </tr>
        )}
        {showHemizygotes && (
          <tr>
            <th scope="row">
              <TooltipHint title="Number of individuals hemizygous for alternate allele">
                Number of hemizygotes
              </TooltipHint>
            </th>
            <td>{hemizygoteCount?.toLocaleString() ?? '—'}</td>
          </tr>
        )}
      </tbody>
    </Table>
  );
}

export default VariantOccurrenceTable;
