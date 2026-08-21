import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReleaseRow } from './ReleaseRow';
import { mockReleases } from '../test/fixtures';

describe('ReleaseRow', () => {
  it('renders filename and rank', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} />);
    expect(screen.getByText('Black.Mirror.S07E03.2160p.WEB-DL.DV.HDR10.mkv')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
  });

  it('renders score', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} />);
    expect(screen.getByText('0.85')).toBeTruthy();
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

  it('expands details on click', () => {
    render(<ReleaseRow release={mockReleases[0]} rank={1} />);
    const main = screen.getByText('Black.Mirror.S07E03.2160p.WEB-DL.DV.HDR10.mkv').closest('.release-row-main')!;
    fireEvent.click(main);
    expect(screen.getByText('Score')).toBeTruthy();
    expect(screen.getByText('Confidence')).toBeTruthy();
    expect(screen.getByText('Providers')).toBeTruthy();
  });

  it('shows request button when onSelect provided', () => {
    const onSelect = vi.fn();
    render(<ReleaseRow release={mockReleases[0]} rank={1} onSelect={onSelect} />);
    const main = screen.getByText('Black.Mirror.S07E03.2160p.WEB-DL.DV.HDR10.mkv').closest('.release-row-main')!;
    fireEvent.click(main);
    const requestBtn = screen.getByText('Request this release');
    fireEvent.click(requestBtn);
    expect(onSelect).toHaveBeenCalledWith(mockReleases[0]);
  });
});
