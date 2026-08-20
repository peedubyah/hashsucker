/**
 * Discovery Merger
 *
 * Centralized merge/dedupe logic for discovery candidates.
 * Handles identity rules, provenance preservation, and provider state.
 */

export function mergeCandidates(candidates) {
  const byKey = new Map();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    byKey.set(key, mergeTwoCandidates(existing, candidate));
  }

  return [...byKey.values()];
}

function candidateKey(candidate) {
  const hash = candidate.infoHash;
  const idx = candidate.fileIndex;
  return idx != null ? `${hash}:${idx}` : hash;
}

function mergeTwoCandidates(existing, incoming) {
  const merged = { ...existing };

  // Preserve non-null metadata
  if (incoming.title && !merged.title) merged.title = incoming.title;
  if (incoming.size != null && merged.size == null) merged.size = incoming.size;
  if (incoming.seeders != null && merged.seeders == null) merged.seeders = incoming.seeders;
  if (incoming.leechers != null && merged.leechers == null) merged.leechers = incoming.leechers;
  if (incoming.publishDate && !merged.publishDate) merged.publishDate = incoming.publishDate;
  if (incoming.magnet && !merged.magnet) merged.magnet = incoming.magnet;
  if (incoming.downloadUrl && !merged.downloadUrl) merged.downloadUrl = incoming.downloadUrl;

  // Merge sources — preserve ALL unique sources that contributed
  if (incoming.sources && Array.isArray(incoming.sources)) {
    const existingSources = Array.isArray(merged.sources) ? merged.sources : [];
    for (const source of incoming.sources) {
      if (!sourceExistsInArray(existingSources, source)) {
        existingSources.push(source);
      }
    }
    merged.sources = existingSources;
  }

  // Merge provider state
  if (incoming.providers) {
    merged.providers = mergeProviders(existing.providers, incoming.providers);
  }

  return merged;
}

function sourceExistsInArray(sources, candidate) {
  if (!candidate) return false;
  return sources.some(
    (s) => s.id === candidate.id && s.kind === candidate.kind
  );
}

function mergeProviders(existing = {}, incoming = {}) {
  const merged = { ...existing };

  for (const [provider, state] of Object.entries(incoming)) {
    if (!merged[provider]) {
      merged[provider] = state;
    } else if (state.cached === true) {
      merged[provider] = state;
    } else if (state.cached === null && merged[provider].cached !== true) {
      merged[provider] = state;
    }
  }

  return merged;
}

export function dedupeCandidates(candidates) {
  const seen = new Map();
  const deduped = [];

  for (const candidate of candidates) {
    const key = candidate.infoHash;
    if (seen.has(key)) {
      const existing = seen.get(key);
      seen.set(key, mergeTwoCandidates(existing, candidate));
    } else {
      seen.set(key, candidate);
      deduped.push(candidate);
    }
  }

  return deduped.map((candidate) => seen.get(candidate.infoHash) || candidate);
}
