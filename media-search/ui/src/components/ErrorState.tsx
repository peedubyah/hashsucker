interface Props {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: Props) {
  return (
    <div className="error-state">
      <span className="error-icon">⚠</span>
      <span className="error-message">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="retry-button">
          Retry
        </button>
      )}
    </div>
  );
}
