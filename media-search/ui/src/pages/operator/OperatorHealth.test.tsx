import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OperatorHealth } from './OperatorHealth';
import type { OperatorHealth as OperatorHealthType } from '@/types/api';

const mockHealth: OperatorHealthType = {
  ok: true,
  checks: {
    database: {
      name: 'Database',
      status: 'ok',
      detail: '24 requests (3 processing, 2 failed)',
      byState: { incoming: 7, processing: 3, done: 12, failed: 2 },
    },
    worker: {
      name: 'Worker',
      status: 'ok',
      detail: '3 active',
    },
    storage: {
      name: 'Storage',
      status: 'ok',
      detail: '12 .strm files, writable',
    },
  },
  generatedAt: '2026-08-23T12:00:00Z',
};

const mockUnhealthyHealth: OperatorHealthType = {
  ok: false,
  warning: true,
  checks: {
    database: {
      name: 'Database',
      status: 'ok',
      detail: '24 requests (3 processing, 2 failed)',
    },
    worker: {
      name: 'Worker',
      status: 'warning',
      detail: 'No active processing',
    },
    storage: {
      name: 'Storage',
      status: 'error',
      detail: '/strm: EACCES',
    },
  },
  generatedAt: '2026-08-23T12:00:00Z',
};

describe('OperatorHealth', () => {
  it('renders system status heading', () => {
    render(<OperatorHealth health={mockHealth} />);
    expect(screen.getByText('System Status')).toBeTruthy();
  });

  it('renders all health cards', () => {
    render(<OperatorHealth health={mockHealth} />);
    expect(screen.getByText('Database')).toBeTruthy();
    expect(screen.getByText('Worker')).toBeTruthy();
    expect(screen.getByText('Storage')).toBeTruthy();
  });

  it('renders request breakdown', () => {
    render(<OperatorHealth health={mockHealth} />);
    expect(screen.getByText('Active Work')).toBeTruthy();
    expect(screen.getByText('processing')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('renders warning state', () => {
    render(<OperatorHealth health={mockUnhealthyHealth} />);
    expect(screen.getByText('⚠')).toBeTruthy();
  });

  it('renders error state', () => {
    render(<OperatorHealth health={mockUnhealthyHealth} />);
    expect(screen.getByText(/EACCES/)).toBeTruthy();
  });
});
