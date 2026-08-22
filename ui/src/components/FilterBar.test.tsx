import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterBar } from './FilterBar';
import { initialFilters } from './filter.types';

describe('FilterBar', () => {
  it('renders all filter controls', () => {
    const onChange = () => {};
    render(
      <FilterBar
        filters={initialFilters}
        onChange={onChange}
        resultCount={10}
        totalCount={20}
      />
    );
    expect(screen.getByPlaceholderText('Filter releases...')).toBeTruthy();
    expect(screen.getByText('All sources')).toBeTruthy();
    expect(screen.getByText('All resolutions')).toBeTruthy();
    expect(screen.getByText('All qualities')).toBeTruthy();
    expect(screen.getByText('Cache: any')).toBeTruthy();
    expect(screen.getByText('10/20')).toBeTruthy();
  });

  it('calls onChange when query changes', () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={initialFilters}
        onChange={onChange}
        resultCount={10}
        totalCount={20}
      />
    );
    const input = screen.getByPlaceholderText('Filter releases...');
    fireEvent.change(input, { target: { value: 'test' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ query: 'test' }));
  });

  it('calls onChange when source changes', () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={initialFilters}
        onChange={onChange}
        resultCount={10}
        totalCount={20}
      />
    );
    const select = screen.getByText('All sources').closest('select');
    fireEvent.change(select!, { target: { value: 'corpus' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ source: 'corpus' }));
  });
});
