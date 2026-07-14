import styled from 'styled-components';
import type { CheckStatus } from '../../api/types';

interface StatusStyle {
  bg: string;
  fg: string;
  label: string;
  dot: string;
}

// pass=green / warn=amber / fail=red / pending=grey
const STYLES: Record<CheckStatus, StatusStyle> = {
  pass: { bg: '#e6f4ea', fg: '#1e7e34', dot: '#28a745', label: 'Pass' },
  warn: { bg: '#fff4e0', fg: '#a56100', dot: '#f0a500', label: 'Warn' },
  fail: { bg: '#fdeaea', fg: '#c62828', dot: '#dc3545', label: 'Fail' },
  pending: { bg: '#f0f0f0', fg: '#777', dot: '#bbb', label: 'Not yet implemented' },
};

const Chip = styled.span<{ $style: StatusStyle }>`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.6;
  white-space: nowrap;
  background: ${(p) => p.$style.bg};
  color: ${(p) => p.$style.fg};

  &::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${(p) => p.$style.dot};
    flex: 0 0 auto;
  }
`;

interface StatusBadgeProps {
  status: CheckStatus;
  /** Override the default label text. */
  label?: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const s = STYLES[status];
  return <Chip $style={s}>{label ?? s.label}</Chip>;
}

export default StatusBadge;
