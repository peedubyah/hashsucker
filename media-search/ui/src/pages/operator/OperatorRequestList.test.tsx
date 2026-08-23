import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OperatorRequestList } from './OperatorRequestList';
import type { OperatorRequestList as OperatorRequestListType } from '@/types/api';

const mockRequests: OperatorRequestListType = {
  requests: [
    {
      requestId: 'abc12345-1234-1234-1234-123456789abc',
      status: 'processing',
      createdAt: '2026-08-23T12:00:00Z',
      handlingMode: 'download',
      mediaTitle: 'Batman',
      mediaId: 'tt0133093',
      releaseTitle: 'Batman.1989.2160p',
      provider: 'torbox',
      lastError: null,
    },
    {
      requestId: 'def67890-5678-5678-5678-987654321def',
      status: 'failed',
      createdAt: '2026-08-23T11:00:00Z',
      handlingMode: 'download',
      mediaTitle: 'The Matrix',
      mediaId: 'tt0133093',
      releaseTitle: 'Matrix.1999.1080p',
      provider: 'torbox',
      lastError: 'TorBox file_id missing',
    },
    {
      requestId: 'ghi11111-9999-9999-9999-111111111ghi',
      status: 'done',
      createdAt: '2026-08-22T10:00:00Z',
      handlingMode: 'download',
      mediaTitle: 'Dune',
      mediaId: 'tt1160419',
      releaseTitle: 'Dune.2021.2160p',
      provider: 'torbox',
      lastError: null,
    },
  ],
  total: 3,
};

describe('OperatorRequestList', () => {
  it('renders request table', () => {
    render(
      <OperatorRequestList
        requests={mockRequests}
        onSelect={() => {}}
        onFilter={() => {}}
      />
    );
    expect(screen.getByText('Requests')).toBeTruthy();
    expect(screen.getByText('Batman')).toBeTruthy();
    expect(screen.getByText('The Matrix')).toBeTruthy();
    expect(screen.getByText('Dune')).toBeTruthy();
  });

  it('renders status badges', () => {
    render(
      <OperatorRequestList
        requests={mockRequests}
        onSelect={() => {}}
        onFilter={() => {}}
      />
    );
    // Badge renders status text - use getAllByText since Badge may render multiple
    expect(screen.getAllByText('processing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('done').length).toBeGreaterThan(0);
  });

  it('renders error messages for failed requests', () => {
    render(
      <OperatorRequestList
        requests={mockRequests}
        onSelect={() => {}}
        onFilter={() => {}}
      />
    );
    expect(screen.getByText('TorBox file_id missing')).toBeTruthy();
  });

  it('calls onSelect when row clicked', () => {
    const onSelect = vi.fn();
    render(
      <OperatorRequestList
        requests={mockRequests}
        onSelect={onSelect}
        onFilter={() => {}}
      />
    );
    fireEvent.click(screen.getByText('Batman'));
    expect(onSelect).toHaveBeenCalledWith('abc12345-1234-1234-1234-123456789abc');
  });

  it('renders filter buttons', () => {
    render(
      <OperatorRequestList
        requests={mockRequests}
        onSelect={() => {}}
        onFilter={() => {}}
      />
    );
    // Filter buttons render text - use getAllByText since multiple may exist
    expect(screen.getAllByText('all').length).toBeGreaterThan(0);
    expect(screen.getAllByText('queued').length).toBeGreaterThan(0);
    expect(screen.getAllByText('processing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('done').length).toBeGreaterThan(0);
  });

  it('renders empty state', () => {
    render(
      <OperatorRequestList
        requests={{ requests: [], total: 0 }}
        onSelect={() => {}}
        onFilter={() => {}}
      />
    );
    expect(screen.getByText('No requests match filter.')).toBeTruthy();
  });
});
