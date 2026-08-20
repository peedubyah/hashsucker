/**
 * Canonical Discovery Candidate
 *
 * Represents a normalized media candidate from any discovery source.
 * Provider-agnostic and source-independent.
 *
 * providers: actual debrid/acquisition services (torbox, realdebrid)
 * sources: discovery sources that found this candidate (can be multiple)
 */

export function createCandidate({
  infoHash,
  fileIndex = null,
  title = null,
  size = null,
  seeders = null,
  leechers = null,
  publishDate = null,
  magnet = null,
  downloadUrl = null,
  trackers = [],
  source = null,
}) {
  const normalizedHash = normalizeHash(infoHash);
  if (!normalizedHash) {
    return null;
  }

  return {
    infoHash: normalizedHash,
    fileIndex,
    title,
    size,
    seeders,
    leechers,
    publishDate,
    magnet,
    downloadUrl,
    trackers: trackers || [],
    sources: source ? [sanitizeSource(source)] : [],
    providers: createDefaultProviderState(),
  };
}

function normalizeHash(hash) {
  if (!hash || typeof hash !== 'string') return null;
  const cleaned = hash.trim().toLowerCase();
  if (/^[a-f0-9]{40}$/.test(cleaned)) return cleaned;
  return null;
}

function sanitizeSource(source) {
  if (!source || typeof source !== 'object') return null;
  return {
    id: source.id || null,
    kind: source.kind || null,
    instance: source.instance || null,
    indexer: source.indexer || null,
    capability: source.capability || null,
  };
}

export function createDefaultProviderState() {
  return {
    torbox: { cached: null, evidence: null },
    realdebrid: { cached: null, evidence: null },
  };
}

export function candidateKey(candidate) {
  const hash = candidate.infoHash;
  const idx = candidate.fileIndex;
  return idx != null ? `${hash}:${idx}` : hash;
}

export function mergeCandidates(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged = { ...existing };

  if (incoming.title && !merged.title) merged.title = incoming.title;
  if (incoming.size != null && merged.size == null) merged.size = incoming.size;
  if (incoming.seeders != null && merged.seeders == null) merged.seeders = incoming.seeders;
  if (incoming.leechers != null && merged.leechers == null) merged.leechers = incoming.leechers;
  if (incoming.publishDate && !merged.publishDate) merged.publishDate = incoming.publishDate;
  if (incoming.magnet && !merged.magnet) merged.magnet = incoming.magnet;
  if (incoming.downloadUrl && !merged.downloadUrl) merged.downloadUrl = incoming.downloadUrl;

  if (!merged.source && incoming.source) merged.source = incoming.source;

  return merged;
}
