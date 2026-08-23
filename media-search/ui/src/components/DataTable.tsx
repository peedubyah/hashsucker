import type { ReactNode } from 'react';

export type SortDirection = 'asc' | 'desc' | null;

export interface Column<T> {
  key: string;
  header: ReactNode;
  sortable?: boolean;
  className?: string;
  render: (item: T) => ReactNode;
  getValue?: (item: T) => string | number | null;
}

interface Props<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (item: T) => string;
  sortKey: string | null;
  sortDirection: SortDirection;
  onSort: (key: string) => void;
  onRowClick?: (item: T) => void;
  emptyMessage?: string;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  sortKey,
  sortDirection,
  onSort,
  onRowClick,
  emptyMessage = 'No data.',
}: Props<T>) {
  if (data.length === 0) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  const handleSort = (col: Column<T>) => {
    if (col.sortable !== false && col.getValue) {
      onSort(col.key);
    }
  };

  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map(col => {
              const sortable = col.sortable !== false && col.getValue;
              const active = sortKey === col.key;
              return (
                <th
                  key={col.key}
                  className={`${col.className || ''} ${sortable ? 'sortable' : ''} ${active ? `active ${sortDirection}` : ''}`}
                  onClick={() => handleSort(col)}
                >
                  {col.header}
                  {sortable && active && (
                    <span className="sort-indicator">{sortDirection === 'asc' ? ' ↑' : ' ↓'}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.map(item => (
            <tr
              key={rowKey(item)}
              onClick={() => onRowClick?.(item)}
              className={onRowClick ? 'clickable' : ''}
            >
              {columns.map(col => (
                <td key={col.key} className={col.className || ''}>
                  {col.render(item)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
