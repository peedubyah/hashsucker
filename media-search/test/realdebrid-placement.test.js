import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRealDebridPlacementAdapter,
  REALDEBRID_PROVIDER_ID,
} from '../src/lib/providers/realdebrid/placement.js';
import {
  EXECUTION_STATUSES,
  EXECUTION_ACTIONS,
} from '../src/lib/acquisition/execution.js';
import {
  PLACEMENT_RESOURCE_STATUSES,
} from '../src/lib/acquisition/placement-resource.js';
import {
  PLACEMENT_OBSERVATION_STATUSES,
} from '../src/lib/acquisition/placement-observation.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';
import { ProviderOperationError } from '../src/lib/providers/errors.js';
import {
  RD_HASH,
  RD_MAGNET,
  RD_TORRENT_ID,
  rdAddMagnetSuccess,
  rdAddMagnetMalformed,
  rdTorrentInfoDownloaded,
  rdTorrentInfoDownloading,
  rdTorrentInfoWaitingFilesSelection,
  rdTorrentInfoMagnetConversion,
  rdTorrentInfoQueued,
  rdTorrentInfoCompressing,
  rdTorrentInfoUploading,
  rdTorrentInfoError,
  rdTorrentInfoDead,
  rdTorrentInfoVirus,
  rdTorrentInfoUnknownStatus,
  rdTorrentInfoMalformed,
  rdAuthError,
  rdInvalidRequestError,
  rdRateLimitError,
  rdServerError,
} from './fixtures/realdebrid-response-fixtures.js';

const NOW = 20_000;

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function errorResponse(error) {
  return {
    ok: false,
    status: error.status,
    json: async () => ({ error: error.message }),
  };
}

function readyExecutionRequest() {
  const identity = createReleaseIdentity(RD_HASH, 0);
  return Object.freeze({
    executionStatus: EXECUTION_STATUSES.READY,
    action: EXECUTION_ACTIONS.PLACE,
    candidateIdentity: Object.freeze({
      infoHash: identity.infoHash,
      fileIndex: identity.fileIndex,
      releaseKey: identity.releaseKey,
    }),
    provider: REALDEBRID_PROVIDER_ID,
    accountScope: 'primary',
    reasonCodes: [],
    evidence: {},
    createdAt: NOW,
    locator: Object.freeze({
      locatorType: 'magnet',
      locatorValue: RD_MAGNET,
      source: 'candidate',
    }),
  });
}

function submittedPlacementResource() {
  return Object.freeze({
    provider: REALDEBRID_PROVIDER_ID,
    accountScope: 'primary',
    providerResourceId: RD_TORRENT_ID,
    candidateIdentity: Object.freeze({
      infoHash: RD_HASH,
      fileIndex: 0,
      releaseKey: `${RD_HASH}:0`,
    }),
    placementStatus: PLACEMENT_RESOURCE_STATUSES.SUBMITTED,
    createdAt: NOW,
  });
}

// ---------------------------------------------------------------------------
// Adapter construction
// ---------------------------------------------------------------------------

test('adapter requires apiKey', () => {
  assert.throws(
    () => createRealDebridPlacementAdapter({}),
    (err) => err instanceof TypeError && /apiKey is required/.test(err.message)
  );
});

test('adapter requires non-empty apiKey', () => {
  assert.throws(
    () => createRealDebridPlacementAdapter({ apiKey: '   ' }),
    (err) => err instanceof TypeError && /apiKey is required/.test(err.message)
  );
});

test('adapter exposes provider identifier', () => {
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  assert.equal(adapter.provider, REALDEBRID_PROVIDER_ID);
});

// ---------------------------------------------------------------------------
// Submission — valid magnet
// ---------------------------------------------------------------------------

test('valid magnet submits successfully', async () => {
  const fetchFn = async (url, init) => {
    assert.ok(url.includes('/torrents/addMagnet'));
    assert.equal(init.method, 'POST');
    assert.ok(init.body.includes('magnet='));
    return response(rdAddMagnetSuccess());
  };

  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.submit({ executionRequest: readyExecutionRequest() });

  assert.equal(result.placementStatus, PLACEMENT_RESOURCE_STATUSES.SUBMITTED);
  assert.equal(result.provider, REALDEBRID_PROVIDER_ID);
  assert.equal(result.providerResourceId, RD_TORRENT_ID);
  assert.equal(result.accountScope, 'primary');
  assert.equal(result.candidateIdentity.infoHash, RD_HASH);
  assert.equal(result.candidateIdentity.fileIndex, 0);
  assert.equal(result.candidateIdentity.releaseKey, `${RD_HASH}:0`);
});

