import { Component } from 'react';
import styled from 'styled-components';

// BaseTable from @gnomad/ui
const Table = styled.table`
  min-width: 100%;
  border-collapse: collapse;
  border-spacing: 0;

  td,
  th {
    padding: 0.5em 10px 0.5em 0;
    text-align: left;
  }

  thead {
    td,
    th {
      border-bottom: 1px solid #000;
      background-position: center right;
      background-repeat: no-repeat;

      &[aria-sort='ascending'] {
        background-image: url('data:image/gif;base64,R0lGODlhFQAEAIAAACMtMP///yH5BAEAAAEALAAAAAAVAAQAAAINjI8Bya2wnINUMopZAQA7');
      }

      &[aria-sort='descending'] {
        background-image: url('data:image/gif;base64,R0lGODlhFQAEAIAAACMtMP///yH5BAEAAAEALAAAAAAVAAQAAAINjB+gC+jP2ptn0WskLQA7');
      }

      button {
        padding: 0;
        border: none;
        background: none;
        color: inherit;
        cursor: pointer;
        font: inherit;
        outline: none;
        user-select: none;
      }
    }
  }

  tbody {
    td,
    th {
      border-bottom: 1px solid #ccc;
      font-weight: normal;
    }
  }

  tfoot {
    td,
    th {
      border-top: 1px solid #ccc;
      font-weight: bold;
    }
  }

  tr.strong-border {
    td, th {
      border-top: 2px solid #333;
    }
  }

  tr.border {
    td, th {
      border-top: 2px solid #888;
    }
  }

  tr.subtle-border {
    td, th {
      border-top: 2px solid #bbb;
    }
  }

  th.right-align,
  td.right-align {
    padding-right: 25px;
    text-align: right;
  }
`;

const TogglePopulationButton = styled.button<{ $isExpanded: boolean }>`
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  padding-left: ${props => (props.$isExpanded ? '15px' : '10px')};
  background-color: transparent;
  background-image: ${props =>
    props.$isExpanded
      ? 'url(data:image/gif;base64,R0lGODlhFQAEAIAAACMtMP///yH5BAEAAAEALAAAAAAVAAQAAAINjB+gC+jP2ptn0WskLQA7)'
      : 'url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAVCAYAAABhe09AAAAATElEQVQoU2NkQAOM9BFQ1jXYf/fyBUeYbYzKugb/GRgYDsAEYQIgBWBBZAGwIIoA438GhAoQ586VCxAVMA5ID6OKjoEDSAZuLV18CwAQVSMV/9L8fgAAAABJRU5ErkJggg==)'};
  background-position: center left ${props => (props.$isExpanded ? '-5px' : '0')};
  background-repeat: no-repeat;
  border: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;

  &:hover {
    text-decoration: underline;
  }
`;

// TooltipHint from @gnomad/ui - dotted underline hint
const TooltipHint = styled.span`
  background-image: linear-gradient(to right, #000 75%, transparent 75%);
  background-position: 0 1.15em;
  background-size: 4px 2px;
  background-repeat: repeat-x;
  cursor: help;
`;

const SEX_IDENTIFIERS = ['XX', 'XY'];

const isSexSpecificPopulation = (pop: { id: string }) =>
  SEX_IDENTIFIERS.includes(pop.id) || SEX_IDENTIFIERS.some(id => pop.id.endsWith(`_${id}`));

const calculatePopAF = (ac: number, an: number): number => {
  if (an === 0) {
    return -1;
  }
  return ac / an;
};

const renderPopAF = (af: number) => {
  if (af === -1) {
    return '—';
  }
  return af.toPrecision(4);
};

type Population = {
  id: string;
  name: string;
  ac: number;
  an: number;
  ac_hemi?: number;
  ac_hom?: number;
  subpopulations?: {
    id: string;
    name: string;
    ac: number;
    an: number;
    ac_hemi?: number;
    ac_hom?: number;
  }[];
};

type PopulationsTableProps = {
  columnLabels?: {
    ac?: string;
    an?: string;
    af?: string;
  };
  populations: Population[];
  showHemizygotes?: boolean;
  showHomozygotes?: boolean;
  initiallyExpandRows?: boolean;
};

type PopulationsTableState = {
  sortBy: string;
  sortAscending: boolean;
  expandedPopulations: Record<string, boolean>;
};

export class PopulationsTable extends Component<PopulationsTableProps, PopulationsTableState> {
  static defaultProps = {
    columnLabels: {},
    showHemizygotes: false,
    showHomozygotes: true,
    initiallyExpandRows: false,
  };

