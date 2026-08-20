const API_BASE = 'https://api.torbox.app/v1/api';
const BATCH_SIZE = 10;
const REQUEST_TIMEOUT_MS = 2000;

function chunk(array, size) {
  const chunks = [];

  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }

  return chunks;
}

export async function checkTorBoxCached(hashes) {
  const apiKey = process.env.TORBOX_API_KEY;

  if (!apiKey) {
    throw new Error('TORBOX_API_KEY is missing');
  }

  const normalizedHashes = [
    ...new Set(
      hashes
        .filter(Boolean)
        .map((hash) => String(hash).trim().toLowerCase())
    ),
  ];

  const cached = new Set();
  const details = new Map();
  const failed = new Set();

  for (const batch of chunk(normalizedHashes, BATCH_SIZE)) {
    try {
      const params = new URLSearchParams({
        format: 'object',
        list_files: 'false',
      });

      for (const hash of batch) {
        params.append('hash', hash);
      }

      const response = await fetch(
        `${API_BASE}/torrents/checkcached?${params}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'User-Agent': 'media-search/0.0.1',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );

      if (!response.ok) {
        const error = new Error(
          `TorBox cache check failed: HTTP ${response.status}`
        );
        error.status = response.status;
        throw error;
      }

      const payload = await response.json();

      if (!payload?.success) {
        const error = new Error(
          payload?.detail ||
          payload?.error ||
          'TorBox cache check failed'
        );
        error.code = payload?.error || null;
        throw error;
      }

      const data = payload.data || {};

      for (const [hash, value] of Object.entries(data)) {
        if (!value) continue;

        const normalized = hash.toLowerCase();
        cached.add(normalized);
        details.set(normalized, value);
      }
    } catch (error) {
      // Authentication is global, not a per-batch cache miss.
      if (
        error?.status === 401 ||
        error?.status === 403 ||
        error?.code === 'BAD_TOKEN' ||
        error?.code === 'AUTH_ERROR'
      ) {
        throw error;
      }

      for (const hash of batch) {
        failed.add(hash);
      }

      console.error(
        `TorBox cache batch unavailable (${batch.length} hashes): ${error.message}`
      );
    }
  }

  return {
    cached,
    details,
    failed,
  };
}
