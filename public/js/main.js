import {getCachedSnapshot, refreshSnapshot, addToken} from './api/tabsApi.js';
import {setSnapshot, setMode} from './state/store.js';
import {initHeader} from './ui/header.js';
import {initTop} from './ui/top.js';
import {initBubble} from './ui/bubble.js';
import {initFirstRecipients} from './ui/firstRecipients.js';

const $boot = document.getElementById('bootOverlay');
const $bootBar = document.getElementById('bootBar');
const $bootStatus = document.getElementById('bootStatus');
const $refreshBtn = document.getElementById('refresh');

async function boot() {
  showBoot('Loading latest snapshot…');

  try {
    const cached = await getCachedSnapshot();
    if (cached?.banner) {
      setSnapshot(cached);
      setMode('gainers');
      tickBoot(40);
    }
  } catch {}

  try {
    const fresh = await refreshSnapshot();
    setSnapshot(fresh);
    tickBoot(100);
  } catch (e) {
    console.error(e);
    showBoot('Failed to refresh. Using last saved snapshot.');
  }

  hideBoot();

  initHeader();
  initTop();
  initBubble();
  initFirstRecipients();

  $refreshBtn?.addEventListener('click', onRefreshClick);
}

function showBoot(msg){ $boot?.classList.remove('hidden'); if ($bootStatus) $bootStatus.textContent = msg; }
function hideBoot(){ $boot?.classList.add('hidden'); }
function tickBoot(pct){ if ($bootBar) $bootBar.style.width = `${pct}%`; }

async function onRefreshClick(){
  const ca = (document.getElementById('search')?.value || '').trim();
  if (ca && /^0x[a-fA-F0-9]{40}$/.test(ca)) {
    const payload = await addToken(ca);
    if (payload?.snapshot) setSnapshot(payload.snapshot);
  } else {
    const fresh = await refreshSnapshot();
    setSnapshot(fresh);
  }
}

boot();