  constructor(props: PopulationsTableProps) {
    super(props);

    this.state = {
      sortBy: 'af',
      sortAscending: false,
      expandedPopulations: props.populations.reduce(
        (acc, pop) => ({ ...acc, [pop.name]: props.initiallyExpandRows }),
        {}
      ),
    };
  }

  setSortBy(sortBy: string) {
    this.setState((state) => ({
      sortBy,
      sortAscending: sortBy === state.sortBy ? !state.sortAscending : state.sortAscending,
    }));
  }

  togglePopulationExpanded(populationName: string) {
    this.setState((state) => ({
      ...state,
      expandedPopulations: {
        ...state.expandedPopulations,
        [populationName]: !state.expandedPopulations[populationName],
      },
    }));
  }

  renderColumnHeader({ key, label, tooltip, props = {} }: { key: string; label: string; tooltip?: string; props?: Record<string, unknown> }) {
    const { sortAscending, sortBy } = this.state;
    let ariaSortAttr: 'none' | 'ascending' | 'descending' = 'none';
    if (sortBy === key) {
      ariaSortAttr = sortAscending ? 'ascending' : 'descending';
    }

    return (
      <th {...props} aria-sort={ariaSortAttr} scope="col">
        <button type="button" onClick={() => this.setSortBy(key)}>
          {tooltip ? (
            <TooltipHint title={tooltip}>{label}</TooltipHint>
          ) : (
            label
          )}
        </button>
      </th>
    );
  }

  renderPopulationRowHeader(pop: Population & { af: number; subpopulations?: Array<{ id: string; name: string; ac: number; an: number; af: number; ac_hemi?: number; ac_hom?: number }> }) {
    const { expandedPopulations } = this.state;
    const isExpanded = expandedPopulations[pop.name];
    const subpops = pop.subpopulations || [];
    const colSpan = isExpanded ? 1 : 2;
    const rowSpan = isExpanded ? subpops.length + 1 : 1;

    return (
      <th colSpan={colSpan} rowSpan={rowSpan} scope="row">
        {subpops.length > 0 ? (
          <TogglePopulationButton
            $isExpanded={isExpanded}
            onClick={() => this.togglePopulationExpanded(pop.name)}
          >
            {pop.name}
          </TogglePopulationButton>
        ) : (
          pop.name
        )}
      </th>
    );
  }

