const state = {
  snapshot: null,       // {banner, topGainers, topVol, tokensTracked, ...}
  mode: 'gainers',      // 'gainers' | 'vol'
  single: null,         // token CA for single-token mode, or null
  caches: {
    icons: new Map(),       // ca -> url
    holders: new Map(),     // ca -> { ts, ttl, data }
    transfers: new Map(),   // ca -> { ts, ttl, data }
  }
};

const subs = new Set();

export function subscribe(fn){
  subs.add(fn);
  return () => subs.delete(fn);
}
function emit(){ for (const fn of subs) try { fn(state); } catch{} }

export function getState(){ return state; }

export function setSnapshot(snapshot){
  state.snapshot = snapshot;
  emit();
}
export function setMode(mode){
  if (mode !== state.mode){ state.mode = mode; emit(); }
}
export function setSingleToken(caOrNull){
  if (caOrNull !== state.single){ state.single = caOrNull; emit(); }
}

// cache helpers
export function getCache(mapName, key){ return state.caches[mapName].get(key); }
export function setCache(mapName, key, value){ state.caches[mapName].set(key, value); }
