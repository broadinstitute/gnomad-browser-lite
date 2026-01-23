import { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import styled from 'styled-components';
import { FixedSizeList as List } from 'react-window';

// Types
export interface GridColumn<T> {
  key: string;
  heading: string;
  tooltip?: string;
  minWidth?: number;
  grow?: number;
  isSortable?: boolean;
  isRowHeader?: boolean;
  render: (row: T, key: string, cellData: Record<string, unknown>) => React.ReactNode;
}

export interface GridProps<T> {
  columns: GridColumn<T>[];
  data: T[];
  cellData?: Record<string, unknown>;
  rowKey: (row: T) => string;
  rowHeight?: number;
  numRowsRendered?: number;
  sortKey?: string;
  sortOrder?: 'ascending' | 'descending';
  onRequestSort?: (key: string) => void;
  onHoverRow?: (index: number | null) => void;
  shouldHighlightRow?: (row: T) => boolean;
  onVisibleRowsChange?: (params: { startIndex: number; stopIndex: number }) => void;
}

export interface GridRef {
  scrollToDataRow: (index: number) => void;
}

// Styled components
const GridWrapper = styled.div`
  width: 100%;
  font-size: 14px;
`;

const GridHorizontalViewport = styled.div`
  overflow-x: auto;
`;

const HeaderRow = styled.div`
  display: flex;
  flex-direction: row;
  align-items: stretch;
  border-bottom: 1px solid #e0e0e0;
  background: #fafafa;
`;

const ColumnHeader = styled.div<{ $width: number; $sortable?: boolean; $sorted?: boolean }>`
  display: flex;
  flex-shrink: 0;
  align-items: center;
  box-sizing: border-box;
  width: ${props => props.$width}px;
  padding: 8px 12px;
  font-weight: 600;
  font-size: 13px;
  color: #333;
  cursor: ${props => props.$sortable ? 'pointer' : 'default'};
  user-select: none;
  position: relative;
  background: ${props => props.$sorted ? '#f0f0f0' : 'transparent'};

  &:hover {
    background: ${props => props.$sortable ? '#f0f0f0' : 'transparent'};
  }

  &::after {
    content: '';
    position: absolute;
    right: 8px;
    width: 0;
    height: 0;
  }
`;

const SortIndicator = styled.span<{ $direction: 'ascending' | 'descending' }>`
  margin-left: 4px;
  font-size: 10px;
  color: #666;
`;

const DataRowWrapper = styled.div<{ $highlighted?: boolean; $striped?: boolean }>`
  display: flex;
  flex-direction: row;
  align-items: stretch;
  border-top: 1px solid #e0e0e0;
  background: ${props => {
    if (props.$highlighted) return '#fff3cd';
    if (props.$striped) return '#fff';
    return '#fafafa';
  }};

  &:hover {
    background: #f5f5f5;
  }
`;

const DataCell = styled.div<{ $width: number }>`
  display: flex;
  flex-shrink: 0;
  align-items: center;
  box-sizing: border-box;
  width: ${props => props.$width}px;
  padding: 6px 12px;
  overflow: hidden;
`;

const CellContent = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

// Row component for virtualized list
interface RowProps<T> {
  index: number;
  style: React.CSSProperties;
  data: {
    items: T[];
    columns: GridColumn<T>[];
    columnWidths: number[];
    cellData: Record<string, unknown>;
    onMouseEnter: (index: number) => void;
    shouldHighlightRow: (row: T) => boolean;
  };
}

function Row<T>({ index, style, data }: RowProps<T>) {
  const { items, columns, columnWidths, cellData, onMouseEnter, shouldHighlightRow } = data;
  const row = items[index];
  const isHighlighted = shouldHighlightRow(row);
  const isStriped = index % 2 === 0;

  return (
    <DataRowWrapper
      style={style}
      $highlighted={isHighlighted}
      $striped={isStriped}
      onMouseEnter={() => onMouseEnter(index)}
    >
      {columns.map((column, colIndex) => (
        <DataCell key={column.key} $width={columnWidths[colIndex]}>
          {column.render(row, column.key, cellData)}
        </DataCell>
      ))}
    </DataRowWrapper>
  );
}

// Main Grid component
function GridInner<T>(
  {
    columns: inputColumns,
    data,
    cellData = {},
    rowKey,
    rowHeight = 25,
    numRowsRendered = 20,
    sortKey,
    sortOrder = 'ascending',
    onRequestSort,
    onHoverRow,
    shouldHighlightRow = () => false,
    onVisibleRowsChange,
  }: GridProps<T>,
  ref: React.Ref<GridRef>
) {
  const listRef = useRef<List>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1000);

  // Measure container width
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    scrollToDataRow: (index: number) => {
      listRef.current?.scrollToItem(index);
    },
  }));

  // Calculate column widths
  const columns = inputColumns.map(col => ({
    grow: 1,
    minWidth: 100,
    ...col,
  }));

  const minGridWidth = columns.reduce((sum, col) => sum + (col.minWidth || 100), 0);
  const remainingWidth = Math.max(containerWidth - minGridWidth, 0);
  const totalGrowFactors = columns.reduce((sum, col) => sum + (col.grow || 1), 0) || 1;

  const columnWidths = columns.map(
    col => (col.minWidth || 100) + ((col.grow || 1) / totalGrowFactors) * remainingWidth
  );

  const gridWidth = Math.max(containerWidth, minGridWidth);

  // Handle row hover
  const handleMouseEnter = useCallback((index: number) => {
    onHoverRow?.(index);
  }, [onHoverRow]);

  const handleMouseLeave = useCallback(() => {
    onHoverRow?.(null);
  }, [onHoverRow]);

  // Handle items rendered
  const handleItemsRendered = useCallback(({ visibleStartIndex, visibleStopIndex }: { visibleStartIndex: number; visibleStopIndex: number }) => {
    onVisibleRowsChange?.({
      startIndex: visibleStartIndex,
      stopIndex: visibleStopIndex,
    });
  }, [onVisibleRowsChange]);

  return (
    <GridWrapper ref={containerRef} onMouseLeave={handleMouseLeave}>
      <GridHorizontalViewport>
        <HeaderRow style={{ width: gridWidth }}>
          {columns.map((column, index) => (
            <ColumnHeader
              key={column.key}
              $width={columnWidths[index]}
              $sortable={column.isSortable}
              $sorted={column.key === sortKey}
              onClick={() => column.isSortable && onRequestSort?.(column.key)}
              title={column.tooltip}
            >
              <CellContent>{column.heading}</CellContent>
              {column.key === sortKey && (
                <SortIndicator $direction={sortOrder}>
                  {sortOrder === 'ascending' ? '▲' : '▼'}
                </SortIndicator>
              )}
            </ColumnHeader>
          ))}
        </HeaderRow>
        <List
          ref={listRef}
          height={numRowsRendered * rowHeight}
          itemCount={data.length}
          itemSize={rowHeight}
          width={gridWidth}
          itemKey={(index) => rowKey(data[index])}
          itemData={{
            items: data,
            columns,
            columnWidths,
            cellData,
            onMouseEnter: handleMouseEnter,
            shouldHighlightRow,
          }}
          onItemsRendered={handleItemsRendered}
        >
          {Row as React.ComponentType<RowProps<T>>}
        </List>
      </GridHorizontalViewport>
    </GridWrapper>
  );
}

// Export with forwardRef
export const Grid = forwardRef(GridInner) as <T>(
  props: GridProps<T> & { ref?: React.Ref<GridRef> }
) => React.ReactElement;

// Cell components for consistent styling
export const Cell = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const NumericCell = styled(Cell)`
  width: 100%;
  text-align: right;
`;

export const renderAlleleCountCell = (row: Record<string, unknown>, key: string) => {
  const value = row[key] as number | null | undefined;
  return (
    <NumericCell>
      {value != null ? value.toLocaleString() : ''}
    </NumericCell>
  );
};

export const renderAlleleFrequencyCell = (row: Record<string, unknown>, key: string) => {
  const number = row[key] as number | null | undefined;
  let display = '';

  if (number != null) {
    if (number === 0) {
      display = '0';
    } else if (number === 1) {
      display = '1';
    } else {
      const truncated = Number(number.toPrecision(3));
      display = truncated.toExponential(2);
    }
  }

  return <NumericCell>{display}</NumericCell>;
};

export default Grid;
