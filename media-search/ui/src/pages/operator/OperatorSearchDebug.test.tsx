import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OperatorSearchDebug } from './OperatorSearchDebug';
import type { OperatorSearchDebug as OperatorSearchDebugType } from '@/types/api';

const mockResult: OperatorSearchDebugType = {
  query: 'Batman',
  total: 42,
  results: [
    {
      title: 'Batman.1989.2160p.REMUX',
      score: 92.4,
      components: { relevance: 30, quality: 20 },
      source: 'corpus',
    },
    {
      title: 'Batman.Begins.2005.1080p.BluRay',
      score: 87.1,
      components: { relevance: 28, quality: 18 },
      source: 'live',
    },
  ],
};

describe('OperatorSearchDebug', () => {
  it('renders search input', () => {
    render(
      <OperatorSearchDebug
        result={null}
        loading={false}
        onSearch={() => {}}
      />
    );
    expect(screen.getByPlaceholderText('Enter search query...')).toBeTruthy();
    expect(screen.getByText('Search')).toBeTruthy();
  });

  it('renders results table after search', () => {
    render(
      <OperatorSearchDebug
        result={mockResult}
        loading={false}
        onSearch={() => {}}
      />
    );
    expect(screen.getByText(/Query:/)).toBeTruthy();
    expect(screen.getByText('Batman')).toBeTruthy();
    expect(screen.getByText(/42 total/)).toBeTruthy();
    expect(screen.getByText('Batman.1989.2160p.REMUX')).toBeTruthy();
  });

  it('renders score and components', () => {
    render(
      <OperatorSearchDebug
        result={mockResult}
        loading={false}
        onSearch={() => {}}
      />
    );
    expect(screen.getByText('92.4')).toBeTruthy();
    expect(screen.getByText('30.0')).toBeTruthy();
  });

  it('disables search button for short queries', () => {
    render(
      <OperatorSearchDebug
        result={null}
        loading={false}
        onSearch={() => {}}
      />
    );
    const button = screen.getByText('Search');
    expect(button).toBeTruthy();
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('calls onSearch with query', () => {
    const onSearch = vi.fn();
    render(
      <OperatorSearchDebug
        result={null}
        loading={false}
        onSearch={onSearch}
      />
    );
    const input = screen.getByPlaceholderText('Enter search query...');
    fireEvent.change(input, { target: { value: 'Batman' } });
    fireEvent.click(screen.getByText('Search'));
    expect(onSearch).toHaveBeenCalledWith('Batman');
  });

  it('renders empty state', () => {
    render(
      <OperatorSearchDebug
        result={{ query: 'xyz', total: 0, results: [] }}
        loading={false}
        onSearch={() => {}}
      />
    );
    expect(screen.getByText('No candidates found.')).toBeTruthy();
  });
});
