import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaResult, ReleaseSearchResult } from '@/types/api';
import { mockReleases } from '@/test/fixtures';
import { ReleasesPage } from './ReleasesPage';

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const releases = {
  intent: {
    streamType: 'series',
    mediaType: 'tv',
    scope: 'episode',
    mediaId: 'tt2085059:7:3',
    baseMediaId: 'tt2085059',
    season: 7,
    episodes: [3],
  },
  results: [
    { ...mockReleases[0], infoHash: HASH, fileIndex: null, releaseKey: `${HASH}:torrent`, filename: 'Torrent.Level.mkv' },
    { ...mockReleases[1], infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0`, filename: 'File.Zero.mkv' },
    { ...mockReleases[2], infoHash: HASH, fileIndex: 1, releaseKey: `${HASH}:1`, filename: 'File.One.mkv' },
  ],
  total: 3,
  timings: { totalMs: 1 },
  stats: { indexed: 3, total: 3 },
} satisfies ReleaseSearchResult;

const media = {
  id: 'tt2085059',
  type: 'series',
  title: 'Black Mirror',
  year: 2011,
  posterUrl: null,
  backdropUrl: null,
  overview: null,
} satisfies MediaResult;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReleasesPage exact identity', () => {
  it('renders same-hash torrent, zero, and one identities as distinct rows', () => {
    render(<ReleasesPage releases={releases} media={{ media }} loading={false} error={null} onBack={() => {}} />);
    expect(screen.getByText('Torrent.Level.mkv')).toBeTruthy();
    expect(screen.getByText('File.Zero.mkv')).toBeTruthy();
    expect(screen.getByText('File.One.mkv')).toBeTruthy();
  });

  it('submits fileIndex and releaseKey for the selected row', async () => {
    let submitted: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({
          requestId: '12345678-1234-1234-1234-123456789abc',
          status: 'queued',
          release: { infoHash: HASH, fileIndex: 1, releaseKey: `${HASH}:1` },
        }),
      };
    }));

    render(<ReleasesPage releases={releases} media={{ media }} loading={false} error={null} onBack={() => {}} />);
    fireEvent.click(screen.getByText('File.One.mkv').closest('.release-row-main')!);
    fireEvent.click(screen.getAllByText('Request this release')[0]);
    fireEvent.click(screen.getByText('Submit request'));

    await waitFor(() => expect(submitted).toBeTruthy());
    expect(submitted).toMatchObject({
      type: 'series',
      mediaId: 'tt2085059:7:3',
      release: { infoHash: HASH, fileIndex: 1, releaseKey: `${HASH}:1` },
    });
  });
});
