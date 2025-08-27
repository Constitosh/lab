import {getState, subscribe} from '../state/store.js';
import {getHolders10k, getTransfers10k} from '../api/tabsApi.js';

/** ===== Config (tweak as you wish) ===== */
const WINDOW_SHARED_FIRST_SENDER_MS = 15 * 60 * 1000;   // 15 minutes
const WINDOW_FUNDER_MS             = 12 * 60 * 60 * 1000; // 12 hours
const MIN_FUNDED_WALLETS_FOR_BUNDLE = 2;  // group when funder seeded >= 2 wallets
const MIN_FIRST_SENDER_COHORT       = 2;  // group cohorts of size >= 2

/** ===== Local state (per token draw) ===== */
let nodes = [];              // [{ address, size, heldPct, bundleId, current, initial, ... }]
let indexByAddr = new Map(); // address -> node index
let bundles = new Map();     // bundleId -> Set(index)
let hoveredIndex = -1;

// Simple DSU / Union-Find
class DSU {
  constructor(n){ this.p = Array.from({length:n}, (_,i)=>i); this.r = new Array(n).fill(0); }
  find(x){ return this.p[x]===x ? x : (this.p[x]=this.find(this.p[x])); }
  union(a,b){ a=this.find(a); b=this.find(b); if(a===b) return;
    if(this.r[a]<this.r[b]) [a,b]=[b,a];
    this.p[b]=a; if(this.r[a]===this.r[b]) this.r[a]++; }
  groups(){
    const g=new Map();
    for (let i=0;i<this.p.length;i++){ const r=this.find(i); if(!g.has(r)) g.set(r,[]); g.get(r).push(i); }
    return g;
  }
}

/** ===== Public entry ===== */
export function initBubble(){
  wireCanvas();
  subscribe(async (s)=>{
    if (!s.single) { clearCanvas(); return; }
    const ca = s.single;
    try {
      const [holders, transfers] = await Promise.all([
        getHolders10k(ca),
        getTransfers10k(ca),
      ]);
      const stats = buildWalletStats(transfers, holders);
      const { list, groupsMap } = detectBundles(stats);
      nodes = list;
      bundles = groupsMap;
      indexByAddr = new Map(list.map((n,i)=>[n.address,i]));
      drawBubbles(nodes, bundles);
    } catch (e) {
      console.warn('Bubble: failed to load', e);
      clearCanvas();
    }
  });
}

/** ===== Data building ===== */
function normalizeHolders(holdersJson){
  const result = holdersJson?.result || holdersJson || [];
  const map = new Map();
  for (const h of result) {
    const addr = (h.Address || h.address || h.holder || '').toLowerCase();
    if (!addr) continue;
    const bal  = Number(h.Balance ?? h.balance ?? h.value ?? 0);
    map.set(addr, bal);
  }
  return map;
}
function normalizeTransfers(transfersJson){
  const result = transfersJson?.result || transfersJson || [];
  const list = [];
  for (const t of result) {
    const from = (t.from || t.fromAddress || '').toLowerCase();
    const to   = (t.to   || t.toAddress   || '').toLowerCase();
    const val  = Number(t.value || t.amount || 0);
    const tsRaw= Number(t.timeStamp || t.blockTime || t.timestamp || 0);
    const ts   = tsRaw > 1e12 ? tsRaw : tsRaw * 1000; // ms
    if (!from || !to || !val) continue;
    list.push({from, to, value: val, ts});
  }
  list.sort((a,b)=> a.ts - b.ts);
  return list;
}

