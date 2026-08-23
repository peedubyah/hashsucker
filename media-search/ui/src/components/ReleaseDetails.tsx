import { useState } from 'react';
import type {
  ControlPlaneItemDetail, ReleaseResult, RequestSubmissionResult,
} from '@/types/api';
import { formatSize, formatScore, formatConfidence } from '@/utils/format';
import { Badge } from './Badge';
import { ProviderStatus } from './ProviderStatus';
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
  controlPlaneDetail?: ControlPlaneItemDetail | null;
  controlPlaneLoading?: boolean;
  controlPlaneError?: string | null;
}

export function ReleaseDetails({
  release, onClose, onSubmit, requesting, requestResult, requestError,
  controlPlaneDetail = null, controlPlaneLoading = false, controlPlaneError = null,
}: Props) {
  const [handlingMode, setHandlingMode] = useState<HandlingMode>('download');
  return (
    <div className="release-details-overlay" onClick={onClose}>
      <div className="release-details-panel" onClick={e => e.stopPropagation()}>
        <div className="release-details-header">
          <h3>Release Details</h3>
          <button type="button" className="close-button" onClick={onClose}>×</button>
        </div>
        <div className="release-details-body">
          <div className="detail-section">
            <h4>File</h4>
            <div className="detail-grid">
              <div className="detail-item">
                <span className="detail-label">Filename</span>
                <span className="detail-value mono">{release.filename}</span>
              </div>
              {release.size != null && (
                <div className="detail-item">
                  <span className="detail-label">Size</span>
                  <span className="detail-value">{formatSize(release.size)}</span>
                </div>
              )}
            </div>
          </div>
          <div className="detail-section">
            <h4>Media</h4>
            <div className="detail-grid">
              {release.resolution && (
                <div className="detail-item">
                  <span className="detail-label">Resolution</span>
                  <span className="detail-value"><Badge variant="info">{release.resolution}</Badge></span>
                </div>
              )}
              {release.quality && (
                <div className="detail-item">
                  <span className="detail-label">Quality</span>
                  <span className="detail-value"><Badge>{release.quality}</Badge></span>
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
                  <span className="detail-value"><Badge variant="warning">Yes</Badge></span>
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
                  <span className="detail-label">Group</span>
                  <span className="detail-value">{release.releaseGroup}</span>
                </div>
              )}
            </div>
          </div>
          <div className="detail-section">
            <h4>Ranking</h4>
            <div className="detail-grid">
              <div className="detail-item">
                <span className="detail-label">Score</span>
                <span className="detail-value">{formatScore(release.score)}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">Confidence</span>
                <span className="detail-value">{formatConfidence(release.confidence)}</span>
              </div>
            </div>
          </div>
          <div className="detail-section">
            <h4>Providers</h4>
            <ProviderStatus providers={release.providers} observations={release.providerObservations} />
          </div>
          <div className="detail-section">
            <h4>Exact identity</h4>
            <div className="detail-item">
              <span className="detail-label">Release key</span>
              <span className="detail-value mono">{release.releaseKey}</span>
            </div>
          </div>
          {controlPlaneLoading && <div className="detail-section">Loading exact lifecycle…</div>}
          {controlPlaneError && <div className="detail-section" role="alert">{controlPlaneError}</div>}
          {controlPlaneDetail && (
            <div className="detail-section">
              <LifecycleStatus items={[controlPlaneDetail]} />
              <div className="detail-grid">
                <div className="detail-item"><span className="detail-label">Shadow action</span><span className="detail-value">{controlPlaneDetail.shadowPlan?.actions[0]?.action ?? 'none'}</span></div>
                <div className="detail-item"><span className="detail-label">Placements</span><span className="detail-value">{controlPlaneDetail.resources?.placements.length ?? 0}</span></div>
                <div className="detail-item"><span className="detail-label">Provider files</span><span className="detail-value">{controlPlaneDetail.resources?.files.length ?? 0}</span></div>
                <div className="detail-item"><span className="detail-label">Exposures</span><span className="detail-value">{controlPlaneDetail.resources?.exposures.length ?? 0}</span></div>
              </div>
            </div>
          )}
          {!requestResult && (
            <div className="detail-section">
              <h4>Handling</h4>
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
            <div role="status">Request {requestResult.status}: {requestResult.requestId}</div>
          ) : (
            <button type="button" className="request-button" onClick={() => onSubmit(handlingMode)} disabled={requesting}>
              {requesting ? 'Submitting request…' : 'Submit request'}
            </button>
          )}
          {requestError && <div role="alert">{requestError}</div>}
        </div>
      </div>
    </div>
  );
}
