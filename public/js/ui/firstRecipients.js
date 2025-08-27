import {getState, subscribe} from '../state/store.js';
import {getTransfers10k} from '../api/tabsApi.js';

export function initFirstRecipients(){
  subscribe(async (s)=>{
    if (!s.single) return;
    const ca = s.single;
    try {
      const transfers = await getTransfers10k(ca);
      const first = computeFirstRecipients(transfers);
      renderFirstRecipients(first);
    } catch (e) {
      console.warn('FirstRecipients: failed to load transfers', e);
    }
  });
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

function computeFirstRecipients(transfersJson){
  const txs = normalizeTransfers(transfersJson);
  const firstSeen = new Map(); // to -> ts
  const arr = [];
  for (const t of txs){
    if (!firstSeen.has(t.to)){
      firstSeen.set(t.to, t.ts);
      arr.push({ address: t.to, ts: t.ts, amount: t.value });
      if (arr.length >= 25) break;
    }
  }
  return arr;
}

function renderFirstRecipients(list){
  const host = document.getElementById('firstRecipients') || ensureHost();
  host.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'mono';
  table.innerHTML = `
    <thead><tr><th>#</th><th>Wallet</th><th>Time</th><th>Amount</th></tr></thead>
    <tbody></tbody>
  `;
  const tb = table.querySelector('tbody');
  list.forEach((r,i)=>{
    const tr = document.createElement('tr');
    const date = new Date(r.ts);
    tr.innerHTML = `<td>${i+1}</td><td>${short(r.address)}</td><td>${date.toISOString()}</td><td>${r.amount}</td>`;
    tb.appendChild(tr);
  });
  host.appendChild(table);
}

function ensureHost(){
  const b = document.getElementById('boxRight') || document.body;
  const div = document.createElement('div');
  div.id = 'firstRecipients';
  b.appendChild(div);
  return div;
}
function short(a){ return a ? a.slice(0,6)+'…'+a.slice(-4) : ''; }
