import { useState, useMemo } from 'react';
import styled from 'styled-components';
import type { Variant } from '../api/types';

const TableContainer = styled.div`
  overflow-x: auto;
  margin-top: 1rem;
`;

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
`;

const Th = styled.th`
  background: #f5f5f5;
  border: 1px solid #ddd;
  padding: 8px 12px;
  text-align: left;
  position: sticky;
  top: 0;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: #e8e8e8;
  }
`;

const Td = styled.td`
  border: 1px solid #ddd;
  padding: 8px 12px;
  white-space: nowrap;
`;

const Tr = styled.tr`
  &:nth-child(even) {
    background: #fafafa;
  }

  &:hover {
    background: #f0f0f0;
  }
`;

const FilterInput = styled.input`
  width: 100%;
  padding: 8px;
  margin-bottom: 1rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
`;

const Stats = styled.div`
  margin-bottom: 1rem;
  color: #666;
  font-size: 14px;
`;

interface VariantsTableProps {
  variants: Variant[];
}

function getVariantId(v: Variant): string {
  if (v.variant_id) return v.variant_id;
  const locus = v.locus || {};
  const chrom = locus.contig || v.contig || '';
  const pos = locus.position || v.position || 0;
  const alleles = v.alleles || [];
  return `${chrom}-${pos}-${alleles.join('-')}`;
}

function getFrequency(v: Variant): number | null {
  if (v.af !== undefined) return v.af;
  if (v.freq?.AF !== undefined) return v.freq.AF;
  if (v.ac !== undefined && v.an !== undefined && v.an > 0) {
    return v.ac / v.an;
  }
  if (v.freq?.AC !== undefined && v.freq?.AN !== undefined && v.freq.AN > 0) {
    return v.freq.AC / v.freq.AN;
  }
  return null;
}

function formatFrequency(af: number | null): string {
  if (af === null) return '-';
  if (af === 0) return '0';
  if (af < 0.0001) return af.toExponential(2);
  return af.toFixed(6);
}

function getAlleleCount(v: Variant): number | null {
  if (v.ac !== undefined) return v.ac;
  if (v.freq?.AC !== undefined) return v.freq.AC;
  return null;
}

function getAlleleNumber(v: Variant): number | null {
  if (v.an !== undefined) return v.an;
  if (v.freq?.AN !== undefined) return v.freq.AN;
  return null;
}

export function VariantsTable({ variants }: VariantsTableProps) {
  const [filter, setFilter] = useState('');
  const [sortField, setSortField] = useState<string>('position');
  const [sortAsc, setSortAsc] = useState(true);

  const filteredVariants = useMemo(() => {
    if (!filter) return variants;
    const lowerFilter = filter.toLowerCase();
    return variants.filter((v) => {
      const id = getVariantId(v).toLowerCase();
      const consequence = (v.consequence || '').toLowerCase();
      const rsid = (v.rsid || '').toLowerCase();
      return (
        id.includes(lowerFilter) ||
        consequence.includes(lowerFilter) ||
        rsid.includes(lowerFilter)
      );
    });
  }, [variants, filter]);

  const sortedVariants = useMemo(() => {
    const sorted = [...filteredVariants];
    sorted.sort((a, b) => {
      let aVal: number | string | null;
      let bVal: number | string | null;

      switch (sortField) {
        case 'position':
          aVal = (a.locus?.position || a.position || 0) as number;
          bVal = (b.locus?.position || b.position || 0) as number;
          break;
        case 'af':
          aVal = getFrequency(a);
          bVal = getFrequency(b);
          if (aVal === null) aVal = -1;
          if (bVal === null) bVal = -1;
          break;
        case 'consequence':
          aVal = a.consequence || '';
          bVal = b.consequence || '';
          break;
        default:
          aVal = 0;
          bVal = 0;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortAsc
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return sorted;
  }, [filteredVariants, sortField, sortAsc]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const sortIndicator = (field: string) => {
    if (sortField !== field) return '';
    return sortAsc ? ' ↑' : ' ↓';
  };

  return (
    <div>
      <FilterInput
        type="text"
        placeholder="Filter variants by ID, rsID, or consequence..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <Stats>
        Showing {sortedVariants.length} of {variants.length} variants
      </Stats>

      <TableContainer>
        <Table>
          <thead>
            <tr>
              <Th>Variant ID</Th>
              <Th onClick={() => handleSort('position')}>
                Position{sortIndicator('position')}
              </Th>
              <Th>rsID</Th>
              <Th onClick={() => handleSort('consequence')}>
                Consequence{sortIndicator('consequence')}
              </Th>
              <Th>AC</Th>
              <Th>AN</Th>
              <Th onClick={() => handleSort('af')}>
                AF{sortIndicator('af')}
              </Th>
            </tr>
          </thead>
          <tbody>
            {sortedVariants.slice(0, 500).map((v, idx) => {
              const id = getVariantId(v);
              const af = getFrequency(v);
              const ac = getAlleleCount(v);
              const an = getAlleleNumber(v);
              const pos = v.locus?.position || (v.position as number | undefined);

              return (
                <Tr key={id || idx}>
                  <Td>{id}</Td>
                  <Td>{pos ?? '-'}</Td>
                  <Td>{v.rsid || '-'}</Td>
                  <Td>{v.consequence || '-'}</Td>
                  <Td>{ac ?? '-'}</Td>
                  <Td>{an ?? '-'}</Td>
                  <Td>{formatFrequency(af)}</Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableContainer>

      {sortedVariants.length > 500 && (
        <Stats>Showing first 500 variants. Use filter to narrow results.</Stats>
      )}
    </div>
  );
}

export default VariantsTable;
