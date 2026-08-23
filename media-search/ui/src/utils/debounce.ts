/**
 * Create a debounced function that delays invoking `fn` until after
 * `delay` milliseconds have elapsed since the last time the debounced
 * function was invoked.
 *
 * @param fn - Function to debounce
 * @param delay - Milliseconds to wait
 * @returns Debounced function with pending() check
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): ((...args: A) => void) & { pending: () => boolean } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function debounced(...args: A) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  }

  debounced.pending = () => timer !== null;

  return debounced;
}
