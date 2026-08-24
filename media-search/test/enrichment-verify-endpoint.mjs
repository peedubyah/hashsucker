#!/usr/bin/env node
/**
 * Verify Cinemeta search endpoint returns distinct results for different queries.
 * Endpoint: /catalog/{type}/top/search={query}.json
 */

const BASE = 'https://v3-cinemeta.strem.io';
const queries = ['The Matrix', 'Breaking Bad', 'Yu-Gi-Oh! Arc-V', 'Air Crash Investigation'];

async function search(query) {
  const encoded = encodeURIComponent(query);
  const results = [];
  for (const type of ['movie', 'series']) {
    const url = `${BASE}/catalog/${type}/top/search=${encoded}.json`;
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'media-search/0.1.0' },
      });
      const data = await res.json();
      if (data.metas) {
        results.push(...data.metas);
      }
    } catch (err) {
      console.error(`  Error for type=${type}:`, err.message);
    }
  }
  return results;
}

for (const query of queries) {
  console.log('\n' + '='.repeat(60));
  console.log('QUERY:', query);
  console.log('='.repeat(60));
  
  const results = await search(query);
  console.log(`Total results: ${results.length}`);
  console.log('First 3:');
  for (const meta of results.slice(0, 3)) {
    console.log(`  - ${meta.name} (${meta.year || meta.releaseInfo}) [${meta.type}] imdb=${meta.id}`);
  }
}

console.log('\n');
