import {subscribe} from '../state/store.js';

function fmt(n){
  if (n == null) return '—';
  if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(2)+'B';
  if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(1)+'K';
  return String(n);
}

export function initHeader(){
  const $cap     = document.getElementById('tabsCap');
  const $vol     = document.getElementById('tabsVol');
  const $holders = document.getElementById('tabsHolders');
  const $chg     = document.getElementById('tabsChg');
  const $link    = document.getElementById('tabsLink');
  const $tracked = document.getElementById('trackedLine');

  subscribe(s=>{
    const b = s.snapshot?.banner;
    if (b){
      if ($cap)     $cap.textContent     = fmt(b.fdv ?? b.marketCap);
      if ($vol)     $vol.textContent     = fmt(b.vol24);
      if ($holders) $holders.textContent = b.holders == null ? '—' : fmt(b.holders);
      if ($chg)     $chg.textContent     = (b.chg24>=0?'+':'') + (b.chg24??0);
      if (b.url && $link) $link.href = b.url;
    }
    if (s.snapshot?.tokensTracked != null && $tracked){
      $tracked.textContent = `${s.snapshot.tokensTracked} tokens tracked`;
    }
  });
}
