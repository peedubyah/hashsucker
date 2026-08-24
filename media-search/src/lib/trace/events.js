/**
 * Structured Event Stream — unified pipeline observability.
 *
 * Every major boundary emits a JSON line. No print statements.
 *
 * Usage:
 *   import { emit, EVENTS } from '../../lib/trace/events.js';
 *   emit(EVENTS.DISCOVERY_SEARCH, { query, mediaId, results: 42 });
 *
 * Subscribers:
 *   import { onEvent, onAllEvents } from '../../lib/trace/events.js';
 *   onEvent(EVENTS.DISCOVERY_SEARCH, (e) => metrics.increment('search'));
 *   onAllEvents((e) => logger.info(e));
 */

import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const EVENTS = Object.freeze({
  // Request lifecycle
  REQUEST_RECEIVED: 'request.received',
  REQUEST_VALIDATED: 'request.validated',
  REQUEST_INVALID: 'request.invalid',
  REQUEST_HANDOFF: 'request.handoff',
  REQUEST_QUEUED: 'request.queued',

  // Discovery
  DISCOVERY_SEARCH: 'discovery.search',
  DISCOVERY_RESULT: 'discovery.result',
  DISCOVERY_CANDIDATE: 'discovery.candidate',
  DISCOVERY_LIVE: 'discovery.live',
  DISCOVERY_LOCAL: 'discovery.local',
  DISCOVERY_ERROR: 'discovery.error',

  // Handoff
  HANDOFF_CREATED: 'handoff.created',
  HANDOFF_VALIDATED: 'handoff.validated',

  // Queue
  QUEUE_WRITE: 'queue.write',
  QUEUE_CLAIM: 'queue.claim',
  QUEUE_ERROR: 'queue.error',

  // TorBox
  TORBOX_CACHE_CHECK: 'torbox.cache.check',
  TORBOX_CACHE_HIT: 'torbox.cache.hit',
  TORBOX_CACHE_MISS: 'torbox.cache.miss',
  TORBOX_TORRENT_CREATE: 'torbox.torrent.create',
  TORBOX_FILE_RESOLVE: 'torbox.file.resolve',
  TORBOX_ERROR: 'torbox.error',

  // Stream
  STREAM_URL_BUILD: 'stream.url.build',

  // Materialization
  MATERIALIZE_STRM: 'materialize.strm',
  MATERIALIZE_ERROR: 'materialize.error',

  // Metadata
  METADATA_RESOLVE: 'metadata.resolve',
  METADATA_UNRESOLVED: 'metadata.unresolved',
  METADATA_ERROR: 'metadata.error',

  // Importer
  IMPORTER_CLAIM: 'importer.claim',
  IMPORTER_PROCESS: 'importer.process',
  IMPORTER_COMPLETE: 'importer.complete',
  IMPORTER_ERROR: 'importer.error',

  // Lifecycle
  LIFECYCLE_STATE: 'lifecycle.state',
});

/**
 * Emit a structured pipeline event.
 */
export function emit(eventType, data = {}) {
  const event = {
    timestamp: new Date().toISOString(),
    event: eventType,
    ...data,
  };

  emitter.emit(eventType, event);
  emitter.emit('*', event);
  console.log(JSON.stringify(event));

  return event;
}

/**
 * Subscribe to a specific event type.
 * @returns {Function} unsubscribe
 */
export function onEvent(eventType, handler) {
  emitter.on(eventType, handler);
  return () => emitter.off(eventType, handler);
}

/**
 * Subscribe to all events.
 * @returns {Function} unsubscribe
 */
export function onAllEvents(handler) {
  emitter.on('*', handler);
  return () => emitter.off('*', handler);
}

/**
 * Get the underlying EventEmitter for advanced use.
 */
export function getEmitter() {
  return emitter;
}

/**
 * Create a child emitter scoped to a specific request.
 * Events emitted through the child include requestId automatically.
 */
export function createRequestContext(requestId) {
  return {
    emit: (eventType, data = {}) => emit(eventType, { requestId, ...data }),
  };
}
