import {get, post} from './request.js';
import {getCache, setCache} from '../state/store.js';

// ---- Snapshot & library ----
let _refreshInFlight = null;
let _lastSnapshot = null;

/** Return the last snapshot without fetching. */
export function getLatestSnapshot(){ return _lastSnapshot; }

/** POST /api/refresh (deduped) */
export async function refreshSnapshot(){
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = post('/api/refresh', {}, 0)
    .then(r => {
      _lastSnapshot = r.snapshot || r;
      return _lastSnapshot;
    })
    .finally(()=>{ _refreshInFlight = null; });
  return _refreshInFlight;
}

/** GET /api/snapshot/latest (used on first boot if you want cached) */
export const getCachedSnapshot = () => get('/api/snapshot/latest', 5_000).then(r=>r.snapshot||r);

/** POST /api/add-token { ca } */
export const addToken = (ca) => post('/api/add-token', { ca }, 0);

// ---- Icons (Dexscreener) ----
export async function getTokenIcon(ca){
  const hit = getCache('icons', ca);
  if (hit) return hit;
  const { url } = await get(`/api/icon/${ca}`, 10*60_000);
  setCache('icons', ca, url);
  return url;
}

// ---- Heavy per-token data (Etherscan-like 10k limit) ----
const TTL_5M = 5*60_000;

export async function getHolders10k(ca){
  const hit = getCache('holders', ca);
  if (hit && (Date.now()-hit.ts)<TTL_5M) return hit.data;
  const data = await get(`/api/token/${ca}/holders?limit=10000`, TTL_5M);
  setCache('holders', ca, { ts:Date.now(), data });
  return data;
}

export async function getTransfers10k(ca){
  const hit = getCache('transfers', ca);
  if (hit && (Date.now()-hit.ts)<TTL_5M) return hit.data;
  const data = await get(`/api/token/${ca}/transfers?limit=10000`, TTL_5M);
  setCache('transfers', ca, { ts:Date.now(), data });
  return data;
}
