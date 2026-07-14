import styled from 'styled-components';
import type { QCTier } from '../../api/types';
import type { TierMeta } from '../../qc/checkCatalog';

export interface TierProgress {
  total: number;
  implemented: number;
  pass: number;
  warn: number;
  fail: number;
}

const Rail = styled.nav`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
`;

const Step = styled.button<{ $active: boolean; $future: boolean }>`
  position: relative;
  text-align: left;
  width: 100%;
  border: 1px solid ${(p) => (p.$active ? 'var(--accent-color, #0066cc)' : '#e0e0e0')};
  border-radius: 8px;
  background: ${(p) => (p.$active ? '#f2f7ff' : '#fff')};
  padding: 0.85rem 1rem;
  cursor: pointer;
  opacity: ${(p) => (p.$future ? 0.7 : 1)};
  transition: border-color 0.12s ease, background 0.12s ease;

  &:hover {
    border-color: var(--accent-color, #0066cc);
  }
`;

const StepTop = styled.div`
  display: flex;
  align-items: center;
  gap: 0.6rem;
`;

const StepNumber = styled.span<{ $active: boolean }>`
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  background: ${(p) => (p.$active ? 'var(--accent-color, #0066cc)' : '#eceff3')};
  color: ${(p) => (p.$active ? '#fff' : '#667')};
`;

const StepTitle = styled.span`
  font-weight: 600;
  font-size: 0.95rem;
`;

const FutureTag = styled.span`
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  color: #888;
  background: #eee;
  border-radius: 4px;
  padding: 1px 6px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
`;

const StepSubtitle = styled.p`
  margin: 0.4rem 0 0;
  font-size: 12px;
  color: #777;
  line-height: 1.4;
`;

const ProgressRow = styled.div`
  margin-top: 0.55rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 12px;
  color: #666;
`;

const Bar = styled.div`
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: #ececec;
  overflow: hidden;
`;

const BarFill = styled.div<{ $pct: number }>`
  height: 100%;
  width: ${(p) => p.$pct}%;
  background: var(--accent-color, #0066cc);
`;

const MiniCounts = styled.div`
  display: flex;
  gap: 0.4rem;
  margin-top: 0.4rem;
  font-size: 11px;
  font-weight: 600;
`;

const Count = styled.span<{ $color: string }>`
  color: ${(p) => p.$color};
`;

interface QCStepperProps {
  tiers: TierMeta[];
  progress: Record<number, TierProgress>;
  currentTier: QCTier;
  onSelect: (tier: QCTier) => void;
}

export function QCStepper({ tiers, progress, currentTier, onSelect }: QCStepperProps) {
  return (
    <Rail aria-label="QC check tiers">
      {tiers.map((t, i) => {
        const p = progress[t.tier] ?? { total: 0, implemented: 0, pass: 0, warn: 0, fail: 0 };
        const pct = p.total > 0 ? Math.round((p.implemented / p.total) * 100) : 0;
        const active = t.tier === currentTier;
        return (
          <Step
            key={t.tier}
            $active={active}
            $future={!!t.future}
            aria-current={active ? 'step' : undefined}
            onClick={() => onSelect(t.tier)}
          >
            <StepTop>
              <StepNumber $active={active}>{i + 1}</StepNumber>
              <StepTitle>
                Tier {t.tier} — {t.title}
              </StepTitle>
              {t.future && <FutureTag>Future</FutureTag>}
            </StepTop>
            <StepSubtitle>{t.subtitle}</StepSubtitle>
            <ProgressRow>
              <Bar>
                <BarFill $pct={pct} />
              </Bar>
              <span>
                {p.implemented}/{p.total} live
              </span>
            </ProgressRow>
            {(p.pass > 0 || p.warn > 0 || p.fail > 0) && (
              <MiniCounts>
                {p.pass > 0 && <Count $color="#1e7e34">{p.pass} pass</Count>}
                {p.warn > 0 && <Count $color="#a56100">{p.warn} warn</Count>}
                {p.fail > 0 && <Count $color="#c62828">{p.fail} fail</Count>}
              </MiniCounts>
            )}
          </Step>
        );
      })}
    </Rail>
  );
}

export default QCStepper;