function buildWalletStats(transfersJson, holdersJson){
  const holders = normalizeHolders(holdersJson);
  const txs     = normalizeTransfers(transfersJson);

  const incoming = new Map(); // addr -> [{from, value, ts}]
  const outgoing = new Map(); // addr -> [{to, value, ts}]
  const firstInbound = new Map(); // addr -> {sender, ts, value}

  for (const t of txs){
    if (!incoming.has(t.to)) incoming.set(t.to, []);
    if (!outgoing.has(t.from)) outgoing.set(t.from, []);
    incoming.get(t.to).push({ from: t.from, value: t.value, ts: t.ts });
    outgoing.get(t.from).push({ to: t.to, value: t.value, ts: t.ts });

    if (!firstInbound.has(t.to)) {
      firstInbound.set(t.to, { sender: t.from, ts: t.ts, value: t.value });
    }
  }

  const wallets = new Set([...incoming.keys(), ...outgoing.keys(), ...holders.keys()]);

  const stats = [];
  for (const addr of wallets){
    const ins = (incoming.get(addr) || []).slice().sort((a,b)=>a.ts-b.ts);
    const outs= (outgoing.get(addr) || []).slice().sort((a,b)=>a.ts-b.ts);

    let initialBuy = 0;
    let soldDetected = false;

    let i=0, o=0;
    while (i<ins.length || o<outs.length){
      const nextIn  = i<ins.length ? ins[i] : null;
      const nextOut = o<outs.length ? outs[o] : null;
      const chooseIn = nextOut==null || (nextIn && nextIn.ts <= nextOut.ts);

      if (chooseIn){
        if (!soldDetected) initialBuy += nextIn.value;
        i++;
      } else {
        if (!soldDetected) soldDetected = true; // first out freezes initialBuy
        o++;
      }
    }

    let current = holders.get(addr);
    if (!Number.isFinite(current)) {
      const sumIn  = ins.reduce((a,b)=>a+b.value,0);
      const sumOut = outs.reduce((a,b)=>a+b.value,0);
      current = sumIn - sumOut;
    }

    if (!Number.isFinite(initialBuy) || initialBuy<=0) {
      initialBuy = ins.reduce((a,b)=>a+b.value,0);
    }
    const heldPct = initialBuy>0 ? Math.max(0, Math.min(200, (current/initialBuy)*100)) : 0;

    stats.push({
      address: addr,
      firstInbound: firstInbound.get(addr) || null,
      initialBuy,
      current,
      heldPct,
      firstSender: firstInbound.get(addr)?.sender || null,
      firstTs: firstInbound.get(addr)?.ts || null,
      size: Math.max(2, Math.sqrt(current || 0)),
    });
  }

  return stats;
}

/** ===== Bundle detection ===== */
function detectBundles(stats){
  const dsu = new DSU(stats.length);

  // Shared first sender cohort
  const bySender = new Map(); // sender -> [{i, ts}]
  stats.forEach((s,i)=>{
    if (!s.firstSender || !s.firstTs) return;
    if (!bySender.has(s.firstSender)) bySender.set(s.firstSender, []);
    bySender.get(s.firstSender).push({ i, ts: s.firstTs });
  });
  for (const [sender, arr] of bySender){
    arr.sort((a,b)=>a.ts-b.ts);
    let start=0;
    for (let end=0; end<arr.length; end++){
      while (arr[end].ts - arr[start].ts > WINDOW_SHARED_FIRST_SENDER_MS) start++;
      const len = end - start + 1;
      if (len >= MIN_FIRST_SENDER_COHORT){
        for (let x=start; x<end; x++) dsu.union(arr[x].i, arr[x+1].i);
      }
    }
  }

  // Funder window (seeded multiple wallets within 12h)
  const funderToWallets = new Map();
  for (let i=0;i<stats.length;i++){
    const s = stats[i];
    if (!s.firstSender || !s.firstTs) continue;
    const list = funderToWallets.get(s.firstSender) || [];
    list.push({ i, ts: s.firstTs });
    funderToWallets.set(s.firstSender, list);
  }
  for (const [funder, list] of funderToWallets){
    if (list.length < MIN_FUNDED_WALLETS_FOR_BUNDLE) continue;
    list.sort((a,b)=>a.ts-b.ts);
    let start=0;
    for (let end=0; end<list.length; end++){
      while (list[end].ts - list[start].ts > WINDOW_FUNDER_MS) start++;
      const len = end - start + 1;
      if (len >= MIN_FUNDED_WALLETS_FOR_BUNDLE){
        for (let x=start; x<end; x++) dsu.union(list[x].i, list[x+1].i);
      }
    }
  }

  const groups = dsu.groups();
  const bundleIdByIndex = new Map();
  let seq=1;
  for (const [root, members] of groups){
    const bundleId = members.length>1 ? `B${seq++}` : null;
    for (const i of members) bundleIdByIndex.set(i, bundleId);
  }

  const list = stats.map((s,i)=> ({ ...s, bundleId: bundleIdByIndex.get(i) || null }));
  const groupsMap = new Map();
  list.forEach((n,i)=>{
    if (!n.bundleId) return;
    if (!groupsMap.has(n.bundleId)) groupsMap.set(n.bundleId, new Set());
    groupsMap.get(n.bundleId).add(i);
  });

  return { list, groupsMap };
}

/** ===== Rendering + hover bar ===== */
let canvas, ctx, tooltip;
let W=800, H=500;

