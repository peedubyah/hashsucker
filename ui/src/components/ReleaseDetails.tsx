import type { ReleaseResult } from '@/types/api';
import { formatSize, formatScore, formatConfidence } from '@/utils/format';
import { Badge } from './Badge';
import { ProviderStatus } from './ProviderStatus';

interface Props {
  release: ReleaseResult;
  onClose: () => void;
}

export function ReleaseDetails({ release, onClose }: Props) {
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
            <ProviderStatus providers={release.providers} />
          </div>
        </div>
      </div>
    </div>
  );
}
