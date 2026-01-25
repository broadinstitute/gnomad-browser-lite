import { useState, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import type { Variant } from '../api/types';
import { Grid, Cell, NumericCell, renderAlleleFrequencyCell } from './Grid';
import type { GridColumn, GridRef } from './Grid';

const TableContainer = styled.div`
  margin-top: 1rem;
`;

const TableHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
  flex-wrap: wrap;
  gap: 1rem;
`;

const SearchInput = styled.input`
  width: 300px;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;

  &:focus {
    outline: none;
    border-color: #4a90d9;
    box-shadow: 0 0 0 2px rgba(74, 144, 217, 0.2);
  }
`;

const Stats = styled.div`
  color: #666;
  font-size: 14px;
`;

const VariantLink = styled(Link)`
  color: #185da8;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`;

const ConsequenceMarker = styled.span<{ $color: string }>`
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: ${props => props.$color};
  margin-right: 6px;
`;

const RsidCell = styled(Cell)`
  color: #185da8;
`;

const SelectionCheckbox = styled.input`
  cursor: pointer;
  width: 16px;
  height: 16px;
  accent-color: #1976d2;
`;

const SelectionHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`;

const ClearButton = styled.button`
  padding: 2px 6px;
  font-size: 10px;
  border: 1px solid #ddd;
  border-radius: 3px;
  background: #fff;
  color: #666;
  cursor: pointer;

  &:hover {
    background: #f5f5f5;
    border-color: #ccc;
  }
`;

const SelectionCount = styled.span`
  font-size: 11px;
  color: #1976d2;
  font-weight: 500;
`;

interface VariantsTableProps {
  variants: Variant[];
  highlightedVariantId?: string;
  onHoverVariant?: (variantId: string | null) => void;
  /** Set of selected variant IDs */
  selectedVariantIds?: Set<string>;
  /** Callback when a variant selection is toggled */
  onToggleSelection?: (variantId: string) => void;
  /** Callback to clear all selections */
  onClearSelection?: () => void;
}

// Consequence category colors (matching gnomAD)
const categoryColors: Record<string, string> = {
  lof: '#DD2C00',
  missense: 'orange',
  synonymous: '#2E7D32',
  other: '#424242',
};

function getConsequenceCategory(consequence: string | undefined): string {
  if (!consequence) return 'other';
  const lower = consequence.toLowerCase();

  if (lower.includes('frameshift') ||
      lower.includes('stop_gained') ||
      lower.includes('splice_acceptor') ||
      lower.includes('splice_donor') ||
      lower.includes('start_lost') ||
      lower.includes('stop_lost')) {
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

function getConsequenceColor(consequence: string | undefined): string {
  const category = getConsequenceCategory(consequence);
  return categoryColors[category] || categoryColors.other;
}

function formatConsequence(consequence: string | undefined): string {
  if (!consequence) return '';
  // Convert snake_case to Title Case
  return consequence
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function getVariantId(v: Variant): string {
  if (v.variant_id) return v.variant_id;
  const chrom = v.chrom || v.locus?.contig || '';
  const pos = v.pos || v.locus?.position || 0;
  const alleles = v.alleles || [];
  return `${chrom}-${pos}-${alleles.join('-')}`;
}

function getPosition(v: Variant): number | undefined {
  return v.pos || v.locus?.position;
}

function getRsid(v: Variant): string | undefined {
  if (v.rsids && v.rsids.length > 0) {
    return v.rsids[0];
  }
  return v.rsid;
}

function getRsids(v: Variant): string[] {
  if (v.rsids && v.rsids.length > 0) {
    return v.rsids;
  }
  return v.rsid ? [v.rsid] : [];
}

// Define columns
const createColumns = (
  selectedIds?: Set<string>,
  onToggle?: (id: string) => void
): GridColumn<Variant>[] => [
  // Selection checkbox column
  ...(onToggle ? [{
    key: 'select',
    heading: '',
    minWidth: 32,
    grow: 0,
    isSortable: false,
    render: (row: Variant) => {
      const variantId = getVariantId(row);
      const isSelected = selectedIds?.has(variantId) || false;
      return (
        <Cell style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <SelectionCheckbox
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggle(variantId)}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          />
        </Cell>
      );
    },
  }] : []),
  {
    key: 'variant_id',
    heading: 'Variant ID',
    minWidth: 120,
    grow: 1,
    isSortable: true,
    isRowHeader: true,
    render: (row) => (
      <Cell>
        <VariantLink to={`/variant/${getVariantId(row)}`} title={getVariantId(row)}>
          {getVariantId(row)}
        </VariantLink>
      </Cell>
    ),
  },
  {
    key: 'hgvs',
    heading: 'HGVS Consequence',
    minWidth: 100,
    grow: 0,
    isSortable: true,
    render: (row) => (
      <Cell title={row.hgvsc || row.hgvsp || ''}>
        {row.hgvsc || row.hgvsp || ''}
      </Cell>
    ),
  },
  {
    key: 'consequence',
    heading: 'VEP Annotation',
    minWidth: 100,
    grow: 0,
    isSortable: true,
    render: (row) => (
      <Cell>
        <ConsequenceMarker $color={getConsequenceColor(row.consequence)} />
        {formatConsequence(row.consequence)}
      </Cell>
    ),
  },
  {
    key: 'rsid',
    heading: 'rsIDs',
    minWidth: 70,
    grow: 0,
    isSortable: false,
    render: (row) => {
      const rsids = getRsids(row);
      return (
        <RsidCell title={rsids.join(', ')}>
          {rsids.join(', ') || ''}
        </RsidCell>
      );
    },
  },
  {
    key: 'ac',
    heading: 'AC',
    tooltip: 'Allele Count - Alternate allele count in high quality genotypes',
    minWidth: 70,
    grow: 0,
    isSortable: true,
    align: 'right',
    render: (row) => (
      <NumericCell>
        {row.ac != null ? row.ac.toLocaleString() : ''}
      </NumericCell>
    ),
  },
  {
    key: 'an',
    heading: 'AN',
    tooltip: 'Allele Number - Total number of called high quality genotypes',
    minWidth: 70,
    grow: 0,
    isSortable: true,
    align: 'right',
    render: (row) => (
      <NumericCell>
        {row.an != null ? row.an.toLocaleString() : ''}
      </NumericCell>
    ),
  },
  {
    key: 'af',
    heading: 'AF',
    tooltip: 'Allele Frequency - Alternate allele frequency in high quality genotypes',
    minWidth: 90,
    grow: 1,
    isSortable: true,
    align: 'right',
    render: (row) => renderAlleleFrequencyCell(row as unknown as Record<string, unknown>, 'af'),
  },
];

// Sort comparison functions
function compareValues<T>(a: T, b: T, ascending: boolean): number {
  if (a == null && b == null) return 0;
  if (a == null) return ascending ? 1 : -1;
  if (b == null) return ascending ? -1 : 1;

  if (typeof a === 'number' && typeof b === 'number') {
    return ascending ? a - b : b - a;
  }

  const strA = String(a);
  const strB = String(b);
  return ascending ? strA.localeCompare(strB) : strB.localeCompare(strA);
}

export function VariantsTable({
  variants,
  highlightedVariantId,
  onHoverVariant,
  selectedVariantIds,
  onToggleSelection,
  onClearSelection,
}: VariantsTableProps) {
  const gridRef = useRef<GridRef>(null);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<string>('variant_id');
  const [sortOrder, setSortOrder] = useState<'ascending' | 'descending'>('ascending');

  const columns = useMemo(
    () => createColumns(selectedVariantIds, onToggleSelection),
    [selectedVariantIds, onToggleSelection]
  );

  // Filter variants
  const filteredVariants = useMemo(() => {
    if (!filter) return variants;
    const lowerFilter = filter.toLowerCase();
    return variants.filter((v) => {
      const id = getVariantId(v).toLowerCase();
      const consequence = (v.consequence || '').toLowerCase();
      const rsid = (getRsid(v) || '').toLowerCase();
      const hgvs = (v.hgvsc || v.hgvsp || '').toLowerCase();
      return (
        id.includes(lowerFilter) ||
        consequence.includes(lowerFilter) ||
        rsid.includes(lowerFilter) ||
        hgvs.includes(lowerFilter)
      );
    });
  }, [variants, filter]);

  // Sort variants
  const sortedVariants = useMemo(() => {
    const sorted = [...filteredVariants];
    const ascending = sortOrder === 'ascending';

    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'variant_id':
          return compareValues(getPosition(a), getPosition(b), ascending);
        case 'consequence':
          return compareValues(a.consequence, b.consequence, ascending);
        case 'hgvs':
          return compareValues(a.hgvsc || a.hgvsp, b.hgvsc || b.hgvsp, ascending);
        case 'ac':
          return compareValues(a.ac, b.ac, ascending);
        case 'an':
          return compareValues(a.an, b.an, ascending);
        case 'af':
          return compareValues(a.af, b.af, ascending);
        default:
          return 0;
      }
    });

    return sorted;
  }, [filteredVariants, sortKey, sortOrder]);

  // Handle sort request
  const handleRequestSort = useCallback((key: string) => {
    if (key === sortKey) {
      setSortOrder(prev => prev === 'ascending' ? 'descending' : 'ascending');
    } else {
      setSortKey(key);
      setSortOrder('ascending');
    }
  }, [sortKey]);

  // Handle row hover
  const handleHoverRow = useCallback((index: number | null) => {
    if (onHoverVariant) {
      if (index === null) {
        onHoverVariant(null);
      } else {
        const variant = sortedVariants[index];
        onHoverVariant(variant ? getVariantId(variant) : null);
      }
    }
  }, [sortedVariants, onHoverVariant]);

  // Check if row should be highlighted
  const shouldHighlightRow = useCallback((variant: Variant) => {
    if (!highlightedVariantId) return false;
    return getVariantId(variant) === highlightedVariantId;
  }, [highlightedVariantId]);

  return (
    <TableContainer>
      <TableHeader>
        <SearchInput
          type="text"
          placeholder="Search variant table..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <SelectionHeader>
          {selectedVariantIds && selectedVariantIds.size > 0 && (
            <>
              <SelectionCount>
                {selectedVariantIds.size} selected
              </SelectionCount>
              {onClearSelection && (
                <ClearButton onClick={onClearSelection}>
                  Clear
                </ClearButton>
              )}
            </>
          )}
        </SelectionHeader>
        <Stats>
          {filter
            ? `Showing ${sortedVariants.length.toLocaleString()} of ${variants.length.toLocaleString()} variants`
            : `${variants.length.toLocaleString()} variants`
          }
        </Stats>
      </TableHeader>

      <Grid<Variant>
        ref={gridRef}
        columns={columns}
        data={sortedVariants}
        rowKey={getVariantId}
        rowHeight={28}
        numRowsRendered={20}
        sortKey={sortKey}
        sortOrder={sortOrder}
        onRequestSort={handleRequestSort}
        onHoverRow={handleHoverRow}
        shouldHighlightRow={shouldHighlightRow}
      />
    </TableContainer>
  );
}

export default VariantsTable;
