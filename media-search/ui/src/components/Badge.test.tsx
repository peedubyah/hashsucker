import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders children', () => {
    render(<Badge>Test</Badge>);
    expect(screen.getByText('Test')).toBeTruthy();
  });

  it('applies variant class', () => {
    const { container } = render(<Badge variant="success">OK</Badge>);
    expect(container.querySelector('.badge-success')).toBeTruthy();
  });

  it('applies default variant class', () => {
    const { container } = render(<Badge>Default</Badge>);
    expect(container.querySelector('.badge-default')).toBeTruthy();
  });

  it('renders title attribute', () => {
    render(<Badge title="tooltip">Hover</Badge>);
    expect(screen.getByText('Hover').getAttribute('title')).toBe('tooltip');
  });
});
