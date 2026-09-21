import { useCallback, useEffect, useState } from 'react';
import {
  fetchLibrary, fetchQuality, setLibraryProfile, setLibraryIntent, formatBytes, mediaLabel,
  type LibraryItem, type QualityInfo,
} from '@/api';
import { usePoll } from '@/lib/use-poll';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState } from '@/components/common';

const PROFILES = ['balanced', 'hd', 'max'] as const;
const INTENTS = [
  { value: 'library', label: 'Keep in library' },
  { value: 'watch', label: 'Watch once' },
  { value: 'immediate', label: 'Best available now' },
] as const;

function intentOf(item: LibraryItem): string {
  if (item.intent) return item.intent;
  if (item.publicationMode === 'temporary') return 'watch';
  return 'library';
}

export function LibraryPage() {
  const [data, error, refresh] = usePoll(useCallback(() => fetchLibrary(100), []), 30_000);
  const [quality, setQuality] = useState<Record<string, QualityInfo>>({});
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  const items = data?.items ?? [];
  const tfIds = items.map((i) => i.torrentFileId).filter((t): t is string => !!t);

  useEffect(() => {
    if (tfIds.length === 0) return;
    let alive = true;
    fetchQuality([...new Set(tfIds)].slice(0, 100))
      .then((r) => {
        if (!alive) return;
        const map: Record<string, QualityInfo> = {};
        for (const q of r.items) map[q.torrentFileId] = q;
        setQuality(map);
      })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const changeProfile = async (item: LibraryItem, profile: string) => {
    setProfileMsg(null);
    try {
      await setLibraryProfile({
        mediaId: item.mediaId,
        mediaType: item.mediaType,
        season: item.season,
        episode: item.episode,
        qualityProfile: profile,
      });
      setProfileMsg(`Saved ${profile} for ${mediaLabel(item)}.`);
      void refresh();
    } catch (err) {
      setProfileMsg(`Could not save profile: ${(err as Error).message}`);
    }
  };

  const changeIntent = async (item: LibraryItem, intent: string) => {
    setProfileMsg(null);
    try {
      const res = await setLibraryIntent({
        mediaId: item.mediaId,
        mediaType: item.mediaType,
        season: item.season,
        episode: item.episode,
        intent: intent as 'library' | 'watch' | 'immediate',
      });
      setProfileMsg(res.unchanged
        ? `${mediaLabel(item)} is already permanent — left unchanged.`
        : `Saved intent ${res.intent} for ${mediaLabel(item)}.`);
      void refresh();
    } catch (err) {
      setProfileMsg(`Could not save intent: ${(err as Error).message}`);
    }
  };

  if (!data && !error) return <LoadingState label="Loading library…" />;
  if (error && !data) return <ErrorState message={error} onRetry={() => void refresh()} />;

  return (
    <div className="page">
      <PageHeader
        title="Library"
        subtitle="Published media. Changing quality intent never re-downloads anything by itself."
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>Refresh</button>}
      />
      {profileMsg && <Section dense><div className="muted small" role="status">{profileMsg}</div></Section>}
      <Section dense>
        {items.length === 0 ? (
          <EmptyState title="Library is empty" detail="Request something from Seerr or Requestrr and it will appear here once published." />
        ) : (
          <ul className="card-list">
            {items.map((item) => {
              const q = item.torrentFileId ? quality[item.torrentFileId] : undefined;
              const qualityLabel = q?.tier != null ? q.label : (q?.resolution ?? null);
              const key = `${item.mediaId}:${item.season ?? ''}:${item.episode ?? ''}`;
              return (
                <li key={key} className="media-card">
                  <div className="media-card-main">
                    <div className="media-name">{mediaLabel(item)}</div>
                    <div className="media-sub muted small">
                      {item.mediaType === 'episode' ? 'Episode' : 'Movie'}
                      {qualityLabel ? ` · ${qualityLabel}` : ''}
                      {item.size ? ` · ${formatBytes(item.size)}` : ''}
                    </div>
                    <div className="tag-row">
                      <span className={`badge badge-${item.state === 'published' ? 'success' : 'default'}`}>{item.state ?? '—'}</span>
                      <span className="badge badge-default">{item.qualityProfile ?? 'balanced'}</span>
                      <span className={`badge badge-${item.hasServingCoordinates ? 'success' : 'warning'}`}>
                        {item.hasServingCoordinates ? 'Watchable' : 'No copy yet'}
                      </span>
                      {item.publicationMode === 'temporary' && <span className="badge badge-info">Temporary</span>}
                      {intentOf(item) !== 'library' && (
                        <span className="badge badge-info">{intentOf(item) === 'watch' ? 'Watch once' : 'Best now'}</span>
                      )}
                    </div>
                  </div>
                  <label className="profile-pick">
                    <span className="muted small">Quality intent</span>
                    <select
                      value={item.qualityProfile ?? 'balanced'}
                      onChange={(e) => void changeProfile(item, e.target.value)}
                      aria-label={`Quality intent for ${mediaLabel(item)}`}
                    >
                      {PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </label>
                  <label className="profile-pick">
                    <span className="muted small">Outcome</span>
                    <select
                      value={intentOf(item)}
                      onChange={(e) => void changeIntent(item, e.target.value)}
                      aria-label={`Desired outcome for ${mediaLabel(item)}`}
                    >
                      {INTENTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