test('RD request uses form encoding', async () => {
  const fetchFn = async (url, init) => {
    assert.ok(init.headers['Content-Type'].includes('application/x-www-form-urlencoded'));
    assert.ok(init.body.includes('magnet='));
    return response(rdAddMagnetSuccess());
  };

  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await adapter.submit({ executionRequest: readyExecutionRequest() });
});

test('authorization header applied', async () => {
  const fetchFn = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer token');
    return response(rdAddMagnetSuccess());
  };

  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await adapter.submit({ executionRequest: readyExecutionRequest() });
});

test('returned ID becomes providerResourceId', async () => {
  const fetchFn = async () => response(rdAddMagnetSuccess('CUSTOM_ID_789'));
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.submit({ executionRequest: readyExecutionRequest() });
  assert.equal(result.providerResourceId, 'CUSTOM_ID_789');
});

test('account scope preserved', async () => {
  const request = Object.freeze({
    ...readyExecutionRequest(),
    accountScope: 'secondary',
  });
  const fetchFn = async () => response(rdAddMagnetSuccess());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.submit({ executionRequest: request });
  assert.equal(result.accountScope, 'secondary');
});

test('candidate identity preserved', async () => {
  const identity = createReleaseIdentity(RD_HASH, null);
  const request = Object.freeze({
    ...readyExecutionRequest(),
    candidateIdentity: Object.freeze({
      infoHash: identity.infoHash,
      fileIndex: identity.fileIndex,
      releaseKey: identity.releaseKey,
    }),
  });
  const fetchFn = async () => response(rdAddMagnetSuccess());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.submit({ executionRequest: request });
  assert.equal(result.candidateIdentity.infoHash, RD_HASH);
  assert.equal(result.candidateIdentity.fileIndex, null);
  assert.equal(result.candidateIdentity.releaseKey, `${RD_HASH}:torrent`);
});

// ---------------------------------------------------------------------------
// Submission — error handling
// ---------------------------------------------------------------------------

test('malformed RD response rejected', async () => {
  const fetchFn = async () => response(rdAddMagnetMalformed());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await assert.rejects(
    () => adapter.submit({ executionRequest: readyExecutionRequest() }),
    (err) => err instanceof ProviderOperationError && err.category === 'invalid-response'
  );
});

test('missing resource ID rejected', async () => {
  const fetchFn = async () => response({ uri: 'https://real-debrid.com/torrents/' });
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await assert.rejects(
    () => adapter.submit({ executionRequest: readyExecutionRequest() }),
    (err) => err instanceof ProviderOperationError && /missing id/.test(err.message)
  );
});

test('authentication failure preserved as ProviderOperationError', async () => {
  const fetchFn = async () => errorResponse(rdAuthError());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await assert.rejects(
    () => adapter.submit({ executionRequest: readyExecutionRequest() }),
    (err) => err instanceof ProviderOperationError && err.category === 'authentication'
  );
});

test('invalid request preserved as ProviderOperationError', async () => {
  const fetchFn = async () => errorResponse(rdInvalidRequestError());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await assert.rejects(
    () => adapter.submit({ executionRequest: readyExecutionRequest() }),
    (err) => err instanceof ProviderOperationError && err.category === 'invalid-request'
  );
});

test('rate limiting preserved as ProviderOperationError', async () => {
  const fetchFn = async () => errorResponse(rdRateLimitError());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await assert.rejects(
    () => adapter.submit({ executionRequest: readyExecutionRequest() }),
    (err) => err instanceof ProviderOperationError && err.category === 'rate-limit'
  );
});

test('server error preserved as ProviderOperationError', async () => {
  const fetchFn = async () => errorResponse(rdServerError());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await assert.rejects(
    () => adapter.submit({ executionRequest: readyExecutionRequest() }),
    (err) => err instanceof ProviderOperationError && err.category === 'temporarily-unavailable'
  );
});

// ---------------------------------------------------------------------------
// Submission — rejection of non-ready requests
// ---------------------------------------------------------------------------

test('deferred execution request rejected', async () => {
  const deferredRequest = Object.freeze({
    executionStatus: EXECUTION_STATUSES.DEFERRED,
    action: null,
    candidateIdentity: null,
    provider: REALDEBRID_PROVIDER_ID,
    accountScope: 'primary',
    reasonCodes: [],
    evidence: null,
    createdAt: NOW,
  });
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  await assert.rejects(
    () => adapter.submit({ executionRequest: deferredRequest }),
    (err) => err instanceof TypeError && /deferred/.test(err.message)
  );
});

