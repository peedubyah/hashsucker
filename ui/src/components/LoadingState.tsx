interface Props {
  message?: string;
}

export function LoadingState({ message = 'Loading...' }: Props) {
  return (
    <div className="loading-state">
      <div className="spinner" />
      <span>{message}</span>
    </div>
  );
}