  render() {
    const { columnLabels, populations, showHemizygotes, showHomozygotes } = this.props;
    const { expandedPopulations, sortAscending, sortBy } = this.state;

    const renderedPopulations = populations
      .map((pop) => ({
        ...pop,
        af: calculatePopAF(pop.ac, pop.an),
        subpopulations: (pop.subpopulations || [])
          .map((subPop) => ({
            ...subPop,
            af: calculatePopAF(subPop.ac, subPop.an),
          }))
          .sort((a, b) => {
            if (isSexSpecificPopulation(a) && !isSexSpecificPopulation(b)) {
              return 1;
            }
            if (isSexSpecificPopulation(b) && !isSexSpecificPopulation(a)) {
              return -1;
            }

            const [subPop1, subPop2] = sortAscending ? [a, b] : [b, a];

            return sortBy === 'name'
              ? subPop1.name.localeCompare(subPop2.name)
              : (subPop1 as Record<string, unknown>)[sortBy] as number - ((subPop2 as Record<string, unknown>)[sortBy] as number);
          }),
      }))
      .sort((a, b) => {
        if (isSexSpecificPopulation(a) && !isSexSpecificPopulation(b)) {
          return 1;
        }
        if (isSexSpecificPopulation(b) && !isSexSpecificPopulation(a)) {
          return -1;
        }

        if (isSexSpecificPopulation(b) && isSexSpecificPopulation(a)) {
          return a.name.localeCompare(b.name);
        }

        const [pop1, pop2] = sortAscending ? [a, b] : [b, a];

        return sortBy === 'name'
          ? pop1.name.localeCompare(pop2.name)
          : (pop1 as Record<string, unknown>)[sortBy] as number - ((pop2 as Record<string, unknown>)[sortBy] as number);
      });

    const totalAlleleCount = renderedPopulations
      .filter((pop) => !isSexSpecificPopulation(pop))
      .map((pop) => pop.ac)
      .reduce((acc, n) => acc + n, 0);
    const totalAlleleNumber = renderedPopulations
      .filter((pop) => !isSexSpecificPopulation(pop))
      .map((pop) => pop.an)
      .reduce((acc, n) => acc + n, 0);
    const totalAlleleFrequency = totalAlleleNumber !== 0 ? totalAlleleCount / totalAlleleNumber : 0;

    const totalHemizygotes = renderedPopulations
      .filter((pop) => !isSexSpecificPopulation(pop))
      .map((pop) => pop.ac_hemi || 0)
      .reduce((acc, n) => acc + n, 0);
    const totalHomozygotes = renderedPopulations
      .filter((pop) => !isSexSpecificPopulation(pop))
      .map((pop) => pop.ac_hom || 0)
      .reduce((acc, n) => acc + n, 0);

    const getBorderThickness = (i: number, pop: Population, pops: Population[]) => {
      if (i === 0) {
        return 'strong-border';
      }

      const isPreviousRowSexSpecific = i > 0 && isSexSpecificPopulation(pops[i - 1]);
      const isCurrentRowSexSpecific = isSexSpecificPopulation(pop);

      if (isPreviousRowSexSpecific && isCurrentRowSexSpecific) {
        return undefined;
      }

      return 'border';
    };

    return (
      <Table>
        <thead>
          <tr>
            {this.renderColumnHeader({
              key: 'name',
              label: 'Genetic Ancestry Group',
              props: { colSpan: 2 },
            })}
            {this.renderColumnHeader({
              key: 'ac',
              label: columnLabels?.ac || 'Allele Count',
              tooltip: 'Alternate allele count in high quality genotypes',
              props: { className: 'right-align' },
            })}
            {this.renderColumnHeader({
              key: 'an',
              label: columnLabels?.an || 'Allele Number',
              tooltip: 'Total number of called high quality genotypes',
              props: { className: 'right-align' },
            })}
            {showHomozygotes &&
              this.renderColumnHeader({
                key: 'ac_hom',
                label: 'Number of Homozygotes',
                tooltip: 'Number of individuals homozygous for alternate allele',
                props: { className: 'right-align' },
              })}
            {showHemizygotes &&
              this.renderColumnHeader({
                key: 'ac_hemi',
                label: 'Number of Hemizygotes',
                tooltip: 'Number of individuals hemizygous for alternate allele',
                props: { className: 'right-align' },
              })}
            {this.renderColumnHeader({
              key: 'af',
              label: columnLabels?.af || 'Allele Frequency',
              tooltip: 'Alternate allele frequency in high quality genotypes',
              props: { style: { paddingLeft: '25px' } },
            })}
          </tr>
        </thead>
        {renderedPopulations.map((pop, i) => (
          <tbody key={pop.id}>
            <tr className={getBorderThickness(i, pop, renderedPopulations)}>
              {this.renderPopulationRowHeader(pop)}
              {expandedPopulations[pop.name] && <td>Overall</td>}
              <td className="right-align">{pop.ac.toLocaleString()}</td>
              <td className="right-align">{pop.an.toLocaleString()}</td>
              {showHomozygotes && <td className="right-align">{pop.ac_hom?.toLocaleString() ?? 0}</td>}
              {showHemizygotes && <td className="right-align">{pop.ac_hemi?.toLocaleString() ?? '—'}</td>}
              <td style={{ paddingLeft: '25px' }}>{renderPopAF(pop.af)}</td>
            </tr>
            {pop.subpopulations &&
              expandedPopulations[pop.name] &&
              pop.subpopulations.map((subPop, j) => (
                <tr
                  key={`${pop.name}-${subPop.name}`}
                  className={
                    j === 0 ||
                    (isSexSpecificPopulation(subPop) &&
                      !isSexSpecificPopulation(pop.subpopulations![j - 1]))
                      ? 'subtle-border'
                      : undefined
                  }
                >
                  <td>{subPop.name}</td>
                  <td className="right-align">{subPop.ac.toLocaleString()}</td>
                  <td className="right-align">{subPop.an.toLocaleString()}</td>
                  {showHomozygotes && <td className="right-align">{subPop.ac_hom?.toLocaleString() ?? 0}</td>}
                  {showHemizygotes && (
                    <td className="right-align">
                      {subPop.ac_hemi !== null && subPop.ac_hemi !== undefined ? subPop.ac_hemi.toLocaleString() : '—'}
                    </td>
                  )}
                  <td style={{ paddingLeft: '25px' }}>{renderPopAF(subPop.af)}</td>
                </tr>
              ))}
          </tbody>
        ))}
        <tfoot>
          <tr className="strong-border">
            <th colSpan={2} scope="row">
              Total
            </th>
            <td className="right-align">{totalAlleleCount.toLocaleString()}</td>
            <td className="right-align">{totalAlleleNumber.toLocaleString()}</td>
            {showHomozygotes && <td className="right-align">{totalHomozygotes.toLocaleString()}</td>}
            {showHemizygotes && <td className="right-align">{totalHemizygotes.toLocaleString()}</td>}
            <td style={{ paddingLeft: '25px' }}>{totalAlleleFrequency.toPrecision(4)}</td>
          </tr>
        </tfoot>
      </Table>
    );
  }
}

export default PopulationsTable;
