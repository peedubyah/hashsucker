import { useCallback, useEffect, useState } from 'react';

export type QueryUpdates = Record<string, string | number | null | undefined>;

export function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export function updateQuery(updates: QueryUpdates, options: { replace?: boolean } = {}): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history[options.replace ? 'replaceState' : 'pushState']({}, '', next);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useUrlState(): [URLSearchParams, (updates: QueryUpdates, options?: { replace?: boolean }) => void] {
  const [params, setParams] = useState(() => readQuery());

  useEffect(() => {
    const handleNavigation = () => setParams(readQuery());
    window.addEventListener('popstate', handleNavigation);
    return () => window.removeEventListener('popstate', handleNavigation);
  }, []);

  const setQuery = useCallback((updates: QueryUpdates, options?: { replace?: boolean }) => {
    updateQuery(updates, options);
  }, []);

  return [params, setQuery];
}

export function getStoredNumber(key: string, fallback: number, allowed: readonly number[]): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function getStoredPreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = window.localStorage.getItem(key);
    if (value && (allowed as readonly string[]).includes(value)) return value as T;
  } catch {
    // Ignore storage errors and fall back to the default.
  }
  return fallback;
}

export function storePreference(key: string, value: string | number | boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Preferences must not prevent console operation when storage is unavailable.
  }
}