test('unavailable execution request rejected', async () => {
  const unavailableRequest = Object.freeze({
    executionStatus: EXECUTION_STATUSES.UNAVAILABLE,
    action: null,
    candidateIdentity: null,
    provider: REALDEBRID_PROVIDER_ID,
    accountScope: 'primary',
    reasonCodes: [],
    evidence: null,
    createdAt: NOW,
  });
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  await assert.rejects(
    () => adapter.submit({ executionRequest: unavailableRequest }),
    (err) => err instanceof TypeError && /unavailable/.test(err.message)
  );
});

test('wrong provider rejected', async () => {
  const wrongProviderRequest = Object.freeze({
    ...readyExecutionRequest(),
    provider: 'torbox',
  });
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  await assert.rejects(
    () => adapter.submit({ executionRequest: wrongProviderRequest }),
    (err) => err instanceof TypeError && /Provider mismatch/.test(err.message)
  );
});

test('missing candidate identity rejected', async () => {
  const missingIdentityRequest = Object.freeze({
    ...readyExecutionRequest(),
    candidateIdentity: null,
  });
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  await assert.rejects(
    () => adapter.submit({ executionRequest: missingIdentityRequest }),
    (err) => err instanceof TypeError && /candidateIdentity/.test(err.message)
  );
});

test('missing account scope rejected', async () => {
  const missingScopeRequest = Object.freeze({
    ...readyExecutionRequest(),
    accountScope: null,
  });
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  await assert.rejects(
    () => adapter.submit({ executionRequest: missingScopeRequest }),
    (err) => err instanceof TypeError && /accountScope/.test(err.message)
  );
});

test('missing locator rejected', async () => {
  const request = readyExecutionRequest();
  const { locator, ...rest } = request;
  const noLocatorRequest = Object.freeze(rest);
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  await assert.rejects(
    () => adapter.submit({ executionRequest: noLocatorRequest }),
    (err) => err instanceof TypeError && /locator/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// Observation — status mapping
// ---------------------------------------------------------------------------

test('downloaded maps to ready', async () => {
  const fetchFn = async (url) => {
    assert.ok(url.includes(`/torrents/info/${RD_TORRENT_ID}`));
    return response(rdTorrentInfoDownloaded());
  };
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.READY);
  assert.equal(result.providerStatus, 'downloaded');
});

test('downloading maps to processing', async () => {
  const fetchFn = async () => response(rdTorrentInfoDownloading());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.PROCESSING);
  assert.equal(result.providerStatus, 'downloading');
});

test('waiting_files_selection maps to processing', async () => {
  const fetchFn = async () => response(rdTorrentInfoWaitingFilesSelection());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.PROCESSING);
  assert.equal(result.providerStatus, 'waiting_files_selection');
});

test('magnet_conversion maps to processing', async () => {
  const fetchFn = async () => response(rdTorrentInfoMagnetConversion());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.PROCESSING);
  assert.equal(result.providerStatus, 'magnet_conversion');
});

test('queued maps to processing', async () => {
  const fetchFn = async () => response(rdTorrentInfoQueued());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.PROCESSING);
  assert.equal(result.providerStatus, 'queued');
});

test('compressing maps to processing', async () => {
  const fetchFn = async () => response(rdTorrentInfoCompressing());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.PROCESSING);
  assert.equal(result.providerStatus, 'compressing');
});

test('uploading maps to processing', async () => {
  const fetchFn = async () => response(rdTorrentInfoUploading());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.PROCESSING);
  assert.equal(result.providerStatus, 'uploading');
});

test('error maps to failed', async () => {
  const fetchFn = async () => response(rdTorrentInfoError());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.FAILED);
  assert.equal(result.providerStatus, 'error');
  assert.ok(result.error);
  assert.equal(result.error.category, 'provider-failed');
});

test('dead maps to failed', async () => {
  const fetchFn = async () => response(rdTorrentInfoDead());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.FAILED);
  assert.equal(result.providerStatus, 'dead');
});

test('virus maps to failed', async () => {
  const fetchFn = async () => response(rdTorrentInfoVirus());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.FAILED);
  assert.equal(result.providerStatus, 'virus');
});

test('unknown RD status maps to unknown', async () => {
  const fetchFn = async () => response(rdTorrentInfoUnknownStatus());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.status, PLACEMENT_OBSERVATION_STATUSES.UNKNOWN);
  assert.equal(result.providerStatus, 'some_new_status');
});

// ---------------------------------------------------------------------------
// Observation — field preservation
// ---------------------------------------------------------------------------

test('providerStatus preserved', async () => {
  const fetchFn = async () => response(rdTorrentInfoDownloading());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.providerStatus, 'downloading');
});

