/**
 * Shared layout / presentation primitives for the operator console.
 * Composed of existing CSS classes plus a few new ones; no fetched data.
 */
import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, meta, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
        {meta ? <div className="page-meta">{meta}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export interface SectionProps {
  title?: string;
  description?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  dense?: boolean;
}

export function Section({ title, description, meta, actions, children, dense }: SectionProps) {
  return (
    <section className={`surface-section${dense ? ' surface-section-dense' : ''}`}>
      {(title || actions || meta) && (
        <div className="surface-section-head">
          {title ? <h2 className="surface-section-title">{title}</h2> : <span />}
          {meta ? <div className="surface-section-meta">{meta}</div> : null}
          {actions ? <div className="surface-section-actions">{actions}</div> : null}
        </div>
      )}
      {description ? <p className="surface-section-desc">{description}</p> : null}
      <div className="surface-section-body">{children}</div>
    </section>
  );
}

export interface EmptyStateProps {
  icon?: string;
  title: string;
  detail?: string;
  action?: ReactNode;
}

export function EmptyState({ icon = '·', title, detail, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <div className="empty-state-title">{title}</div>
      {detail ? <div className="empty-state-message">{detail}</div> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <span className="error-icon">!</span>
      <span className="error-message">{message}</span>
      {onRetry ? (
        <button type="button" className="retry-button" onClick={onRetry}>Retry</button>
      ) : null}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <div className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export interface MetricTileProps {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
}

export function MetricTile({ label, value, hint, tone = 'neutral' }: MetricTileProps) {
  return (
    <div className={`metric-tile tone-${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {hint ? <div className="metric-hint">{hint}</div> : null}
    </div>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="metric-grid">{children}</div>;
}

export interface KeyValueRow {
  key: string;
  value: ReactNode;
  mono?: boolean;
}

export function KeyValueGrid({ rows }: { rows: KeyValueRow[] }) {
  return (
    <dl className="kv-grid">
      {rows.map((r) => (
        <div key={r.key} className="kv-row">
          <dt className="kv-key">{r.key}</dt>
          <dd className={`kv-val${r.mono ? ' mono' : ''}`}>{r.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface DataColumn<T> {
  key: string;
  header: string;
  width?: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
}

export function DataTable<T>({
  rows,
  columns,
  getRowKey,
  empty,
  onRowClick,
}: {
  rows: T[];
  columns: DataColumn<T>[];
  getRowKey: (row: T) => string;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
}) {
  if (!rows.length) {
    return <div className="data-table-empty">{empty ?? 'No rows'}</div>;
  }
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width, textAlign: c.align ?? 'left' }}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={getRowKey(row)}
              className={onRowClick ? 'data-row-clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
