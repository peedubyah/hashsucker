import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReleaseResult } from '@/types/api';
import { ReleaseDetails } from './ReleaseDetails';

const release = {
  infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  fileIndex: null,
  releaseKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:torrent',
  title: 'Test Release',
  filename: 'Test.Release.2160p.mkv',
  size: 8589934592,
  resolution: '2160p',
  quality: 'WEB-DL',
  codec: 'x265',
  hdr: 'true',
  audio: 'DTS-HD',
  releaseGroup: 'TEST',
  year: 2023,
  season: 1,
  episode: 1,
  confidence: 0.92,
  score: 0.85,
  components: {},
  providers: {},
  providerObservations: [],
  media: [],
  _source: 'corpus',
} satisfies ReleaseResult;

describe('ReleaseDetails handling mode', () => {
  it('renders Download and Stream options', () => {
    render(
      <ReleaseDetails
        release={release}
        onClose={() => {}}
        onSubmit={() => {}}
        requesting={false}
        requestResult={null}
        requestError={null}
      />
    );
    expect(screen.getByText('Download')).toBeTruthy();
    expect(screen.getByText('Stream')).toBeTruthy();
  });

  it('passes handlingMode "download" by default when submitting', () => {
    let submittedMode: string | undefined;
    render(
      <ReleaseDetails
        release={release}
        onClose={() => {}}
        onSubmit={(mode) => { submittedMode = mode; }}
        requesting={false}
        requestResult={null}
        requestError={null}
      />
    );
    fireEvent.click(screen.getByText('Submit request'));
    expect(submittedMode).toBe('download');
  });

  it('passes handlingMode "stream" when Stream is selected', () => {
    let submittedMode: string | undefined;
    render(
      <ReleaseDetails
        release={release}
        onClose={() => {}}
        onSubmit={(mode) => { submittedMode = mode; }}
        requesting={false}
        requestResult={null}
        requestError={null}
      />
    );
    fireEvent.click(screen.getByText('Stream'));
    fireEvent.click(screen.getByText('Submit request'));
    expect(submittedMode).toBe('stream');
  });

  it('does not expose .strm terminology, provider details, or binding state', () => {
    render(
      <ReleaseDetails
        release={release}
        onClose={() => {}}
        onSubmit={() => {}}
        requesting={false}
        requestResult={null}
        requestError={null}
      />
    );
    expect(screen.queryByText(/\.strm/i)).toBeNull();
    expect(screen.queryByText(/binding/i)).toBeNull();
    expect(screen.queryByText(/repair/i)).toBeNull();
  });
});
