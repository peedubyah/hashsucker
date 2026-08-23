import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReleaseRow } from './ReleaseRow';
import { mockReleases } from '../test/fixtures';

describe('ReleaseRow', () => {
  it('renders filename and rank', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} />);
    expect(screen.getByText('Black.Mirror.S07E03.2160p.WEB-DL.DV.HDR10.mkv')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
  });

  it('renders score in debug mode', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} viewMode="debug" />);
    expect(screen.getByText('0.85')).toBeTruthy();
  });

  it('hides score in user mode', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} viewMode="user" />);
    expect(screen.queryByText('0.85')).toBeNull();
  });

  it('renders size', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} />);
    expect(screen.getByText('8.0 GB')).toBeTruthy();
  });

  it('renders badges for resolution, quality, codec', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} />);
    expect(screen.getByText('2160p')).toBeTruthy();
    expect(screen.getByText('WEB-DL')).toBeTruthy();
    expect(screen.getByText('x265')).toBeTruthy();
    expect(screen.getByText('HDR')).toBeTruthy();
  });

  it('renders source badge', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} />);
    expect(screen.getByText('DMM')).toBeTruthy();
  });

  it('expands to show score, confidence, and provider evidence in debug mode', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} viewMode="debug" />);
    const main = screen.getByText('Black.Mirror.S07E03.2160p.WEB-DL.DV.HDR10.mkv').closest('.release-row-main')!;
    fireEvent.click(main);
    expect(screen.getByText('Score')).toBeTruthy();
    expect(screen.getByText('Confidence')).toBeTruthy();
    expect(screen.getByText('Provider evidence')).toBeTruthy();
  });

  it('hides score, confidence, infohash, and provider evidence in user mode', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} viewMode="user" />);
    const main = screen.getByText('Black.Mirror.S07E03.2160p.WEB-DL.DV.HDR10.mkv').closest('.release-row-main')!;
    fireEvent.click(main);
    expect(screen.queryByText('Score')).toBeNull();
    expect(screen.queryByText('Confidence')).toBeNull();
    expect(screen.queryByText('Provider evidence')).toBeNull();
    expect(screen.queryByText('InfoHash')).toBeNull();
  });

  it('expands a live result with empty score components without crashing', () => {
    const liveRelease = { ...mockReleases[0], _source: 'live' as const, components: {} };
    render(<ReleaseRow release={liveRelease} rank={1} viewMode="debug" />);
    fireEvent.click(screen.getByText(liveRelease.filename).closest('.release-row-main')!);
    expect(screen.getByText('Score')).toBeTruthy();
    expect(screen.queryByText('REL')).toBeNull();
  });

  it('shows request button when onSelect provided', () => {
    const onSelect = vi.fn();
    render(<ReleaseRow release={mockReleases[0]} rank={1} onSelect={onSelect} />);
    const main = screen.getByText('Black.Mirror.S07E03.2160p.WEB-DL.DV.HDR10.mkv').closest('.release-row-main')!;
    fireEvent.click(main);
    const requestBtn = screen.getByText('Select');
    fireEvent.click(requestBtn);
    expect(onSelect).toHaveBeenCalledWith(mockReleases[0]);
  });
});
