import { filterReleases, isReleaseSelected, prepareReleases, releaseFilterOptions, releaseUtilityActions, requestPaneView, summarizeReleases } from './release-model.js?v=20260819-movie1';

const $ = (selector) => document.querySelector(selector);
const state = { media: null, season: null, episode: null, release: null, releases: [], requestId: null, requestEpisodeLabel: null, visible: 100, searchSequence: 0, searchController: null };

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function message(text = '', error = false) { $('#message').textContent = text; $('#message').className = error ? 'error' : ''; }
function size(bytes) { return bytes == null ? 'Size unknown' : `${(bytes / 1024 ** 3).toFixed(2)} GB`; }
function requestLabel() {
  if (state.media?.type === 'movie') return `${state.media.name}${state.media.year ? ` (${String(state.media.year).slice(0, 4)})` : ''}`;
  const episode = state.episode;
  return `${state.media.name} S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function cacheView(release) {
  const cached = release.providers?.torbox?.cached;
  return cached === true ? ['cached', 'TorBox cached'] : cached === false ? ['uncached', 'Not cached'] : ['unknown', 'Cache unknown'];
}

async function performSearch() {
  const query = $('#query').value.trim();
  if (query.length < 2) return;
  const sequence = ++state.searchSequence;
  state.searchController?.abort();
  state.searchController = new AbortController();
  message('Searching…');
  try {
    const { results, timings } = await api(`/api/search?q=${encodeURIComponent(query)}`, { signal: state.searchController.signal });
    if (sequence !== state.searchSequence) return;
    renderTitles(results);
    message(results.length ? `${results.length} titles · ${timings?.totalMs ?? '?'} ms` : 'No results found.');
  } catch (error) {
    if (error.name !== 'AbortError' && sequence === state.searchSequence) message(error.message, true);
  }
}

let searchTimer;
$('#query').addEventListener('input', () => {
  clearTimeout(searchTimer);
  if ($('#query').value.trim().length < 2) { closeDrilldown(); return; }
  searchTimer = setTimeout(performSearch, 325);
});
$('#search-form').addEventListener('submit', (event) => { event.preventDefault(); clearTimeout(searchTimer); performSearch(); });

function renderTitles(results) {
  const panel = $('#drilldown'); panel.replaceChildren(drillHeader('Search results', null, closeDrilldown));
  const list = element('div', 'drill-list'); panel.append(list); panel.hidden = false;
  for (const item of results) {
    const button = element('button', 'drill-row title-row');
    if (item.poster) { const image = element('img'); image.src = item.poster; image.alt = ''; button.append(image); }
    const copy = element('span');
    copy.append(element('strong', '', item.name), document.createElement('br'), element('span', 'meta', `${item.year || ''} · ${item.type === 'series' ? 'TV series' : 'Movie'}`));
    button.append(copy); button.onclick = () => item.type === 'movie' ? selectMovie(item) : selectMedia(item); list.append(button);
  }
  if (!results.length) list.append(element('p', 'empty drill-empty', 'No titles found.'));
}

function selectMovie(item) {
  state.media = item; state.season = null; state.episode = null; state.release = null;
  closeDrilldown(); $('#intent-caption').textContent = 'Requested movie'; $('#intent-label').textContent = requestLabel(); $('#change-episode').textContent = 'Change movie';
  $('#intent-bar').hidden = false; $('#new-search').hidden = false; findReleases();
}

async function selectMedia(item) {
  message('Loading episodes…');
  try {
    const result = await api(`/api/media?type=series&id=${encodeURIComponent(item.id)}`);
    state.media = result.media;
    renderSeasons(); $('#release-section').hidden = true; $('#intent-bar').hidden = true; $('#new-search').hidden = false;
    message(`Episodes loaded in ${result.timings?.totalMs ?? '?'} ms`);
  } catch (error) { message(error.message, true); }
}
function drillHeader(title, back, cancel) {
  const header = element('div', 'drill-header');
  const actions = element('div', 'drill-actions');
  if (back) { const button = element('button', 'secondary compact', 'Back'); button.onclick = back; actions.append(button); }
  const close = element('button', 'secondary compact', 'Cancel'); close.onclick = cancel; actions.append(close);
  header.append(element('strong', '', title), actions); return header;
}
function renderSeasons() {
  const panel = $('#drilldown'); panel.replaceChildren(drillHeader(state.media.name, null, closeDrilldown));
  panel.append(element('div', 'drill-context', `TV · ${state.media.year || 'Year unknown'}`));
  const list = element('div', 'drill-list season-list');
  const seasons = [...new Set(state.media.videos.map((video) => video.season))].sort((a, b) => a - b);
  for (const season of seasons) { const button = element('button', 'drill-row season-row', `Season ${season}`); button.onclick = () => { state.season = season; renderEpisodes(); }; list.append(button); }
  panel.append(list); panel.hidden = false;
}
function renderEpisodes() {
  const panel = $('#drilldown'); panel.replaceChildren(drillHeader(`${state.media.name} · Season ${state.season}`, renderSeasons, closeDrilldown));
  const list = element('div', 'drill-list episode-list');
  const episodes = state.media.videos.filter((video) => video.season === state.season).sort((a, b) => a.episode - b.episode);
  for (const episode of episodes) {
    const button = element('button', 'drill-row episode-row');
    if (episode.thumbnail) { const image = element('img'); image.src = episode.thumbnail; image.alt = ''; button.append(image); }
    const copy = element('span'); copy.append(element('strong', '', episode.title), element('span', 'meta', formatAirDate(episode.released)));
    copy.append(element('span', 'episode-code', `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`));
    button.append(copy); button.onclick = () => chooseEpisode(episode); list.append(button);
  }
  panel.append(list); panel.hidden = false;
}
function formatAirDate(value) {
  if (!value) return '';
  const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function closeDrilldown() { $('#drilldown').hidden = true; }
function chooseEpisode(episode) {
  state.episode = episode; state.season = episode.season; closeDrilldown();
  $('#intent-caption').textContent = 'Requested episode'; $('#intent-label').textContent = requestLabel(); $('#change-episode').textContent = 'Change episode';
  $('#intent-bar').hidden = false; findReleases();
}

function startNewSearch() {
  state.media = null; state.episode = null; state.release = null; state.requestId = null; state.requestEpisodeLabel = null; state.releases = [];
  $('#intent-bar').hidden = true; $('#release-section').hidden = true; $('#new-search').hidden = true; $('#new-search').disabled = false; $('#change-episode').disabled = false;
  $('#query').focus(); performSearch(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#new-search').onclick = startNewSearch;
$('#change-episode').onclick = () => { if (state.media?.type === 'movie') startNewSearch(); else if (state.media) { state.season == null ? renderSeasons() : renderEpisodes(); $('#query').focus(); } };

async function findReleases() {
  state.release = null; state.visible = 100; resetSelection();
  message('Discovering releases and checking TorBox cache…');
  $('#release-section').hidden = false; $('#release-loading').hidden = false; $('#filters').hidden = true; $('#release-workspace').hidden = true;
  $('#release-summary').replaceChildren(element('strong', '', 'Loading releases…')); $('#release-timing').textContent = ''; $('#releases').replaceChildren();
  try {
    const streamType = state.media.type;
    const mediaId = streamType === 'movie' ? state.media.id : state.episode.id;
    const data = await api(`/api/releases?type=${streamType}&mediaId=${encodeURIComponent(mediaId)}`);
    state.releases = prepareReleases(data.results);
    populateFilters(); renderReleases();
    const timing = data.timings;
    $('#release-timing').textContent = timing ? `Discovery ${timing.discoveryMs} ms · TorBox ${timing.torboxMs} ms · total ${timing.totalMs} ms` : '';
    $('#release-loading').hidden = true; $('#filters').hidden = false; $('#release-workspace').hidden = false;
    message(state.releases.length ? '' : 'No torrent releases found.');
  } catch (error) { $('#release-loading').hidden = true; message(error.message, true); }
}

function populateFilters() {
  const { resolutions, codecs, hdr } = releaseFilterOptions(state.releases);
  setSelectOptions($('#resolution-filter'), 'Any', resolutions);
  setSelectOptions($('#codec-filter'), 'Any', codecs);
  setSelectOptions($('#hdr-filter'), 'Any', hdr);
  $('#cached-filter').checked = false; $('#max-size-filter').value = '';
}
function setSelectOptions(select, allLabel, values) {
  select.replaceChildren();
  for (const [label, value] of [[allLabel, ''], ...values.map((option) => [option.label, option.value])]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
  }
}
function currentFilters() {
  const maxSize = Number.parseFloat($('#max-size-filter').value);
  return { cached: $('#cached-filter').checked, resolution: $('#resolution-filter').value, codec: $('#codec-filter').value, hdr: $('#hdr-filter').value, maxSizeGb: Number.isFinite(maxSize) && maxSize > 0 ? maxSize : null };
}
function renderReleases() {
  const filtered = filterReleases(state.releases, currentFilters());
  const summary = summarizeReleases(state.releases);
  const resolutionCounts = Object.entries(summary.resolutions).sort().map(([name, count]) => `${count} ${name}`).join(' · ');
  $('#release-summary').replaceChildren(
    element('strong', '', `${summary.total} releases`),
    element('span', 'cached-count', `${summary.cached} cached`),
    element('span', '', `${filtered.length} showing`),
    ...(resolutionCounts ? [element('span', 'resolution-counts', resolutionCounts)] : [])
  );
  $('#releases').replaceChildren();
  for (const release of filtered.slice(0, state.visible)) {
    const selected = isReleaseSelected(release, state.release);
    const row = element('div', `release${selected ? ' selected' : ''}`); row.tabIndex = 0; row.setAttribute('aria-selected', String(selected));
    const copy = element('div'); copy.append(element('div', 'release-title', release.filename || release.title));
    const badges = element('div', 'badges');
    [release.resolution, release.quality, release.codec, release.hdr, size(release.size)].filter(Boolean).forEach((value) => badges.append(element('span', 'badge', value)));
    copy.append(badges);
    const [cacheClass, cacheText] = cacheView(release);
    const stateColumn = element('div', 'release-state');
    if (selected) stateColumn.append(element('span', 'selected-label', 'Selected'));
    stateColumn.append(element('span', `cache ${cacheClass}`, cacheText));
    const utilities = releaseUtilityActions(release);
    if (utilities) stateColumn.append(releaseActionsMenu(utilities));
    row.append(copy, stateColumn);
    const choose = () => { state.release = release; renderReleases(); showSelection(release); };
    row.onclick = () => { choose(); row.blur(); }; row.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } };
    $('#releases').append(row);
  }
  $('#show-more').hidden = filtered.length <= state.visible;
}
function releaseActionsMenu(utilities) {
  const details = element('details', 'release-actions'); const summary = element('summary', '', '•••'); summary.title = 'Release utilities'; details.append(summary);
  const menu = element('div', 'release-actions-menu');
  for (const [label, value] of [['Copy magnet', utilities.magnet], ['Copy infoHash', utilities.infoHash]]) {
    const button = element('button', 'secondary', label);
    button.onclick = async (event) => { event.stopPropagation(); try { await copyText(value); message(`${label.replace('Copy ', '')} copied.`); details.open = false; } catch { message('Clipboard access failed.', true); } };
    menu.append(button);
  }
  details.append(menu); details.onclick = (event) => event.stopPropagation(); details.onkeydown = (event) => event.stopPropagation(); return details;
}
async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const field = element('textarea'); field.value = value; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select();
  const copied = document.execCommand('copy'); field.remove(); if (!copied) throw new Error('Copy failed');
}
for (const id of ['cached-filter', 'resolution-filter', 'codec-filter', 'hdr-filter']) $( `#${id}`).addEventListener('change', () => { state.visible = 100; renderReleases(); });
$('#max-size-filter').addEventListener('input', () => { state.visible = 100; renderReleases(); });
$('#clear-filters').onclick = () => { $('#cached-filter').checked = false; $('#resolution-filter').value = ''; $('#codec-filter').value = ''; $('#hdr-filter').value = ''; $('#max-size-filter').value = ''; state.visible = 100; renderReleases(); };
$('#show-more').onclick = () => { state.visible += 100; renderReleases(); };

function resetSelection() {
  $('#selection-empty').hidden = false; $('#selection-details').hidden = true; $('#status-section').hidden = true; $('#submit-request').disabled = false;
  $('#try-another').hidden = true; $('#request-another').hidden = true; $('#status-new-search').hidden = true;
}
function showSelection(release) {
  const [cacheClass, cacheText] = cacheView(release);
  $('#selection-empty').hidden = true; $('#selection-details').hidden = false;
  $('#requested').textContent = requestLabel(); $('#selected').textContent = release.filename || release.title;
  $('#selected-meta').textContent = [release.resolution, release.quality, release.codec, release.hdr, size(release.size)].filter(Boolean).join(' · ');
  $('#selected-cache').className = cacheClass; $('#selected-cache').textContent = cacheText;
  const movie = state.media.type === 'movie'; $('#import-behavior').textContent = movie ? 'Requested movie' : 'Requested episode only'; $('#submit-request').textContent = movie ? 'Request movie' : 'Request episode';
}

$('#submit-request').onclick = async () => {
  message('Submitting…'); $('#submit-request').disabled = true;
  try {
    const mediaId = state.media.type === 'movie' ? state.media.id : state.episode.id;
    const result = await api('/api/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: state.media.type, mediaId, release: state.release }) });
    state.requestId = result.requestId;
    state.requestEpisodeLabel = requestLabel();
    $('#request-another').textContent = state.media.type === 'movie' ? 'Request another movie' : 'Request another episode';
    $('#change-episode').disabled = true; $('#new-search').disabled = true;
    $('#selection-empty').hidden = true; $('#selection-details').hidden = true; $('#status-section').hidden = false;
    $('#status-requested').textContent = state.requestEpisodeLabel; $('#status-release').textContent = state.release.filename || state.release.title; $('#request-id').textContent = result.requestId;
    updateStatus(result.status); pollStatus(result.requestId); message('');
  } catch (error) { message(error.message, true); $('#submit-request').disabled = false; }
};
function updateStatus(status) {
  $('#request-status').textContent = status; $('#request-status').className = `status ${status}`;
  const view = requestPaneView(status, state.requestEpisodeLabel || requestLabel());
  $('#status-heading').textContent = view.heading; $('#status-message').textContent = view.message;
  $('#try-another').hidden = !view.failed; $('#request-another').hidden = !view.terminal; $('#status-new-search').hidden = !view.terminal;
  if (view.terminal) { $('#change-episode').disabled = false; $('#new-search').disabled = false; }
}
async function pollStatus(requestId) {
  if (requestId !== state.requestId) return;
  try {
    const result = await api(`/api/requests/${requestId}`); updateStatus(result.status);
    if (!['done', 'failed'].includes(result.status)) setTimeout(() => pollStatus(requestId), 2500);
  } catch (error) { message(`Status check failed: ${error.message}`, true); setTimeout(() => pollStatus(requestId), 5000); }
}
$('#request-another').onclick = () => {
  const movie = state.media?.type === 'movie'; state.requestId = null; state.requestEpisodeLabel = null; state.release = null; resetSelection(); $('#release-section').hidden = true; $('#intent-bar').hidden = true;
  if (movie) startNewSearch(); else { renderEpisodes(); $('#query').focus(); }
};
$('#try-another').onclick = () => { state.requestId = null; state.requestEpisodeLabel = null; state.release = null; renderReleases(); resetSelection(); };
$('#status-new-search').onclick = startNewSearch;
