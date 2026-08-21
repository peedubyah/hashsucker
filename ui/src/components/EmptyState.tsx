import type { ReactNode } from 'react';

interface Props {
  message?: string;
  icon?: ReactNode;
  children?: ReactNode;
}

export function EmptyState({ message = 'No results found.', icon, children }: Props) {
  return (
    <div className="empty-state">
      {icon && <span className="empty-state-icon">{icon}</span>}
      <span className="empty-state-message">{message}</span>
      {children}
    </div>
  );
}
