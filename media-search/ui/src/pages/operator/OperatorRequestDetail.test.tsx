import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OperatorRequestDetail } from './OperatorRequestDetail';
import type { OperatorRequestDetail as OperatorRequestDetailType } from '@/types/api';

const mockDetail: OperatorRequestDetailType = {
  requestId: 'abc12345-1234-1234-1234-123456789abc',
  status: 'failed',
  request: {
    mediaTitle: 'Batman',
    mediaId: 'tt0133093',
    releaseTitle: 'Batman.1989.2160p',
    lastError: 'TorBox file_id missing',
    updatedAt: '2026-08-23T12:05:00Z',
  },
  trace: {
    current: {
      state: 'failed',
      owner: 'torbox',
      nextAction: 'Awaiting retry or deletion',
    },
    timeline: [
      { timestamp: '2026-08-23T12:00:00Z', label: 'Request created', status: 'complete' },
      { timestamp: '2026-08-23T12:00:01Z', label: 'Handoff created', status: 'complete' },
      { timestamp: '2026-08-23T12:00:05Z', label: 'Failed: TorBox file_id missing', status: 'error' },
    ],
  },
};

describe('OperatorRequestDetail', () => {
  it('renders request ID', () => {
    render(
      <OperatorRequestDetail
        detail={mockDetail}
        onBack={() => {}}
        onRetry={() => Promise.resolve()}
        onReset={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />
    );
    expect(screen.getByText('Request')).toBeTruthy();
  });

  it('renders status badge', () => {
    render(
      <OperatorRequestDetail
        detail={mockDetail}
        onBack={() => {}}
        onRetry={() => Promise.resolve()}
        onReset={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />
    );
    expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
  });

  it('renders timeline', () => {
    render(
      <OperatorRequestDetail
        detail={mockDetail}
        onBack={() => {}}
        onRetry={() => Promise.resolve()}
        onReset={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />
    );
    expect(screen.getByText('Request created')).toBeTruthy();
    expect(screen.getByText('Handoff created')).toBeTruthy();
    expect(screen.getByText('Failed: TorBox file_id missing')).toBeTruthy();
  });

  it('renders current state', () => {
    render(
      <OperatorRequestDetail
        detail={mockDetail}
        onBack={() => {}}
        onRetry={() => Promise.resolve()}
        onReset={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />
    );
    expect(screen.getByText('Awaiting retry or deletion')).toBeTruthy();
  });

  it('calls onRetry when retry button clicked', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(
      <OperatorRequestDetail
        detail={mockDetail}
        onBack={() => {}}
        onRetry={onRetry}
        onReset={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />
    );
    fireEvent.click(screen.getByText('Retry Request'));
    expect(onRetry).toHaveBeenCalledWith('abc12345-1234-1234-1234-123456789abc');
  });

  it('calls onReset when reset button clicked', async () => {
    const onReset = vi.fn().mockResolvedValue(undefined);
    render(
      <OperatorRequestDetail
        detail={mockDetail}
        onBack={() => {}}
        onRetry={() => Promise.resolve()}
        onReset={onReset}
        onDelete={() => Promise.resolve()}
      />
    );
    fireEvent.click(screen.getByText('Reset to Pending'));
    expect(onReset).toHaveBeenCalledWith('abc12345-1234-1234-1234-123456789abc');
  });

  it('shows delete confirmation', () => {
    render(
      <OperatorRequestDetail
        detail={mockDetail}
        onBack={() => {}}
        onRetry={() => Promise.resolve()}
        onReset={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />
    );
    fireEvent.click(screen.getByText('Remove Request'));
    expect(screen.getByText('Confirm Delete')).toBeTruthy();
  });

  it('toggles raw payload', () => {
    render(
      <OperatorRequestDetail
        detail={mockDetail}
        onBack={() => {}}
        onRetry={() => Promise.resolve()}
        onReset={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />
    );
    // Raw payload should not be visible initially
    expect(document.querySelector('.operator-raw')).toBeNull();
    // Click to expand - find button by partial text match
    const toggleBtn = screen.getByText(/Raw Payload/);
    fireEvent.click(toggleBtn);
    expect(document.querySelector('.operator-raw')).toBeTruthy();
  });

  it('calls onBack when back button clicked', () => {
    const onBack = vi.fn();
    render(
      <OperatorRequestDetail
        detail={mockDetail}
        onBack={onBack}
        onRetry={() => Promise.resolve()}
        onReset={() => Promise.resolve()}
        onDelete={() => Promise.resolve()}
      />
    );
    fireEvent.click(screen.getByText('← Back'));
    expect(onBack).toHaveBeenCalled();
  });
});
