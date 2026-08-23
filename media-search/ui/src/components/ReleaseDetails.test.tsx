import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReleaseResult } from '@/types/api';
import { ReleaseDetails } from './ReleaseDetails';

const release: ReleaseResult = {
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
};

describe('ReleaseDetails user mode', () => {
  it('renders heading', () => {
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
    expect(screen.getByText('Choose this version')).toBeTruthy();
  });

  it('renders quality summary with resolution and codec', () => {
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
    expect(screen.getByText('2160p')).toBeTruthy();
    expect(screen.getByText('x265')).toBeTruthy();
    expect(screen.getByText('HDR')).toBeTruthy();
  });

  it('renders handling mode selection', () => {
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
    // Radio labels exist
    expect(screen.getAllByText('Download').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Stream').length).toBeGreaterThan(0);
    expect(screen.getByText('What would you like to do?')).toBeTruthy();
  });

  it('does NOT expose system internals in user mode', () => {
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
    expect(screen.queryByText(/Debug:/)).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
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
    // Click the radio label first
    fireEvent.click(screen.getAllByText('Stream')[0]);
    // Then click the action button
    fireEvent.click(screen.getByRole('button', { name: 'Stream' }));
    expect(submittedMode).toBe('stream');
  });

  it('shows request result with status', () => {
    render(
      <ReleaseDetails
        release={release}
        onClose={() => {}}
        onSubmit={() => {}}
        requesting={false}
        requestResult={{
          requestId: 'test-uuid-1234',
          status: 'queued',
          release: {
            infoHash: release.infoHash,
            fileIndex: release.fileIndex,
            releaseKey: release.releaseKey,
          },
        }}
        requestError={null}
      />
    );
    expect(screen.getByText('Added to your library')).toBeTruthy();
    // Handling options should not be shown after submission
    expect(screen.queryByText('What would you like to do?')).toBeNull();
  });

  it('shows request error', () => {
    render(
      <ReleaseDetails
        release={release}
        onClose={() => {}}
        onSubmit={() => {}}
        requesting={false}
        requestResult={null}
        requestError="Something went wrong"
      />
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });

  it('shows filename in advanced section', () => {
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
    fireEvent.click(screen.getByText('▸ Show details'));
    expect(screen.getByText('Test.Release.2160p.mkv')).toBeTruthy();
  });

  it('shows release group in advanced section', () => {
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
    fireEvent.click(screen.getByText('▸ Show details'));
    expect(screen.getByText('TEST')).toBeTruthy();
  });
});

describe('ReleaseDetails debug mode', () => {
  it('exposes system internals in debug mode', () => {
    render(
      <ReleaseDetails
        release={release}
        onClose={() => {}}
        onSubmit={() => {}}
        requesting={false}
        requestResult={null}
        requestError={null}
        viewMode="debug"
      />
    );
    expect(screen.getByText('Debug: System Internals')).toBeTruthy();
    expect(screen.getByText('0.85')).toBeTruthy();
    expect(screen.getByText('0.92')).toBeTruthy();
    expect(screen.getByText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeTruthy();
  });
});
