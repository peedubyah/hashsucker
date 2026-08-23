import type { ReactNode } from 'react';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'corpus' | 'live';

interface Props {
  children: ReactNode;
  variant?: BadgeVariant;
  title?: string;
  className?: string;
}

export function Badge({ children, variant = 'default', title, className = '' }: Props) {
  return (
    <span className={`badge badge-${variant} ${className}`} title={title}>
      {children}
    </span>
  );
}
