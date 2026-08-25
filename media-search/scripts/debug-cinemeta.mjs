#!/usr/bin/env node
/**
 * Debug Cinemeta metadata resolver
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  const envPath = path.join(ROOT, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

async function rawFetch(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'media-search/0.1.0' },
  });
  const status = response.status;
  const text = await response.text();
  return { status, text };
}

const queries = [
  'Dragon Ball Super Super Hero 2022',
  'Dragon Ball',
  'Reacher',
  'The Shawshank Redemption',
];

for (const query of queries) {
  console.log('\n' + '═'.repeat(70));
  console.log('QUERY:', JSON.stringify(query));
  console.log('═'.repeat(70));

  const encoded = encodeURIComponent(query);
  const seriesUrl = `${CINEMETA_BASE}/catalog/series/top/search=${encoded}.json`;
  const movieUrl = `${CINEMETA_BASE}/catalog/movie/top/search=${encoded}.json`;

  console.log('Series URL:', seriesUrl);
  console.log('Movie URL:', movieUrl);

  const seriesRes = await rawFetch(seriesUrl);
  console.log('\nSeries response: HTTP', seriesRes.status, '(', seriesRes.text.length, 'bytes )');

  // Show first 500 chars of response
  console.log('Series body preview:');
  console.log(seriesRes.text.slice(0, 800));
  console.log('...');
}
