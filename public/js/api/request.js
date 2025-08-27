// Simple deduped fetch with TTL + small concurrency gate.
const _cache = new Map(); // key -> {ts, ttl, promise, value}
const _queue = [];
let _inFlight = 0;
const MAX_CONCURRENT = 6;

function _key(method, url, body) {
  return `${method} ${url} ${body ? JSON.stringify(body) : ''}`;
}
function _now(){ return Date.now(); }

async function _runQueued() {
  if (_inFlight >= MAX_CONCURRENT || _queue.length === 0) return;
  _inFlight++;
  const job = _queue.shift();
  try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
  finally { _inFlight--; _runQueued(); }
}

function _enqueue(fn){
  return new Promise((resolve, reject)=>{
    _queue.push({fn, resolve, reject});
    _runQueued();
  });
}

/**
 * Deduped JSON fetch.
 * @param {string} url
 * @param {object} opts { method, headers, body, ttlMs, force }
 */
export async function fetchJSON(url, opts={}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body   = opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
  const ttlMs  = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 60_000; // default 60s
  const force  = !!opts.force;
  const key    = _key(method, url, body);

  const hit = _cache.get(key);
  if (!force && hit && (hit.value || hit.promise)) {
    const fresh = hit.ts && (_now() - hit.ts) < hit.ttl;
    if (fresh && hit.value) return hit.value;
    if (hit.promise) return hit.promise;
  }

  const doFetch = async () => {
    const fetchOpts = { method, headers: { 'content-type':'application/json', ...(opts.headers||{}) } };
    if (body) fetchOpts.body = body;
    const r = await fetch(url, fetchOpts);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    const data = await r.json();
    _cache.set(key, { ts:_now(), ttl:ttlMs, value:data });
    return data;
  };

  const p = _enqueue(doFetch);
  _cache.set(key, { ts:_now(), ttl:ttlMs, promise:p });
  try {
    const data = await p;
    _cache.set(key, { ts:_now(), ttl:ttlMs, value:data });
    return data;
  } catch (e) {
    _cache.delete(key);
    throw e;
  }
}

// convenience
export const get  = (url, ttlMs) => fetchJSON(url, { ttlMs });
export const post = (url, body, ttlMs) => fetchJSON(url, { method:'POST', body, ttlMs });