function wireCanvas(){
  canvas = document.getElementById('bubbleCanvas');
  if (!canvas){
    const host = document.getElementById('boxLeft') || document.body;
    canvas = document.createElement('canvas');
    canvas.id = 'bubbleCanvas';
    canvas.width = W; canvas.height = H;
    canvas.style.width = '100%'; canvas.style.height = '100%';
    canvas.style.display = 'block';
    host.appendChild(canvas);
  }
  ctx = canvas.getContext('2d');

  tooltip = document.getElementById('bubbleTooltip');
  if (!tooltip){
    tooltip = document.createElement('div');
    tooltip.id = 'bubbleTooltip';
    tooltip.className = 'mono';
    Object.assign(tooltip.style, {
      position:'fixed', pointerEvents:'none', background:'var(--panel)',
      border:'1px solid var(--muted)', padding:'6px 8px', borderRadius:'6px',
      fontSize:'12px', display:'none', zIndex: 1000, minWidth:'160px'
    });
    document.body.appendChild(tooltip);
  }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  window.addEventListener('resize', onResize);
  onResize();
}

function onResize(){
  const rect = canvas.getBoundingClientRect();
  W = Math.max(300, Math.floor(rect.width));
  H = Math.max(200, Math.floor(rect.height));
  canvas.width = W; canvas.height = H;
  draw();
}

function clearCanvas(){
  if (!ctx) return;
  ctx.clearRect(0,0,W,H);
  nodes = [];
  bundles = new Map();
  if (tooltip) tooltip.style.display = 'none';
}

function layoutGrid(n){
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n/cols);
  const pad = 10;
  const cellW = (W - pad*2)/cols;
  const cellH = (H - pad*2)/rows;
  return (i) => {
    const c = i % cols;
    const r = Math.floor(i/cols);
    return {
      x: pad + c*cellW + cellW/2,
      y: pad + r*cellH + cellH/2,
    };
  };
}

function drawBubbles(list, groups){
  const pos = layoutGrid(list.length);
  list.forEach((n,i)=> {
    const {x,y} = pos(i);
    n.x = x; n.y = y;
    n.r = Math.max(3, Math.log10(1 + Math.abs(n.current)) * 6);
  });
  draw();
}

function draw(){
  if (!ctx) return;
  ctx.clearRect(0,0,W,H);

  for (let i=0;i<nodes.length;i++){
    const n = nodes[i];
    const inBundle = n.bundleId != null;
    const isHovered = (i===hoveredIndex);
    const shareHover = hoveredIndex>=0 && n.bundleId && nodes[hoveredIndex].bundleId===n.bundleId;

    const alpha = isHovered ? 1 : shareHover ? 0.95 : 0.6;
    ctx.globalAlpha = alpha;

    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI*2);
    ctx.fillStyle = inBundle ? 'rgba(0,200,120,0.35)' : 'rgba(255,255,255,0.20)';
    ctx.fill();

    if (shareHover || isHovered){
      ctx.lineWidth = isHovered ? 2.5 : 2.0;
      ctx.strokeStyle = 'rgba(0,255,160,0.9)';
      ctx.stroke();
    } else if (inBundle){
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = 'rgba(0,200,120,0.7)';
      ctx.stroke();
    } else {
      ctx.lineWidth = 1.0;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function hitTest(mx,my){
  for (let i=nodes.length-1;i>=0;i--){
    const n=nodes[i];
    const dx=mx-n.x, dy=my-n.y;
    if (dx*dx+dy*dy <= n.r*n.r) return i;
  }
  return -1;
}

function onMove(e){
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const idx = hitTest(mx,my);
  if (idx !== hoveredIndex){
    hoveredIndex = idx;
    draw();
  }
  if (idx>=0){
    const n = nodes[idx];
    showTooltip(e.clientX, e.clientY, n);
  } else if (tooltip){
    tooltip.style.display='none';
  }
}

function onLeave(){
  hoveredIndex = -1;
  draw();
  if (tooltip) tooltip.style.display='none';
}

function showTooltip(cx, cy, n){
  tooltip.innerHTML = renderHeldBarHTML(n);
  tooltip.style.left = (cx + 12) + 'px';
  tooltip.style.top  = (cy + 12) + 'px';
  tooltip.style.display = 'block';
}

function renderHeldBarHTML(n){
  const pct = Math.max(0, Math.min(200, n.heldPct || 0));
  const pctText = (n.heldPct || 0).toFixed(1) + '%';
  const showPct = Math.min(100, pct);
  return `
    <div style="margin-bottom:4px"><b>${short(n.address)}</b>${n.bundleId ? ` &nbsp;<span class="tag">Bundle ${n.bundleId}</span>`:''}</div>
    <div style="margin-bottom:4px">Held of initial buy: <b>${pctText}</b></div>
    <div style="height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden">
      <div style="height:100%;width:${showPct}%;background:var(--abs-green)"></div>
    </div>
  `;
}

function short(a){ return a ? a.slice(0,6)+'…'+a.slice(-4) : ''; }
