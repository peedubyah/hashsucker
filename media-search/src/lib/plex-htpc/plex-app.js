/**
 * Minimal Plex HTPC application bridge — the only browser automation the canary
 * still needs.
 *
 * Plex HTPC's UI is a webpack application running in QtWebEngine. Its playback
 * application layer is reachable through the client's own dependency-injection
 * container, and the client exposes a QtWebEngine remote-debugging port
 * (`QTWEBENGINE_REMOTE_DEBUGGING=9222`, enabled by the canary launcher) that
 * accepts `Runtime.evaluate`.
 *
 * Only two application-level operations are driven from here, because only they
 * configure real Plex playback state:
 *
 *   startPlayback()  the internal Plex start path. Plex's own Companion
 *                    `playMedia` handler closes transient UI state first and
 *                    then navigates; this mirrors that ordering so the canary
 *                    start cannot inherit a stale modal.
 *   stopPlayback()   the internal Plex stop path used by Companion's
 *                    `/player/playback/stop`: stop the live playback session
 *                    controller. Raw mpv `stop` does not notify the application
 *                    layer and leaves the PMS session alive.
 *
 * Everything else the canary observes or controls (position, duration, pause
 * state, seeks) comes from the native libmpv IPC socket instead.
 * See `./mpv-ipc.js`.
 */
export const APP_ERRORS = {
  /** Transport-level: the client's debugging endpoint is not answering. */
  CDP_UNAVAILABLE: 'APP_CDP_UNAVAILABLE',
  /** The page's DI container could not be located. */
  REGISTRY_UNAVAILABLE: 'APP_REGISTRY_UNAVAILABLE',
  /** The page itself raised while running a bridge expression. */
  PAGE_EXCEPTION: 'APP_PAGE_EXCEPTION',
  START_FAILED: 'APP_START_FAILED',
  STOP_FAILED: 'APP_STOP_FAILED',
};

const DEFAULT_CDP = 'http://127.0.0.1:9222';
/** Webpack module id of the client's DI container. Verified at bridge startup. */
const DEFAULT_CONTAINER_MODULE_ID = 72861;
const MAX_EVALUATE_MS = 20000;

export function appError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

/** Bootstrap the webpack require function exactly once per page lifetime. */
const BOOTSTRAP_EXPR = `(()=>{if(!window.__hsr&&window.webpackChunk_plex_client_qt){let r;
window.webpackChunk_plex_client_qt.push([[Date.now()],{},x=>r=x]);window.__hsr=r}
return typeof window.__hsr})()`;

/**
 * Verify the DI container is reachable at `fastId`. The module id is the one
 * remaining hard coupling to the client build; it is verified rather than
 * guessed, so a rebuild that renumbers modules fails with a precise diagnostic
 * instead of silently doing nothing.
 */
