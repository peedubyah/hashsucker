import { useState } from 'react';
import type {
  ControlPlaneItemDetail, ReleaseResult, RequestSubmissionResult, ViewMode,
} from '@/types/api';
import { formatSize } from '@/utils/format';
import { Badge } from './Badge';
import { LifecycleStatus } from './LifecycleStatus';

export type HandlingMode = 'download' | 'stream';

const HANDLING_MODES: { value: HandlingMode; label: string; description: string }[] = [
  {
    value: 'download',
    label: 'Download',
    description: 'Create and maintain a local copy of this media.',
  },
  {
    value: 'stream',
    label: 'Stream',
    description: 'Create a managed playback reference. Media remains remote and is resolved on demand.',
  },
];

interface Props {
  release: ReleaseResult;
  onClose: () => void;
  onSubmit: (handlingMode: HandlingMode) => void;
  requesting: boolean;
  requestResult: RequestSubmissionResult | null;
  requestError: string | null;
  viewMode?: ViewMode;
  controlPlaneDetail?: ControlPlaneItemDetail | null;
  controlPlaneLoading?: boolean;
  controlPlaneError?: string | null;
}

/**
 * Release confirmation modal — consumer mode by default.
 * Shows quality, size, and one action button.
 * Technical details hidden behind "Show details" toggle.
 */
export function ReleaseDetails({
  release, onClose, onSubmit, requesting, requestResult, requestError,
  viewMode = 'user', controlPlaneDetail = null, controlPlaneLoading = false, controlPlaneError = null,
}: Props) {
  const [handlingMode, setHandlingMode] = useState<HandlingMode>('download');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isDebug = viewMode === 'debug';

  // Human-readable quality line
  const qualityParts: string[] = [];
  if (release.resolution) qualityParts.push(release.resolution);
  if (release.quality) qualityParts.push(release.quality);
  if (release.hdr === 'true') qualityParts.push('HDR');
  if (release.audio) qualityParts.push(release.audio);
  const qualityLine = qualityParts.join(' · ');

  return (
    <div className="release-details-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Release confirmation">
      <div className="release-details-panel" onClick={e => e.stopPropagation()}>
        <div className="release-details-header">
          <h3>Choose this version</h3>
          <button type="button" className="close-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="release-details-body">
          <div className="quality-summary">
            {qualityLine && <div className="quality-line">{qualityLine}</div>}
            <div className="summary-badges">
              {release.resolution && <Badge variant="info">{release.resolution}</Badge>}
              {release.codec && <Badge>{release.codec}</Badge>}
              {release.hdr === 'true' && <Badge variant="warning">HDR</Badge>}
              {release.size != null && <Badge>{formatSize(release.size)}</Badge>}
            </div>
          </div>

          {!requestResult && (
            <div className="detail-section">
              <h4>What would you like to do?</h4>
              <div className="handling-options" role="radiogroup" aria-label="Handling mode">
                {HANDLING_MODES.map(mode => (
                  <label key={mode.value} className={`handling-option ${handlingMode === mode.value ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="handlingMode"
                      value={mode.value}
                      checked={handlingMode === mode.value}
                      onChange={() => setHandlingMode(mode.value)}
                    />
                    <span className="handling-label">{mode.label}</span>
                    <span className="handling-description">{mode.description}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {requestResult ? (
            <div role="status" className="request-result success">
              <strong>
                {handlingMode === 'download' ? 'Added to your library' : 'Ready to stream'}
              </strong>
            </div>
          ) : (
            <button
              type="button"
              className={`request-button ${handlingMode}`}
              onClick={() => onSubmit(handlingMode)}
              disabled={requesting}
            >
              {requesting
                ? handlingMode === 'download' ? 'Adding to library…' : 'Setting up playback…'
                : handlingMode === 'download' ? 'Download' : 'Stream'}
            </button>
          )}

          {requestError && <div role="alert" className="error-message">{requestError}</div>}

          <div className="advanced-section">
            <button
              type="button"
              className="advanced-toggle"
              onClick={() => setShowAdvanced(s => !s)}
              aria-expanded={showAdvanced}
            >
              {showAdvanced ? '▾ Hide details' : '▸ Show details'}
            </button>
            {showAdvanced && (
              <div className="advanced-content">
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Filename</span>
                    <span className="detail-value mono">{release.filename}</span>
                  </div>
                  {release.releaseGroup && (
                    <div className="detail-item">
                      <span className="detail-label">Release Group</span>
                      <span className="detail-value">{release.releaseGroup}</span>
                    </div>
                  )}
                  <div className="detail-item">
                    <span className="detail-label">Size</span>
                    <span className="detail-value">{formatSize(release.size)}</span>
                  </div>
                  {release.quality && (
                    <div className="detail-item">
                      <span className="detail-label">Source</span>
                      <span className="detail-value">{release.quality}</span>
                    </div>
                  )}
                  {release.audio && (
                    <div className="detail-item">
                      <span className="detail-label">Audio</span>
                      <span className="detail-value">{release.audio}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {isDebug && (
            <div className="debug-section">
              <h4>Debug: System Internals</h4>
              <div className="detail-grid">
                <div className="detail-item">
                  <span className="detail-label">Score</span>
                  <span className="detail-value">{release.score?.toFixed(2)}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Confidence</span>
                  <span className="detail-value">{release.confidence?.toFixed(2)}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Release Key</span>
                  <span className="detail-value mono">{release.releaseKey}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Source</span>
                  <span className="detail-value">{release._source}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">InfoHash</span>
                  <span className="detail-value mono">{release.infoHash}</span>
                </div>
              </div>
              {controlPlaneLoading && <div className="detail-section">Loading lifecycle detail…</div>}
              {controlPlaneError && <div className="detail-section" role="alert">{controlPlaneError}</div>}
              {controlPlaneDetail && (
                <div className="detail-section">
                  <h5>Lifecycle</h5>
                  <LifecycleStatus items={[controlPlaneDetail]} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
