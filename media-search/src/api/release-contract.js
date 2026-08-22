const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/;

const PUBLIC_RELEASE_FIELDS = [
  'title',
  'filename',
  'size',
  'resolution',
  'quality',
  'codec',
  'hdr',
  'audio',
  'releaseGroup',
  'year',
  'season',
  'episode',
  'confidence',
  'score',
  'components',
  'providers',
  'providerObservations',
  'media',
  '_source',
  '_sources',
  '_selectedMediaId',
];

function requireReleaseObject(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('release is required');
  }
  return release;
}

function normalizeInfoHash(infoHash) {
  const normalized = typeof infoHash === 'string' ? infoHash.toLowerCase() : '';
  if (!INFO_HASH_PATTERN.test(normalized)) {
    throw new Error('infoHash must be 40 hexadecimal characters');
  }
  return normalized;
}

function validateFileIndex(fileIndex) {
  if (fileIndex !== null && (!Number.isSafeInteger(fileIndex) || fileIndex < 0)) {
    throw new Error('fileIndex must be null or a non-negative integer');
  }
  return fileIndex;
}

/**
 * Build canonical physical release identity. Null is torrent-level evidence and
 * is deliberately distinct from file index zero.
 */
export function createReleaseIdentity(infoHash, fileIndex) {
  const normalizedHash = normalizeInfoHash(infoHash);
  const normalizedIndex = validateFileIndex(fileIndex);
  return {
    infoHash: normalizedHash,
    fileIndex: normalizedIndex,
    releaseKey: `${normalizedHash}:${normalizedIndex === null ? 'torrent' : normalizedIndex}`,
  };
}

export function createReleaseKey(infoHash, fileIndex) {
  return createReleaseIdentity(infoHash, fileIndex).releaseKey;
}

/**
 * Validate an exact release DTO supplied at a public boundary.
 */
export function validateReleaseIdentity(release) {
  const value = requireReleaseObject(release);
  if (!Object.hasOwn(value, 'fileIndex')) {
    throw new Error('fileIndex is required');
  }
  if (!Object.hasOwn(value, 'releaseKey')) {
    throw new Error('releaseKey is required');
  }

  const identity = createReleaseIdentity(value.infoHash, value.fileIndex);
  if (value.releaseKey !== identity.releaseKey) {
    throw new Error('releaseKey must match infoHash and fileIndex');
  }
  return identity;
}

/**
 * Validate and project the supported public release response shape. Projection
 * prevents discovery-only fields such as magnets, provider URLs, or raw addon
 * payloads from crossing the HTTP boundary.
 *
 * Provenance fields (_sources, _selectedMediaId) are optional — they default to
 * empty array / null when absent. This preserves backward compatibility while
 * ensuring that when provenance evidence exists, it survives to the public DTO.
 */
export function toPublicReleaseDto(release) {
  const value = requireReleaseObject(release);
  const identity = validateReleaseIdentity(value);

  // Required fields (excluding optional provenance/evidence added after v1)
  const requiredFields = PUBLIC_RELEASE_FIELDS.filter(
    f => f !== '_sources' && f !== '_selectedMediaId' && f !== 'providerObservations'
  );
  for (const field of requiredFields) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`Public release is missing ${field}`);
    }
  }

    // Provenance/evidence fields are optional with sensible defaults
    const sources = Array.isArray(value._sources) ? value._sources : [];
    const selectedMediaId = value._selectedMediaId ?? null;
    const providerObservations = Array.isArray(value.providerObservations)
      ? value.providerObservations
      : [];

  return Object.fromEntries([
    ...Object.entries(identity),
    ...PUBLIC_RELEASE_FIELDS.map((field) => {
      if (field === '_sources') return [field, sources];
      if (field === '_selectedMediaId') return [field, selectedMediaId];        if (field === 'providerObservations') return [field, providerObservations];      return [field, value[field]];
    }),
  ]);
}

/**
 * Read an existing protocol-v1 handoff. Legacy v1 files omitted both exact
 * identity fields and are interpreted as torrent-level evidence. New payloads
 * must carry both fields and pass exact validation.
 */
export function readHandoffReleaseIdentity(release) {
  const value = requireReleaseObject(release);
  const hasFileIndex = Object.hasOwn(value, 'fileIndex');
  const hasReleaseKey = Object.hasOwn(value, 'releaseKey');
  if (!hasFileIndex && !hasReleaseKey) {
    return createReleaseIdentity(value.infoHash, null);
  }
  if (hasFileIndex !== hasReleaseKey) {
    throw new Error('fileIndex and releaseKey must be provided together');
  }
  return validateReleaseIdentity(value);
}
