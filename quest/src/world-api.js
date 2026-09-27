// HTTP companions to the live WORLD socket. Calls only happen explicitly; in
// particular, mutations are never retried because they can launch real work.
export class WorldApiError extends Error {
  constructor(message, { status = 0, detail = null, path, code } = {}) {
    super(message);
    this.name = 'WorldApiError';
    this.status = status;
    this.detail = detail;
    this.path = path;
    this.code = code;
  }
}

function errorDetail(detail) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => {
      if (typeof item === 'string') return item;
      const location = item?.loc?.join('.');
      return [location, item?.msg || 'invalid value'].filter(Boolean).join(': ');
    }).join('; ');
  }
  return null;
}

export function createWorldApi({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('WORLD API requires fetch');

  async function request(path, method, body, options = {}) {
    const controller = new AbortController();
    const signal = options.signal;
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const duration = options.timeoutMs ?? timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, duration);
    try {
      const response = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined ? { Accept: 'application/json' } : {
          Accept: 'application/json', 'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : null; }
      catch {
        throw new WorldApiError(
          response.ok ? 'WORLD returned an invalid JSON response' : `WORLD request failed (${response.status})`,
          { path, status: response.status, code: 'INVALID_RESPONSE' },
        );
      }
      if (!response.ok) {
        throw new WorldApiError(errorDetail(data?.detail) || `WORLD request failed (${response.status})`, {
          path, status: response.status, detail: data?.detail ?? data, code: 'HTTP_ERROR',
        });
      }
      return data;
    } catch (error) {
      if (timedOut) throw new WorldApiError('WORLD request timed out', { path, code: 'TIMEOUT' });
      if (controller.signal.aborted) throw error;
      if (error instanceof WorldApiError) throw error;
      throw new WorldApiError('could not reach WORLD backend', { path, code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  const get = (path, options) => request(path, 'GET', undefined, options);
  const post = (path, body, options) => request(path, 'POST', body, options);
  return {
    qmRuns: options => get('/qm/runs', options),
    qmWatches: options => get('/qm/watches', options),
    qmEntities: options => get('/qm/entities', options),
    qmWatch: (body, options) => post('/qm/watches', body, options),
    qmAdopt: (body, options) => post('/qm/entities/adopt', body, options),
    qmDeleteWatch: (id, options) => request(`/qm/watches/${encodeURIComponent(id)}`, 'DELETE', undefined, options),
    health: (options) => get('/health', options),
    people: (options) => get('/people', options),
    jobs: (options) => get('/builder/jobs', options),
    job: (id, options) => get(`/builder/jobs/${encodeURIComponent(id)}`, options),
    tools: (options) => get('/tools', options),
    panels: (options) => get('/panels', options),
    panelActions: (after = 0, options) => get(`/panel-actions?after=${encodeURIComponent(after)}`, options),
    panel: (command, options) => post('/tools/world-panel', command, options),
    dispatch: (body, options) => post('/builder/dispatch', body, options),
    event: (body, options) => post('/events', body, options),
    hud: (body, options) => post('/hud', body, options),
    procedure: (body, options) => post('/procedures', body, options),
    utterance: (body, options) => post('/debug/utterance', body, options),
    endConversation: (options) => post('/debug/end-conversation', undefined, options),
  };
}
