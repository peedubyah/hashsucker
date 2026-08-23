import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OperatorDiagnostics } from './OperatorDiagnostics';
import type { OperatorDiagnostic, OperatorDiagnosticResult } from '@/types/api';

const mockDiagnostics: OperatorDiagnostic[] = [
  {
    id: 'stream-smoke',
    name: 'Stream Pipeline',
    description: 'TorBox connectivity, cache check, requestdl, strm creation',
  },
  {
    id: 'control-plane',
    name: 'Control Plane',
    description: 'Reconciliation and lifecycle projection',
  },
];

const mockResult: OperatorDiagnosticResult = {
  id: 'stream-smoke',
  name: 'Stream Pipeline',
  status: 'pass',
  exitCode: 0,
  duration: 2.4,
  stdout: 'TorBox API: PASS\nCache lookup: PASS',
  stderr: '',
  ranAt: '2026-08-23T12:00:00Z',
};

describe('OperatorDiagnostics', () => {
  it('renders diagnostics heading', () => {
    render(
      <OperatorDiagnostics
        diagnostics={mockDiagnostics}
        result={null}
        loading={false}
        onLoad={() => {}}
        onRun={() => {}}
      />
    );
    expect(screen.getByText('Diagnostics')).toBeTruthy();
  });

  it('renders diagnostic cards', () => {
    render(
      <OperatorDiagnostics
        diagnostics={mockDiagnostics}
        result={null}
        loading={false}
        onLoad={() => {}}
        onRun={() => {}}
      />
    );
    expect(screen.getByText('Stream Pipeline')).toBeTruthy();
    expect(screen.getByText('Control Plane')).toBeTruthy();
    expect(screen.getByText('TorBox connectivity, cache check, requestdl, strm creation')).toBeTruthy();
  });

  it('calls onRun when run button clicked', () => {
    const onRun = vi.fn();
    render(
      <OperatorDiagnostics
        diagnostics={mockDiagnostics}
        result={null}
        loading={false}
        onLoad={() => {}}
        onRun={onRun}
      />
    );
    const runButtons = screen.getAllByText('Run');
    fireEvent.click(runButtons[0]);
    expect(onRun).toHaveBeenCalledWith('stream-smoke');
  });

  it('renders diagnostic result', () => {
    render(
      <OperatorDiagnostics
        diagnostics={mockDiagnostics}
        result={mockResult}
        loading={false}
        onLoad={() => {}}
        onRun={() => {}}
      />
    );
    expect(screen.getByText('PASS')).toBeTruthy();
    expect(screen.getByText('Duration: 2.4s')).toBeTruthy();
    expect(screen.getByText('Output')).toBeTruthy();
  });

  it('renders fail result', () => {
    const failResult: OperatorDiagnosticResult = {
      ...mockResult,
      status: 'fail',
      stderr: 'TorBox token missing',
    };
    render(
      <OperatorDiagnostics
        diagnostics={mockDiagnostics}
        result={failResult}
        loading={false}
        onLoad={() => {}}
        onRun={() => {}}
      />
    );
    expect(screen.getByText('FAIL')).toBeTruthy();
    expect(screen.getByText('Errors')).toBeTruthy();
  });
});