function verifyContainerExpr(fastId) {
  return `(()=>{const R=window.__hsr;if(!R)return null;
  try{const m=R(${fastId});if(!m||typeof m!=="object")return null;
    const k=Object.keys(m);if(k.length!==1)return null;const z=m[k[0]];
    if(!z||typeof z!=="object"||!z._registry)return null;
    const wanted=["navigation","modal","playbackSessionManager"];
    for(const w of wanted){if(!z.resolve(w))return null}
    return {id:${fastId},prop:k[0]};
  }catch(e){return null}})()`;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return (await (await fetch(url, { signal: controller.signal })).json());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Connect to the client's remote-debugging page and resolve its DI container.
 * One WebSocket per process; re-attaches automatically if the client restarts.
 */
export async function connectPlexApp({ cdpUrl = process.env.HS_PLEX_CDP_URL || 'http://127.0.0.1:9222', containerModuleId = DEFAULT_CONTAINER_MODULE_ID } = {}) {
  const state = {
    ws: null,
    containerId: null,
    nextId: 0,
    pending: new Map(),
    booted: false,
    evaluations: 0,
  };

  const evaluate = (expression, { timeoutMs = MAX_EVALUATE_MS } = {}) =>
    new Promise((resolve, reject) => {
      if (state.ws?.readyState !== 1) {
        reject(appError(APP_ERRORS.CDP_UNAVAILABLE, 'CDP websocket is not open'));
        return;
      }
      state.evaluations += 1;
      const reqId = ++state.nextId;
      const timer = setTimeout(() => {
        state.pending.delete(reqId);
        reject(appError(APP_ERRORS.CDP_UNAVAILABLE, `CDP evaluate timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      state.pending.set(reqId, (msg) => {
        clearTimeout(timer);
        if (msg.result?.exceptionDetails) {
          reject(appError(
            APP_ERRORS.PAGE_EXCEPTION,
            `page exception: ${String(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text).slice(0, 300)}`,
          ));
          return;
        }
        resolve(msg.result?.result?.value);
      });
      state.ws.send(JSON.stringify({
        id: reqId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
      }));
    });

  const attach = async () => {
    let targets;
    try {
      targets = await fetchJson(`${cdpUrl}/json/list`, 5000);
    } catch (err) {
      throw appError(APP_ERRORS.CDP_UNAVAILABLE, `cannot read ${cdpUrl}/json/list`, err);
    }
    const page = Array.isArray(targets)
      && (targets.find((t) => t.type === 'page' && /web-client|index\.html/.test(t.url || '')) || targets.find((t) => t.type === 'page'));
    if (!page) throw appError(APP_ERRORS.CDP_UNAVAILABLE, 'no debuggable page target in the client');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(appError(APP_ERRORS.CDP_UNAVAILABLE, 'cannot open the CDP websocket'));
    });
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const waiter = state.pending.get(msg.id);
      if (waiter) {
        state.pending.delete(msg.id);
        waiter(msg);
      }
    };
    ws.onclose = () => { state.ws = null; state.booted = false; };
    state.ws = ws;
    state.booted = false;
  };

  const evaluateWithRetry = async (expression) => {
    try {
      return await evaluate(expression);
    } catch (err) {
      if (err.code !== APP_ERRORS.CDP_UNAVAILABLE) throw err;
      // Only worth one re-attach: a restarted client keeps the same endpoint.
      if (state.ws) state.ws.close();
      await attach();
      return evaluate(expression);
    }
  };

  /**
   * Establish the page registry and DI container. A client that has just been
   * restarted reloads the page, so "registry absent" is a retryable state, not a
   * failure; give the page a bounded window to finish loading.
   */
  const ensureReady = async ({ deadlineMs = 120000 } = {}) => {
    const until = Date.now() + deadlineMs;
    let lastErr = null;
    while (Date.now() < until) {
      try {
        if (state.ws?.readyState !== 1) await attach();
        if (!state.booted) {
          if ((await evaluate(BOOTSTRAP_EXPR)) !== 'function') {
            throw appError(APP_ERRORS.REGISTRY_UNAVAILABLE, 'the client page is still loading (no webpack registry yet)');
          }
          state.booted = true;
        }
        if (state.containerId == null) {
          const found = await evaluate(verifyContainerExpr(containerModuleId));
          if (!found) {
            throw appError(APP_ERRORS.REGISTRY_UNAVAILABLE,
              `the Plex client DI container at webpack module ${containerModuleId} does not expose navigation/modal/playbackSessionManager — the client build likely changed`);
          }
          state.containerId = found.id;
        }
        return;
      } catch (err) {
        if (err.code !== APP_ERRORS.CDP_UNAVAILABLE && err.code !== APP_ERRORS.REGISTRY_UNAVAILABLE) throw err;
        lastErr = err;
        state.booted = false;
        state.containerId = null;
        if (state.ws) {
          try {
            state.ws.close();
          } catch {
            /* already closing */
          }
          state.ws = null;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw lastErr || appError(APP_ERRORS.CDP_UNAVAILABLE, 'cannot reach the Plex HTPC debugging endpoint');
  };

  /** Wrap an in-page expression, mapping page-side bridge errors to typed errors. */
  const inPage = async (code, expression) => {
    await ensureReady();
    const result = await evaluateWithRetry(expression);
    if (result && typeof result === 'object' && result.__bridgeError) {
      throw appError(code, result.__bridgeError);
    }
    return result;
  };

  await ensureReady();

  return {
    get containerModuleId() { return state.containerId; },
    get connected() { return state.ws?.readyState === 1; },
    get evaluations() { return state.evaluations; },
    evaluate: evaluateWithRetry,
    ensureReady,

    /** Internal Plex start path: close transient UI state, then navigate to the playback screen. */
    async startPlayback({ metadataSourceUri, itemKey, grandparentKey, parentKey }) {
      const params = JSON.stringify({
        metadataSourceUri, itemKey, type: 'episode', subtype: 'episode',
        grandparentKey, parentKey, fromPlayButton: true, startPaused: false,
      });
      const result = await inPage(APP_ERRORS.START_FAILED, `(()=>{try{
        const Z=window.__hsr(${state.containerId}).Z;
        const modal=Z.resolve("modal"), nav=Z.resolve("navigation");
        try{modal.closeAll()}catch(e){}
        return new Promise((resolve)=>{
          window.setTimeout(()=>{
            nav.navigate("VisualMediaPlaybackScreen",${params})
              .then(()=>resolve({name:nav.currentName}))
              .catch((e)=>resolve({__bridgeError:String(e&&e.message||e)}));
          },0);
        });
      }catch(e){return {__bridgeError:String(e&&e.message||e)}}})()`);
      if (result?.name !== 'VisualMediaPlaybackScreen') {
        throw appError(APP_ERRORS.START_FAILED, `navigation did not reach the playback screen: ${JSON.stringify(result)}`);
      }
      return result;
    },

    /** Internal Plex stop path: stop the live playback session controller. */
    async stopPlayback() {
      const result = await inPage(APP_ERRORS.STOP_FAILED, `(()=>{try{
        const Z=window.__hsr(${state.containerId}).Z;
        const sessions=Z.resolve("playbackSessionManager");
        const stopped=[];
        for(const kind of ["video","audio","photo","theme"]){
          const controller=sessions&&sessions[kind];
          if(controller&&typeof controller.stop==="function"){controller.stop();stopped.push(kind);}
        }
        if(stopped.length)return {stopped:true,source:"playbackSessionManager."+stopped.join("+")};
        const nav=Z.resolve("navigation");
        const controller=nav&&nav.current&&nav.current._playbackController;
        if(controller&&typeof controller.stop==="function"){
          controller.stop();return {stopped:true,source:"navigation.current._playbackController"};
        }
        return {stopped:false};
      }catch(e){return {__bridgeError:String(e&&e.message||e)}}})()`);
      if (result?.stopped !== true) {
        throw appError(APP_ERRORS.STOP_FAILED, 'no live playback controller available to stop');
      }
      return result;
    },

        async diagnose() {
      try {
        const res = await inPage(APP_ERRORS.PAGE_EXCEPTION, `(()=>{
          const Z=window.__hsr(${state.containerId}).Z;
          const nav=Z.resolve("navigation");
          const c=nav&&nav.current&&nav.current._playbackController;
          return {screen:nav&&nav.currentName,state:c&&c.state,loaded:c&&c.hasPlayerLoaded,
                  position:c&&c.position,duration:c&&c.duration,error:c&&c.playbackError};
        })()`);
        return res;
      } catch {
        return null;
      }
    },

    close() {
      try {
        state.ws?.close();
      } catch {
        /* the client may already be gone */
      }
      state.ws = null;
      state.booted = false;
    },
  };
}

