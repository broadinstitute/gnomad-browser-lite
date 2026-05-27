import styled from 'styled-components';
import type { GeneConstraint } from '../api/types';

const Table = styled.table`
  border-collapse: collapse;
  width: 100%;
  max-width: 700px;
  font-size: 14px;

  th, td {
    padding: 6px 12px;
    text-align: right;
    border-bottom: 1px solid #e0e0e0;
  }

  th {
    font-weight: 600;
    background: #f5f5f5;
  }

  th:first-child, td:first-child {
    text-align: left;
  }

  tbody tr:hover {
    background: #f9f9f9;
  }
`;

const OEBar = styled.span<{ $lower: number; $upper: number; $value: number; $color?: string }>`
  display: inline-block;
  position: relative;
  width: 60px;
  height: 14px;
  vertical-align: middle;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    height: 100%;
    background: #ccc;
    left: ${p => Math.max(0, p.$lower * 100)}%;
    width: ${p => Math.min(100, p.$upper * 100) - Math.max(0, p.$lower * 100)}%;
  }

  &::after {
    content: '';
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${p => p.$color || '#333'};
    border: 1px solid #000;
    left: ${p => Math.min(100, Math.max(0, p.$value * 100))}%;
  }
`;

const FlagBadge = styled.span`
  display: inline-block;
  background: #e3f2fd;
  color: #1565c0;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 12px;
  margin: 2px 4px 2px 0;
`;

const FlagsRow = styled.div`
  margin-top: 0.5rem;
  font-size: 13px;
`;

function fmt(n: number | undefined | null, precision = 2): string {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(precision);
}

function getLoeufColor(upper: number | undefined | null): string | undefined {
  if (upper == null) return undefined;
  if (upper < 0.33) return '#ff2600';
  if (upper < 0.66) return '#ff9300';
  if (upper < 1) return '#ffc000';
  return undefined;
}

interface ConstraintTableProps {
  constraint: GeneConstraint;
}

export function ConstraintTable({ constraint }: ConstraintTableProps) {
  const lofColor = getLoeufColor(constraint.oe_lof_upper);
  const flags = (constraint.flags || []).filter(f => !f.startsWith('no_'));

  return (
    <div>
      <Table>
        <thead>
          <tr>
            <th>Category</th>
            <th>Exp. SNVs</th>
            <th>Obs. SNVs</th>
            <th>o/e</th>
            <th>o/e 90% CI</th>
            <th></th>
            <th>Z</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Synonymous</td>
            <td>{fmt(constraint.exp_syn)}</td>
            <td>{constraint.obs_syn ?? '—'}</td>
            <td>{fmt(constraint.oe_syn)}</td>
            <td>
              {constraint.oe_syn_lower != null && constraint.oe_syn_upper != null
                ? `${fmt(constraint.oe_syn_lower)} – ${fmt(constraint.oe_syn_upper)}`
                : '—'}
            </td>
            <td>
              {constraint.oe_syn != null && constraint.oe_syn_lower != null && constraint.oe_syn_upper != null && (
                <OEBar $lower={constraint.oe_syn_lower} $upper={constraint.oe_syn_upper} $value={constraint.oe_syn} />
              )}
            </td>
            <td style={{ color: (constraint.syn_z ?? 0) > 3.71 ? '#ff2600' : undefined }}>
              {fmt(constraint.syn_z)}
            </td>
          </tr>
          <tr>
            <td>Missense</td>
            <td>{fmt(constraint.exp_mis)}</td>
            <td>{constraint.obs_mis ?? '—'}</td>
            <td>{fmt(constraint.oe_mis)}</td>
            <td>
              {constraint.oe_mis_lower != null && constraint.oe_mis_upper != null
                ? `${fmt(constraint.oe_mis_lower)} – ${fmt(constraint.oe_mis_upper)}`
                : '—'}
            </td>
            <td>
              {constraint.oe_mis != null && constraint.oe_mis_lower != null && constraint.oe_mis_upper != null && (
                <OEBar $lower={constraint.oe_mis_lower} $upper={constraint.oe_mis_upper} $value={constraint.oe_mis} />
              )}
            </td>
            <td style={{ color: (constraint.mis_z ?? 0) > 3.09 ? '#ff9300' : undefined }}>
              {fmt(constraint.mis_z)}
            </td>
          </tr>
          <tr>
            <td>pLoF</td>
            <td>{fmt(constraint.exp_lof)}</td>
            <td>{constraint.obs_lof ?? '—'}</td>
            <td>{fmt(constraint.oe_lof)}</td>
            <td>
              {constraint.oe_lof_lower != null && constraint.oe_lof_upper != null
                ? `${fmt(constraint.oe_lof_lower)} – ${fmt(constraint.oe_lof_upper)}`
                : '—'}
            </td>
            <td>
              {constraint.oe_lof != null && constraint.oe_lof_lower != null && constraint.oe_lof_upper != null && (
                <OEBar $lower={constraint.oe_lof_lower} $upper={constraint.oe_lof_upper} $value={constraint.oe_lof} $color={lofColor} />
              )}
            </td>
            <td>
              pLI = {fmt(constraint.pli)}
            </td>
          </tr>
        </tbody>
      </Table>
      {flags.length > 0 && (
        <FlagsRow>
          {flags.map(flag => (
            <FlagBadge key={flag}>{flag.replace(/_/g, ' ')}</FlagBadge>
          ))}
        </FlagsRow>
      )}
    </div>
  );
}
