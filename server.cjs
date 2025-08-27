
// server.cjs — modular tabs backend (drop-in update)
// Node 18+ required (global fetch). Run with: node server.cjs

const fs = require('fs');
const path = require('path');
const express = require('express');

const PORT = process.env.PORT || 8081;
const app = express();
app.use(express.json());

// ---- Static UI ----
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// ---- Data files ----
const DATA_DIR = path.join(__dirname, 'data');
const TOKENS_LIB_PATH = path.join(DATA_DIR, 'tokens-lib.json');
const SNAPSHOTS_PATH  = path.join(DATA_DIR, 'snapshots.json');

function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(DATA_DIR);

function readJSON(file, fallback){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data){
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- Load libraries ----
let tokensLib = readJSON(TOKENS_LIB_PATH, { tokens: [], tokenPairs: {}, pairs: {} });
if (!Array.isArray(tokensLib.tokens)) tokensLib.tokens = [];
if (!tokensLib.tokenPairs) tokensLib.tokenPairs = {};
if (!tokensLib.pairs) tokensLib.pairs = {};

let snapshots = readJSON(SNAPSHOTS_PATH, { latest: null, history: [] });
if (!Array.isArray(snapshots.history)) snapshots.history = [];

// ---- Dexscreener endpoints ----
const DEX_BASE = 'https://api.dexscreener.com';
const ds = {
  tokenAbstract: (csvCas) => `${DEX_BASE}/tokens/v1/abstract/${csvCas}`,
  search: (q) => `${DEX_BASE}/latest/dex/search?q=${encodeURIComponent(q)}`,
  pairAbstract: (pairCa) => `${DEX_BASE}/latest/dex/pairs/abstract/${pairCa}`
};

// ---- Small in-memory GET cache (dedup + TTL) ----
const _mem = new Map(); // url -> { ts, ttl, inFlight, value }
function _now(){ return Date.now(); }
async function cachedGet(url, ttlMs=60_000){
  const hit = _mem.get(url);
  if (hit){
    const fresh = hit.value && (_now()-hit.ts) < hit.ttl;
    if (fresh) return hit.value;
    if (hit.inFlight) return hit.inFlight;
  }
  const p = fetch(url).then(r=>{
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.json();
  }).then(j=>{
    _mem.set(url, { ts:_now(), ttl: ttlMs, value: j });
    return j;
  }).finally(()=>{
    const h = _mem.get(url);
    if (h) h.inFlight = null;
  });
  _mem.set(url, { ts:_now(), ttl: ttlMs, inFlight: p });
  return p;
}

// ---- Utilities ----
function uniq(arr){ return Array.from(new Set(arr)); }
function safeNum(x){ const n=Number(x); return Number.isFinite(n) ? n : null; }
function sum(arr){ return arr.reduce((a,b)=>a + (Number(b)||0), 0); }

// ---- Discover pairs for a token (via search) ----
async function discoverPairs(tokenCA){
  const url = ds.search(tokenCA);
  const json = await cachedGet(url, 10*60_000);
  const pairs = (json?.pairs || [])
    .filter(p => (p.baseToken?.address||'').toLowerCase() === tokenCA.toLowerCase())
    .map(p => p.pairAddress || p.pairAddressRaw || p.pairId || p.pair?.address)
    .filter(Boolean);
  const unique = uniq(pairs);
  if (!tokensLib.tokenPairs[tokenCA]) tokensLib.tokenPairs[tokenCA] = [];
  const merged = uniq([...(tokensLib.tokenPairs[tokenCA]||[]), ...unique]);
  tokensLib.tokenPairs[tokenCA] = merged;
  writeJSON(TOKENS_LIB_PATH, tokensLib);
  return merged;
}

// ---- Build one TokenRow ----
async function buildTokenRow(tokenCA){
  // 1) token abstract
  const absUrl = ds.tokenAbstract(tokenCA);
  const tjson = await cachedGet(absUrl, 5*60_000);
  const ti = Array.isArray(tjson) ? tjson[0] : tjson;
  const baseToken = ti?.baseToken || {};
  const name   = baseToken.name || 'Unknown';
  const symbol = baseToken.symbol || '';
  const marketCap = safeNum(ti?.marketCap);
  const fdv       = safeNum(ti?.fdv);
  const priceChange = {
    m5: safeNum(ti?.priceChange?.m5),
    h1: safeNum(ti?.priceChange?.h1),
    h6: safeNum(ti?.priceChange?.h6),
    h24: safeNum(ti?.priceChange?.h24)
  };
  const url = ti?.url || null;

  // 2) ensure pairs in library
  const pairCAs = await discoverPairs(tokenCA);

  // 3) aggregate 24h volume across all pairs
  let vol24 = 0;
  for (const pair of pairCAs){
    const pUrl = ds.pairAbstract(pair);
    const pjson = await cachedGet(pUrl, 5*60_000);
    const pairs = pjson?.pairs || [];
    for (const pr of pairs){
      const v = pr?.volume?.h24 ?? pr?.volume24h ?? pr?.volume24H ?? 0;
      vol24 += Number(v) || 0;
    }
  }

  return {
    baseAddress: tokenCA,
    name, symbol,
    priceChange,
    marketCap,
    fdv,
    volume24h: vol24,
    url
  };
}

// ---- Full scan (build snapshot) ----
let _scanning = false;
async function runScan(){
  if (_scanning) return snapshots.latest || { ts: Date.now(), chain:'abstract', banner: {}, topGainers:[], topVol:[], tokensTracked: tokensLib.tokens.length };
  _scanning = true;
  try {
    const tokenCAs = tokensLib.tokens || [];
    const rows = [];
    for (const ca of tokenCAs){
      try {
        const row = await buildTokenRow(ca);
        rows.push(row);
      } catch (e) {
        console.error('Failed token row', ca, e.message);
      }
    }

    const topGainers = rows.slice().sort((a,b)=>(b.priceChange?.h24||0)-(a.priceChange?.h24||0)).slice(0,15);
    const topVol     = rows.slice().sort((a,b)=>(b.volume24h||0)-(a.volume24h||0)).slice(0,15);

    const banner = {
      holders: null,
      fdv: safeNum(sum(rows.map(r=>r.fdv||r.marketCap||0))) || null,
      marketCap: null,
      vol24: Math.round(sum(rows.map(r=>r.volume24h||0))),
      chg24: 0,
      url: 'https://dexscreener.com/abstract'
    };

    const snapshot = {
      ts: Date.now(),
      chain: 'abstract',
      banner,
      topGainers,
      topVol,
      tokensTracked: tokenCAs.length
    };

    snapshots.latest = snapshot;
    snapshots.history.unshift(snapshot);
    snapshots.history = snapshots.history.slice(0,5);
    writeJSON(SNAPSHOTS_PATH, snapshots);
    return snapshot;
  } finally {
    _scanning = false;
  }
}

// ---- APIs ----
app.post('/api/refresh', async (req,res)=>{
  try {
    const snapshot = await runScan();
    res.json({ snapshot });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/snapshot/latest', (req,res)=>{
  res.json({ snapshot: snapshots.latest || null });
});

app.post('/api/add-token', async (req,res)=>{
  try {
    const ca = String(req.body?.ca||'').toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(ca)) return res.status(400).json({ error: 'Invalid CA' });
    if (!tokensLib.tokens.includes(ca)){
      tokensLib.tokens.push(ca);
      tokensLib.tokens = uniq(tokensLib.tokens);
      writeJSON(TOKENS_LIB_PATH, tokensLib);
    }
    await discoverPairs(ca);
    const row = await buildTokenRow(ca);
    res.json({ row, tokensTracked: tokensLib.tokens.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// ===== NEW PROXIES (keeps keys server-side; avoids CORS) =====
const ABS_ETHERSCAN_BASE = process.env.ABS_ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ABS_ETHERSCAN_KEY  = process.env.ABS_ETHERSCAN_KEY  || 'H13F5VZ64YYK4M21QMPEW78SIKJS85UTWT';

async function _cachedGet(url, ttlMs=300000){
  return cachedGet(url, ttlMs);
}

app.get('/api/token/:ca/holders', async (req,res)=>{
  try {
    const { ca } = req.params;
    const limit = Number(req.query.limit||10000);
    const url = `${ABS_ETHERSCAN_BASE}?module=token&action=tokenholderlist&contractaddress=${ca}&page=1&offset=${limit}&sort=asc${ABS_ETHERSCAN_KEY ? `&apikey=${ABS_ETHERSCAN_KEY}`:''}`;
    const json = await _cachedGet(url, 5*60_000);
    res.json(json);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/token/:ca/transfers', async (req,res)=>{
  try {
    const { ca } = req.params;
    const limit = Number(req.query.limit||10000);
    const url = `${ABS_ETHERSCAN_BASE}?module=account&action=tokentx&contractaddress=${ca}&page=1&offset=${limit}&sort=asc${ABS_ETHERSCAN_KEY ? `&apikey=${ABS_ETHERSCAN_KEY}`:''}`;
    const json = await _cachedGet(url, 5*60_000);
    res.json(json);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/icon/:ca', async (req,res)=>{
  try {
    const { ca } = req.params;
    const u = `${DEX_BASE}/tokens/v1/abstract/${ca}`;
    const json = await _cachedGet(u, 24*60*60_000);
    const info = Array.isArray(json) ? json[0]?.info : json?.info;
    res.json({ url: info?.imageUrl || null });
  } catch (e) {
    res.json({ url: null });
  }
});

// ---- Start ----
app.listen(PORT, ()=>{
  console.log(`tabs server listening on http://0.0.0.0:${PORT}`);
});
