import { useCallback } from 'react';
import styled from 'styled-components';

// Consequence categories matching gnomAD
export const CONSEQUENCE_CATEGORIES = ['lof', 'missense', 'synonymous', 'other'] as const;
export type ConsequenceCategory = typeof CONSEQUENCE_CATEGORIES[number];

export const CONSEQUENCE_CATEGORY_LABELS: Record<ConsequenceCategory, string> = {
  lof: 'pLoF',
  missense: 'Missense / Inframe indel',
  synonymous: 'Synonymous',
  other: 'Other',
};

export const CONSEQUENCE_CATEGORY_COLORS: Record<ConsequenceCategory, string> = {
  lof: '#DD2C00',
  missense: '#F0C94D',
  synonymous: '#2E7D32',
  other: '#757575',
};

export interface VariantFilter {
  includeCategories: Record<ConsequenceCategory, boolean>;
  searchText: string;
}

export const DEFAULT_VARIANT_FILTER: VariantFilter = {
  includeCategories: {
    lof: true,
    missense: true,
    synonymous: true,
    other: true,
  },
  searchText: '',
};

interface VariantFilterControlsProps {
  value: VariantFilter;
  onChange: (filter: VariantFilter) => void;
}

const FilterContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
`;

const CategoryGroup = styled.div`
  display: flex;
  align-items: stretch;
`;

const CategoryWrapper = styled.div<{ $color: string; $isFirst?: boolean; $isLast?: boolean }>`
  display: flex;
  align-items: center;
  border: 1px solid ${props => props.$color};
  border-left-width: ${props => props.$isFirst ? '1px' : '0'};
  border-top-left-radius: ${props => props.$isFirst ? '0.5em' : '0'};
  border-bottom-left-radius: ${props => props.$isFirst ? '0.5em' : '0'};
  border-top-right-radius: ${props => props.$isLast ? '0.5em' : '0'};
  border-bottom-right-radius: ${props => props.$isLast ? '0.5em' : '0'};
  overflow: hidden;
`;

const CategoryLabel = styled.label<{ $color: string; $checked: boolean }>`
  display: flex;
  align-items: center;
  padding: 0.375rem 0.5rem;
  background: ${props => props.$checked ? `${props.$color}40` : 'transparent'};
  cursor: pointer;
  user-select: none;
  font-size: 14px;
  transition: background-color 0.15s ease;

  &:hover {
    background: ${props => `${props.$color}30`};
  }
`;

const HiddenCheckbox = styled.input.attrs({ type: 'checkbox' })`
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
`;

const CheckboxIcon = styled.span<{ $checked: boolean; $color: string }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1px solid ${props => props.$color};
  border-radius: 3px;
  margin-right: 0.5rem;
  background: ${props => props.$checked ? props.$color : 'transparent'};
  color: white;
  font-size: 10px;
  font-weight: bold;
`;

const OnlyButton = styled.button<{ $color: string }>`
  padding: 0.375rem 0.5rem;
  border: none;
  border-left: 1px solid ${props => props.$color};
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  color: #666;
  transition: background-color 0.15s ease;

  &:hover {
    background: ${props => `${props.$color}20`};
  }

  &:active {
    background: ${props => `${props.$color}30`};
  }
`;

const AllButton = styled.button`
  padding: 0.375rem 0.75rem;
  border: 1px solid #ddd;
  border-radius: 0.5em;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  color: #333;
  transition: all 0.15s ease;

  &:hover {
    background: #f5f5f5;
    border-color: #ccc;
  }

  &:active {
    background: #eee;
  }
`;

export function VariantFilterControls({ value, onChange }: VariantFilterControlsProps) {
  const handleCategoryChange = useCallback((category: ConsequenceCategory, checked: boolean) => {
    onChange({
      ...value,
      includeCategories: {
        ...value.includeCategories,
        [category]: checked,
      },
    });
  }, [value, onChange]);

  const handleOnlyClick = useCallback((category: ConsequenceCategory) => {
    onChange({
      ...value,
      includeCategories: {
        lof: category === 'lof',
        missense: category === 'missense',
        synonymous: category === 'synonymous',
        other: category === 'other',
      },
    });
  }, [value, onChange]);

  const handleAllClick = useCallback(() => {
    onChange({
      ...value,
      includeCategories: {
        lof: true,
        missense: true,
        synonymous: true,
        other: true,
      },
    });
  }, [value, onChange]);

  return (
    <FilterContainer>
      <CategoryGroup>
        {CONSEQUENCE_CATEGORIES.map((category, index) => {
          const color = CONSEQUENCE_CATEGORY_COLORS[category];
          const label = CONSEQUENCE_CATEGORY_LABELS[category];
          const checked = value.includeCategories[category];
          const isFirst = index === 0;
          const isLast = index === CONSEQUENCE_CATEGORIES.length - 1;

          return (
            <CategoryWrapper
              key={category}
              $color={color}
              $isFirst={isFirst}
              $isLast={isLast}
            >
              <CategoryLabel $color={color} $checked={checked}>
                <HiddenCheckbox
                  checked={checked}
                  onChange={(e) => handleCategoryChange(category, e.target.checked)}
                />
                <CheckboxIcon $checked={checked} $color={color}>
                  {checked && '\u2713'}
                </CheckboxIcon>
                {label}
              </CategoryLabel>
              <OnlyButton
                $color={color}
                onClick={() => handleOnlyClick(category)}
                title={`Show only ${label} variants`}
              >
                only
              </OnlyButton>
            </CategoryWrapper>
          );
        })}
      </CategoryGroup>
      <AllButton onClick={handleAllClick} title="Show all variant categories">
        all
      </AllButton>
    </FilterContainer>
  );
}

// Helper function to categorize a variant by consequence
export function getConsequenceCategory(consequence: string | undefined): ConsequenceCategory {
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

// Helper function to filter variants based on filter state
export function filterVariants<T extends { consequence?: string }>(
  variants: T[],
  filter: VariantFilter
): T[] {
  return variants.filter(v => {
    const category = getConsequenceCategory(v.consequence);
    return filter.includeCategories[category];
  });
}

export default VariantFilterControls;
