import { useState } from 'react';
import type { ReleaseResult } from '@/types/api';
import { formatSize, formatScore, formatConfidence } from '@/utils/format';
import { Badge } from './Badge';
import { ProviderStatus } from './ProviderStatus';

interface Props {
  release: ReleaseResult;
  rank: number;
  onSelect?: (release: ReleaseResult) => void;
}

function ScoreBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="score-seg" title={`${label}: ${formatScore(value)}`}>
      <span className="score-label">{label.slice(0, 3).toUpperCase()}</span>
      <div className="score-track">
        <div className="score-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function RankingDetails({ release }: { release: ReleaseResult }) {
  const componentRows = [
    ['relevance', release.components.relevance],
    ['quality', release.components.quality],
    ['release', release.components.releaseConfidence],
    ['identity', release.components.identityConfidence],
    ['provider', release.components.providerAvailability],
  ] as const;
  const hasComponents = componentRows.some(([, value]) => Number.isFinite(value));
  const hasScore = release.score != null;
  const hasConfidence = release.confidence != null;

  if (!hasComponents && !hasScore && !hasConfidence) {
    return <div className="ranking-details-empty">No ranking data available.</div>;
  }

  return (
    <div className="ranking-details">
      {hasScore && (
        <div className="ranking-row">
          <span className="ranking-label">Score</span>
          <span className="ranking-value">{formatScore(release.score)}</span>
        </div>
      )}
      {hasConfidence && (
        <div className="ranking-row">
          <span className="ranking-label">Confidence</span>
          <span className="ranking-value">{formatConfidence(release.confidence)}</span>
        </div>
      )}
      {hasComponents && (
        <div className="ranking-components">
          {componentRows.map(([label, value]) => Number.isFinite(value) && (
            <ScoreBar key={label} value={value as number} label={label} />
          ))}
          {Number.isFinite(release.components.episodeMatch) && release.components.episodeMatch !== 1 && (
            <ScoreBar value={release.components.episodeMatch as number} label="episode" />
          )}
        </div>
      )}
    </div>
  );
}

export function ReleaseRow({ release, rank, onSelect }: Props) {
  const [expanded, setExpanded] = useState(false);

  const toggle = () => {
    setExpanded(e => !e);
  };

  const handleSelect = () => {
    onSelect?.(release);
  };

  return (
    <div className={`release-row source-${release._source} ${expanded ? 'expanded' : ''}`}>
      <div className="release-row-main" onClick={toggle}>
        <div className="release-rank">#{rank}</div>
        <div className="release-info">
          <div className="release-filename" title={release.filename}>
            {release.filename}
          </div>
          <div className="release-tags">
            {release.resolution && <Badge variant="info">{release.resolution}</Badge>}
            {release.quality && <Badge>{release.quality}</Badge>}
            {release.codec && <Badge>{release.codec}</Badge>}
            {release.hdr === 'true' && <Badge variant="warning">HDR</Badge>}
            {release.releaseGroup && <Badge>{release.releaseGroup}</Badge>}
            <Badge variant={release._source === 'corpus' ? 'corpus' : 'live'}>
              {release._source === 'corpus' ? 'DMM' : 'LIVE'}
            </Badge>
          </div>
        </div>
        <div className="release-meta">
          <span className="release-size">{formatSize(release.size)}</span>
          <span className="release-score">{formatScore(release.score)}</span>
        </div>
        <div className="release-providers-mini">
          <ProviderStatus providers={release.providers} observations={release.providerObservations} />
        </div>
        <button
          type="button"
          className="expand-toggle"
          onClick={e => { e.stopPropagation(); toggle(); }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '−' : '+'}
        </button>
      </div>
      {expanded && (
        <div className="release-row-details">
          <div className="detail-grid">
            <div className="detail-item">
              <span className="detail-label">Filename</span>
              <span className="detail-value mono">{release.filename}</span>
            </div>
            {release.title && release.title !== release.filename && (
              <div className="detail-item">
                <span className="detail-label">Parsed title</span>
                <span className="detail-value">{release.title}</span>
              </div>
            )}
            {release.size != null && (
              <div className="detail-item">
                <span className="detail-label">Size</span>
                <span className="detail-value">{formatSize(release.size)} ({release.size.toLocaleString()} B)</span>
              </div>
            )}
            {release.resolution && (
              <div className="detail-item">
                <span className="detail-label">Resolution</span>
                <span className="detail-value">{release.resolution}</span>
              </div>
            )}
            {release.quality && (
              <div className="detail-item">
                <span className="detail-label">Quality</span>
                <span className="detail-value">{release.quality}</span>
              </div>
            )}
            {release.codec && (
              <div className="detail-item">
                <span className="detail-label">Codec</span>
                <span className="detail-value">{release.codec}</span>
              </div>
            )}
            {release.hdr === 'true' && (
              <div className="detail-item">
                <span className="detail-label">HDR</span>
                <span className="detail-value">Yes</span>
              </div>
            )}
            {release.audio && (
              <div className="detail-item">
                <span className="detail-label">Audio</span>
                <span className="detail-value">{release.audio}</span>
              </div>
            )}
            {release.releaseGroup && (
              <div className="detail-item">
                <span className="detail-label">Release group</span>
                <span className="detail-value">{release.releaseGroup}</span>
              </div>
            )}
            {release.season != null && (
              <div className="detail-item">
                <span className="detail-label">Season</span>
                <span className="detail-value">{release.season}</span>
              </div>
            )}
            {release.episode != null && (
              <div className="detail-item">
                <span className="detail-label">Episode</span>
                <span className="detail-value">{release.episode}</span>
              </div>
            )}
            <div className="detail-item">
              <span className="detail-label">Source</span>
              <span className="detail-value">
                <Badge variant={release._source === 'corpus' ? 'corpus' : 'live'}>
                  {release._source === 'corpus' ? 'DMM corpus' : 'Live discovery'}
                </Badge>
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">InfoHash</span>
              <span className="detail-value mono">{release.infoHash}</span>
            </div>
          </div>
          <RankingDetails release={release} />
          <div className="detail-providers">
            <span className="detail-label">Provider evidence</span>
            <ProviderStatus providers={release.providers} observations={release.providerObservations} />
          </div>
          {onSelect && (
            <button type="button" className="request-button" onClick={handleSelect}>
              Request this release
            </button>
          )}
        </div>
      )}
    </div>
  );
}
