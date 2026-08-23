import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OperatorLogs } from './OperatorLogs';
import type { OperatorLogs as OperatorLogsType } from '@/types/api';

const mockLogs: OperatorLogsType = {
  logs: [
    {
      requestId: 'abc12345-1234-1234-1234-123456789abc',
      status: 'processing',
      lastError: null,
      updatedAt: '2026-08-23T12:04:31Z',
    },
    {
      requestId: 'def67890-5678-5678-5678-987654321def',
      status: 'failed',
      lastError: 'missing file_id',
      updatedAt: '2026-08-23T12:04:33Z',
    },
  ],
};

describe('OperatorLogs', () => {
  it('renders worker activity heading', () => {
    render(
      <OperatorLogs
        logs={mockLogs}
        loading={false}
        onLoad={() => {}}
      />
    );
    expect(screen.getByText('Worker Activity')).toBeTruthy();
  });

  it('renders log entries', () => {
    render(
      <OperatorLogs
        logs={mockLogs}
        loading={false}
        onLoad={() => {}}
      />
    );
    expect(screen.getByText('12:04:31')).toBeTruthy();
    expect(screen.getByText('processing')).toBeTruthy();
    expect(screen.getByText('missing file_id')).toBeTruthy();
  });

  it('renders empty state', () => {
    render(
      <OperatorLogs
        logs={{ logs: [] }}
        loading={false}
        onLoad={() => {}}
      />
    );
    expect(screen.getByText('No recent activity.')).toBeTruthy();
  });

  it('calls onLoad with limit', () => {
    const onLoad = vi.fn();
    render(
      <OperatorLogs
        logs={mockLogs}
        loading={false}
        onLoad={onLoad}
      />
    );
    fireEvent.click(screen.getByText('Last 100'));
    expect(onLoad).toHaveBeenCalledWith(100);
  });
});
