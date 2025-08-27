import {getState, subscribe, setMode, setSingleToken} from '../state/store.js';

function el(id){ return document.getElementById(id); }

function mkRow(i, t){
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="mono rowhead">${i+1}</td>
    <td class="mono">
      <div class="tok">
        <img class="tokicon" alt="" />
        <b>${t.name}</b> <span class="tag">${t.symbol}</span>
      </div>
    </td>
    <td class="${(t.priceChange?.h24||0)>=0?'chg-pos':'chg-neg'} mono">${(t.priceChange?.h24??0).toFixed(2)}%</td>
    <td class="mono">${Math.round(t.volume24h).toLocaleString()}</td>
    <td class="mono">${t.marketCap ? Math.round(t.marketCap).toLocaleString() : '—'}</td>
  `;
  tr.addEventListener('click', ()=> setSingleToken(t.baseAddress));
  return tr;
}

function renderList(list){
  const $top5   = el('top5');
  const $rest10 = el('rest10');
  if (!$top5 || !$rest10) return;
  $top5.innerHTML = '';
  $rest10.innerHTML = '';
  list.slice(0,5).forEach((t,i)=> $top5.appendChild(mkRow(i,t)));
  list.slice(5,15).forEach((t,i)=> $rest10.appendChild(mkRow(i+5,t)));
}

function filterByQuery(list, q){
  if (!q) return list;
  q = q.toLowerCase();
  return list.filter(t => (t.name||'').toLowerCase().includes(q) || (t.symbol||'').toLowerCase().includes(q));
}

export function initTop(){
  const $tabG = el('tabGainers');
  const $tabV = el('tabVol');
  const $clear= el('clearBtn');
  const $search = el('search');
  const $toggle = el('toggleExpand');

  $tabG?.addEventListener('click', ()=> setMode('gainers'));
  $tabV?.addEventListener('click', ()=> setMode('vol'));
  $clear?.addEventListener('click', ()=> setSingleToken(null));
  $search?.addEventListener('input', ()=> { draw(); });
  $toggle?.addEventListener('click', ()=>{
    document.getElementById('expander')?.classList.toggle('open');
  });

  subscribe(draw);
  draw();
}

function draw(){
  const s = getState();
  const snap = s.snapshot;
  if (!snap) return;

  const single = !!s.single;
  const $tg = document.getElementById('tabGainers');
  const $tv = document.getElementById('tabVol');
  const $cb = document.getElementById('clearBtn');
  if ($tg) $tg.style.display = single ? 'none' : '';
  if ($tv) $tv.style.display = single ? 'none' : '';
  if ($cb) $cb.style.display = single ? '' : 'none';

  let list = s.mode === 'gainers' ? snap.topGainers : snap.topVol;
  list = list || [];

  const q = document.getElementById('search')?.value?.trim();
  list = filterByQuery(list, q);

  if (single){
    const row = list.find(t => t.baseAddress === s.single)
            || (snap.topGainers||[]).find(t=>t.baseAddress===s.single)
            || (snap.topVol||[]).find(t=>t.baseAddress===s.single);
    if (row) renderList([row]);
    else renderList([]);
  } else {
    renderList(list);
  }
}
