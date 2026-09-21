import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Sane polling: fixed interval (default 30s), no refetch on focus storms,
 * pause when the tab is hidden. Returns [data, error, refresh].
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs = 30_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await fn());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [fn]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive || document.hidden) return;
      await refresh();
    };
    void tick();
    timer.current = window.setInterval(() => void tick(), intervalMs);
    return () => {
      alive = false;
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [refresh, intervalMs]);

  return [data, error, refresh] as const;
}
