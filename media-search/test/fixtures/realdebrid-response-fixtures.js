export const RD_HASH = 'abcdef1234567890abcdef1234567890abcdef12';

export const RD_MAGNET = `magnet:?xt=urn:btih:${RD_HASH}&dn=example-file.mkv`;

export const RD_TORRENT_ID = 'ABC123XYZ';

export function rdAddMagnetSuccess(id = RD_TORRENT_ID) {
  return {
    id,
    uri: `https://real-debrid.com/torrents/${id}`,
  };
}

export function rdAddMagnetMalformed() {
  return {
    uri: 'https://real-debrid.com/torrents/',
  };
}

export function rdTorrentInfoDownloaded(progress = 100) {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress,
    status: 'downloaded',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
    ended: '2026-08-23T10:05:00.000Z',
  };
}

export function rdTorrentInfoDownloading(progress = 45) {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress,
    status: 'downloading',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdTorrentInfoWaitingFilesSelection() {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 0,
    status: 'waiting_files_selection',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdTorrentInfoMagnetConversion() {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 0,
    status: 'magnet_conversion',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdTorrentInfoQueued() {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 0,
    status: 'queued',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdTorrentInfoCompressing() {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 90,
    status: 'compressing',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdTorrentInfoUploading() {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 95,
    status: 'uploading',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdTorrentInfoError() {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 0,
    status: 'error',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdTorrentInfoDead() {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 0,
    status: 'dead',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdTorrentInfoVirus() {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 0,
    status: 'virus',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdTorrentInfoUnknownStatus() {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 0,
    status: 'some_new_status',
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdTorrentInfoMalformed() {
  return {
    id: RD_TORRENT_ID,
    filename: 'example-file.mkv',
    hash: RD_HASH,
    bytes: 1_000_000_000,
    original_bytes: 1_000_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 0,
    added: '2026-08-23T10:00:00.000Z',
    links: [],
  };
}

export function rdAuthError() {
  const error = new Error('Unauthorized');
  error.status = 401;
  return error;
}

export function rdInvalidRequestError() {
  const error = new Error('Bad Request');
  error.status = 400;
  return error;
}

export function rdRateLimitError() {
  const error = new Error('Too Many Requests');
  error.status = 429;
  return error;
}

export function rdServerError() {
  const error = new Error('Internal Server Error');
  error.status = 500;
  return error;
}