test('progress preserved', async () => {
  const fetchFn = async () => response(rdTorrentInfoDownloading(45));
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.progress, 45);
});

test('progress null when not present', async () => {
  const info = rdTorrentInfoDownloaded();
  delete info.progress;
  const fetchFn = async () => response(info);
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.equal(result.progress, null);
});

test('timestamp supplied explicitly', async () => {
  const fetchFn = async () => response(rdTorrentInfoDownloaded());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: 1234567890,
  });
  assert.equal(result.observedAt, 1234567890);
});

// ---------------------------------------------------------------------------
// Observation — error handling
// ---------------------------------------------------------------------------

test('malformed responses rejected', async () => {
  const fetchFn = async () => response(rdTorrentInfoMalformed());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await assert.rejects(
    () => adapter.observe({
      placementResource: submittedPlacementResource(),
      observedAt: NOW,
    }),
    (err) => err instanceof ProviderOperationError && err.category === 'invalid-response'
  );
});

test('authentication failure during observation preserved', async () => {
  const fetchFn = async () => errorResponse(rdAuthError());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await assert.rejects(
    () => adapter.observe({
      placementResource: submittedPlacementResource(),
      observedAt: NOW,
    }),
    (err) => err instanceof ProviderOperationError && err.category === 'authentication'
  );
});

test('server error during observation preserved', async () => {
  const fetchFn = async () => errorResponse(rdServerError());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await assert.rejects(
    () => adapter.observe({
      placementResource: submittedPlacementResource(),
      observedAt: NOW,
    }),
    (err) => err instanceof ProviderOperationError && err.category === 'temporarily-unavailable'
  );
});

// ---------------------------------------------------------------------------
// Observation — validation
// ---------------------------------------------------------------------------

test('wrong provider in placement resource rejected', async () => {
  const wrongResource = Object.freeze({
    ...submittedPlacementResource(),
    provider: 'torbox',
  });
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  await assert.rejects(
    () => adapter.observe({ placementResource: wrongResource, observedAt: NOW }),
    (err) => err instanceof TypeError && /Provider mismatch/.test(err.message)
  );
});

test('missing providerResourceId rejected', async () => {
  const { providerResourceId, ...rest } = submittedPlacementResource();
  const badResource = Object.freeze(rest);
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  await assert.rejects(
    () => adapter.observe({ placementResource: badResource, observedAt: NOW }),
    (err) => err instanceof TypeError && /providerResourceId/.test(err.message)
  );
});

test('missing accountScope rejected', async () => {
  const { accountScope, ...rest } = submittedPlacementResource();
  const badResource = Object.freeze(rest);
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  await assert.rejects(
    () => adapter.observe({ placementResource: badResource, observedAt: NOW }),
    (err) => err instanceof TypeError && /accountScope/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

test('no generic contract mutation — placement resource is frozen', async () => {
  const fetchFn = async () => response(rdAddMagnetSuccess());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.submit({ executionRequest: readyExecutionRequest() });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.candidateIdentity));
});

test('no generic contract mutation — placement observation is frozen', async () => {
  const fetchFn = async () => response(rdTorrentInfoDownloaded());
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  const result = await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });
  assert.ok(Object.isFrozen(result));
});

test('no file selection — adapter has no selectFiles method', () => {
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  assert.equal(adapter.selectFiles, undefined);
});

test('no link retrieval — adapter has no getLinks method', () => {
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  assert.equal(adapter.getLinks, undefined);
});

test('no scheduling — adapter has no schedule method', () => {
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  assert.equal(adapter.schedule, undefined);
});

test('no polling loop — adapter has no poll method', () => {
  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token' });
  assert.equal(adapter.poll, undefined);
});

test('no provider calls outside adapter — only addMagnet and torrents/info endpoints used', async () => {
  const calledUrls = [];
  const fetchFn = async (url, init) => {
    calledUrls.push(url);
    if (url.includes('/torrents/addMagnet')) {
      return response(rdAddMagnetSuccess());
    }
    if (url.includes(`/torrents/info/${RD_TORRENT_ID}`)) {
      return response(rdTorrentInfoDownloaded());
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const adapter = createRealDebridPlacementAdapter({ apiKey: 'token', fetchFn });
  await adapter.submit({ executionRequest: readyExecutionRequest() });
  await adapter.observe({
    placementResource: submittedPlacementResource(),
    observedAt: NOW,
  });

  assert.equal(calledUrls.length, 2);
  assert.ok(calledUrls[0].includes('/torrents/addMagnet'));
  assert.ok(calledUrls[1].includes(`/torrents/info/${RD_TORRENT_ID}`));
});
