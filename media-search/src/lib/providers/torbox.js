const API_BASE = 'https://api.torbox.app/v1/api';
const BATCH_SIZE = 100;

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

  for (const batch of chunk(normalizedHashes, BATCH_SIZE)) {
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
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `TorBox cache check failed: HTTP ${response.status}`
      );
    }

    const payload = await response.json();

    if (!payload?.success) {
      throw new Error(
        payload?.detail ||
        payload?.error ||
        'TorBox cache check failed'
      );
    }

    const data = payload.data || {};

    for (const [hash, value] of Object.entries(data)) {
      if (!value) continue;

      const normalized = hash.toLowerCase();

      cached.add(normalized);
      details.set(normalized, value);
    }
  }

  return {
    cached,
    details,
  };
}