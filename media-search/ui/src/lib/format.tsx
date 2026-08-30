import { useState } from 'react';

export function formatTimestamp(value: string | number | null | undefined): string {
  if (value == null || value === '') return 'Unknown';
  const date = new Date(typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
}

export function formatRelative(value: string | number | null | undefined): string {
  if (value == null || value === '') return 'unknown';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'unknown';
  const delta = Date.now() - time;
  const absolute = Math.abs(delta);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000], ['second', 1_000],
  ];
  const [unit, divisor] = units.find(([, size]) => absolute >= size) ?? ['second', 1_000];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.round(delta / divisor), unit);
}

export function formatDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.floor((value % 60_000) / 1_000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat().format(value);
}

export function statusTone(status: string | null | undefined): 'good' | 'warn' | 'bad' | 'neutral' | 'info' {
  const normalized = status?.toLowerCase() ?? '';
  if (['ok', 'pass', 'healthy', 'completed', 'done', 'cached', 'redirected', 'satisfied', 'reachable', 'active'].includes(normalized)) return 'good';
  if (['warning', 'degraded', 'stale', 'processing', 'running', 'pending', 'queued', 'unknown', 'uncached'].includes(normalized)) return 'warn';
  if (['error', 'fail', 'failed', 'unhealthy', 'stuck', 'missing', 'invalid'].includes(normalized)) return 'bad';
  if (['unsupported', 'not-configured', 'idle'].includes(normalized)) return 'neutral';
  return 'info';
}

export function StatusBadge({ value, label }: { value: string | null | undefined; label?: string }) {
  return <span className={`status-badge tone-${statusTone(value)}`}>{label ?? value ?? 'unknown'}</span>;
}

export function CopyValue({ value, label }: { value: string | null | undefined; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">—</span>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="copy-value" title={value}>
      <code>{label ?? value}</code>
      <button type="button" className="copy-button" onClick={copy} aria-label={`Copy ${label ?? value}`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

export function JsonDetails({ value, summary = 'Raw details' }: { value: unknown; summary?: string }) {
  return (
    <details className="json-details">
      <summary>{summary}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
