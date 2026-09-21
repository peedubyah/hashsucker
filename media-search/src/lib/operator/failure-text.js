/**
 * Human failure text for the appliance UI (and any future TUI).
 *
 * Machine state stays in the row (fail_category, last_error); this module
 * renders the one-line headline a household member can act on or safely
 * ignore, plus whether HashSucker already scheduled a retry. Technical
 * detail remains available behind expandable UI sections — never as the
 * primary message. No business logic lives here: pure mapping.
 */

function clean(error) {
  return String(error ?? '').slice(0, 300);
}

/**
 * Headline for a download/media job failure.
 * @param {{ category?: string|null, error?: string|null, retryPending?: boolean }} input
 */
export function humanizeFailure({ category = null, error = null, retryPending = false } = {}) {
  const cat = String(category ?? '').toLowerCase();
  const msg = clean(error);
  if (/rate|429|too_many|throttle/.test(cat) || /429|rate.?limit|too many requests/i.test(msg)) {
    return {
      headline: 'Provider temporarily rate-limited — retry scheduled',
      detail: msg, retryScheduled: true,
    };
  }
  if (/no-candidate|no_healthy|unresolvable|no eligible/.test(cat) || /no healthy|unresolvable/i.test(msg)) {
    return {
      headline: 'No healthy copy found yet',
      detail: msg || 'Discovery found no bindable TorrentFile for this intent.',
      retryScheduled: !!retryPending,
    };
  }
  if (/resolve-transient|unexpected-transient|transient|timeout|network|fetch failed|5\d\d/.test(cat)
    || /timed out|network|fetch failed|socket|temporar/i.test(msg)) {
    return {
      headline: 'Temporary hiccup — retry scheduled',
      detail: msg, retryScheduled: true,
    };
  }
  if (/deterministic-mismatch|size-mismatch|invalid|path-/.test(cat)
    || /size mismatch|sparse|escapes|positive .* size/i.test(msg)) {
    return {
      headline: 'Cannot fulfill as requested — needs attention',
      detail: msg, retryScheduled: false,
    };
  }
  if (/staged cleanup parked/i.test(msg)) {
    return {
      headline: 'Staged file kept — automatic cleanup gave up, file retained safely',
      detail: msg, retryScheduled: false,
    };
  }
  if (!msg) {
    return {
      headline: retryPending ? 'Working through a retry' : 'No failure recorded',
      detail: '', retryScheduled: !!retryPending,
    };
  }
  return { headline: `Needs attention — ${msg.slice(0, 80)}`, detail: msg, retryScheduled: !!retryPending };
}

/** Headline for a media-request row (status-only truth + candidate count). */
export function humanizeRequest({ status = null, candidateCount = 0 } = {}) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'failed' || s === 'error') {
    return candidateCount > 0
      ? { headline: 'Request failed after finding candidates', detail: '', retryScheduled: false }
      : { headline: 'No healthy copy found yet', detail: '', retryScheduled: false };
  }
  if (s === 'pending' || s === 'queued' || s === 'requested') {
    return { headline: 'Waiting to resolve', detail: '', retryScheduled: false };
  }
  if (s === 'processing' || s === 'resolving' || s === 'preparing') {
    return { headline: 'Resolving', detail: '', retryScheduled: false };
  }
  if (s === 'done' || s === 'published' || s === 'fulfilled' || s === 'completed') {
    return { headline: 'Fulfilled', detail: '', retryScheduled: false };
  }
  return { headline: s ? `State: ${s}` : 'Unknown state', detail: '', retryScheduled: false };
}
