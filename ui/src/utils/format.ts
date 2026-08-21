export function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function formatScore(score: number): string {
  return score.toFixed(2);
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export function formatProviders(providers: Record<string, { cached: boolean | null }>): string {
  const entries = Object.entries(providers);
  if (entries.length === 0) return '—';
  return entries
    .map(([name, obs]) => {
      if (obs.cached === true) return `${name} ✓`;
      if (obs.cached === false) return `${name} ✗`;
      return name;
    })
    .join(', ');
}

export function sourceBadge(source: 'corpus' | 'live'): string {
  return source === 'corpus' ? 'DMM' : 'LIVE';
}
