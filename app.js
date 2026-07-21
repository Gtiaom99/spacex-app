'use strict';

/* ---------- Config & constants ---------- */
const SYMBOL = 'SPCX';
const IPO_DATE = '2026-06-12';
const IPO_PRICE = 135;
const LL_API = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?search=Starship&limit=12&mode=list';
const CACHE_TTL = 25 * 60 * 1000; // 25 min for launch cache (API is rate-limited)

const LS = {
  apiKey: 'spcx.apiKey',
  avKey: 'spcx.avKey',         // Alpha Vantage key for real price history
  realHist: 'spcx.realHist',   // real daily closes recorded from live quotes
  calls: 'spcx.calls.v2',      // bumped: v2 ships researched real dates
  lockups: 'spcx.lockups.v2',
  launchCache: 'spcx.launchCache',
  priceCache: 'spcx.priceCache',
};

/* Seeded, user-editable events. Dates researched from public reporting
   (SpaceX IR, financial press) — see README for sources. Tap ✎ to edit. */
const SEED_CALLS = [
  { id: 'c1', title: 'Q2 2026 earnings call', date: '2026-08-04', note: 'First report as public co. · webcast 3:30pm CT' },
  { id: 'c2', title: 'Q3 2026 earnings call', date: '2026-11-04', note: 'Estimated (~early Nov)' },
];
const SEED_LOCKUPS = [
  { id: 'l1', title: '~20% unlocks after Q2 earnings', date: '2026-08-04', note: '+~10% early if SPCX >$175.50 on 5 of 10 days' },
  { id: 'l2', title: 'Time-based tranche (~7%)', date: '2026-09-10', note: '90-day milestone' },
  { id: 'l3', title: 'Time-based tranche (~7%)', date: '2026-10-25', note: '135-day milestone' },
  { id: 'l4', title: '~28% unlocks after Q3 earnings', date: '2026-11-04', note: '~1.3B shares eligible (est.)' },
  { id: 'l5', title: '180-day lock-up full expiry', date: '2026-12-08', note: 'Remaining insider/employee shares freed' },
  { id: 'l6', title: "Musk's shares unlock (~6.4B)", date: '2027-06-12', note: 'Largest single supply wave · 366-day lock' },
];

/* ---------- Small helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const fmtMoney = (n) => (n == null || isNaN(n)) ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const load = (k, fallback) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch { return fallback; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function parseDate(s) { const d = new Date(s); return isNaN(d) ? null : d; }
function daysUntil(dateStr) {
  const d = parseDate(dateStr); if (!d) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  const t = new Date(d); t.setHours(0,0,0,0);
  return Math.round((t - now) / 86400000);
}
function relLabel(dateStr) {
  const n = daysUntil(dateStr);
  if (n == null) return '';
  if (n === 0) return 'Today';
  if (n > 0) return `in ${n} day${n === 1 ? '' : 's'}`;
  return `${-n} day${n === -1 ? '' : 's'} ago`;
}
function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

/* ---------- Stock price ---------- */
async function fetchFromFinnhub(key) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${SYMBOL}&token=${encodeURIComponent(key)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('finnhub ' + r.status);
  const j = await r.json();
  if (j.c == null || j.c === 0) throw new Error('finnhub empty');
  return { price: j.c, change: j.d, pct: j.dp, open: j.o, high: j.h, low: j.l, prevClose: j.pc, source: 'Finnhub' };
}

async function fetchFromStooq() {
  // Keyless fallback. May be blocked by CORS on some networks.
  const url = `https://stooq.com/q/l/?s=${SYMBOL.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('stooq ' + r.status);
  const text = await r.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('stooq empty');
  const cols = lines[1].split(',');
  // Symbol,Date,Time,Open,High,Low,Close,Volume
  const open = +cols[3], high = +cols[4], low = +cols[5], close = +cols[6];
  if (!close || isNaN(close)) throw new Error('stooq no close');
  const change = close - open;
  return { price: close, change, pct: open ? (change / open) * 100 : null, open, high, low, prevClose: open, source: 'Stooq (EOD)' };
}

async function loadPrice() {
  const key = load(LS.apiKey, '');
  let data = null, err = null;
  try {
    if (key) data = await fetchFromFinnhub(key);
    else throw new Error('no key');
  } catch (e) {
    err = e;
    try { data = await fetchFromStooq(); } catch (e2) { err = e2; }
  }

  if (data) {
    save(LS.priceCache, { data, ts: Date.now() });
    recordRealHistory(data);
    renderPrice(data, Date.now());
  } else {
    const cached = load(LS.priceCache, null);
    if (cached) {
      renderPrice(cached.data, cached.ts, true);
    } else {
      $('#priceValue').textContent = '—';
      $('#priceChange').textContent = key ? 'Could not load quote' : 'Add a Finnhub key in Settings for live prices';
      $('#priceChange').className = 'price-change';
    }
    $('#providerNote').textContent = 'Live fetch failed' + (err ? ` (${err.message})` : '') + '. Using cached value if available.';
  }
}

/* Build a genuinely real price series over time by logging each live quote.
   SPCX is too new for free history APIs, but the live quote is real — so we
   record one point per day (seeded at the IPO), and the chart draws that. */
function recordRealHistory(d) {
  if (d == null || d.price == null || isNaN(d.price)) return;
  const DAY = 86400000;
  const store = load(LS.realHist, null) || { series: [{ t: Date.parse(IPO_DATE), v: IPO_PRICE }] };
  if (!Array.isArray(store.series)) store.series = [{ t: Date.parse(IPO_DATE), v: IPO_PRICE }];
  const today = Math.floor(Date.now() / DAY) * DAY;
  const upsert = (t, v) => {
    if (v == null || isNaN(v)) return;
    const i = store.series.findIndex((p) => p.t === t);
    if (i >= 0) store.series[i].v = v; else store.series.push({ t, v });
  };
  if (d.prevClose != null) upsert(today - DAY, d.prevClose); // fill yesterday's close
  upsert(today, d.price);
  store.series.sort((a, b) => a.t - b.t);
  save(LS.realHist, store);
}

function renderPrice(d, ts, stale) {
  $('#priceValue').textContent = fmtMoney(d.price);
  const up = (d.change ?? 0) >= 0;
  const chg = $('#priceChange');
  const chgStr = (up ? '+' : '') + (d.change != null ? d.change.toFixed(2) : '—');
  const pctStr = d.pct != null ? `${up ? '+' : ''}${d.pct.toFixed(2)}%` : '';
  chg.textContent = `${chgStr} (${pctStr}) today`;
  chg.className = 'price-change ' + (up ? 'up' : 'down');

  const vsIpo = d.price != null ? ((d.price - IPO_PRICE) / IPO_PRICE) * 100 : null;
  $('#priceMeta').innerHTML = `${d.source}<br>IPO ${fmtMoney(IPO_PRICE)}` +
    (vsIpo != null ? `<br><span class="${vsIpo >= 0 ? '' : ''}">${vsIpo >= 0 ? '+' : ''}${vsIpo.toFixed(1)}% vs IPO</span>` : '');

  $('#priceStats').innerHTML = [
    ['Open', fmtMoney(d.open)],
    ['High', fmtMoney(d.high)],
    ['Low', fmtMoney(d.low)],
    ['Prev close', fmtMoney(d.prevClose)],
    ['IPO date', 'Jun 12'],
    ['vs IPO', vsIpo != null ? `${vsIpo >= 0 ? '+' : ''}${vsIpo.toFixed(1)}%` : '—'],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  $('#priceUpdated').textContent = (stale ? 'Cached · ' : 'Updated ') + timeAgo(ts) + ' · ' + d.source;
  notifyChart();
}

/* ---------- Starship launches ---------- */
async function loadLaunches() {
  const cache = load(LS.launchCache, null);
  const fresh = cache && (Date.now() - cache.ts < CACHE_TTL);
  if (cache) renderLaunches(cache.results, cache.ts, !fresh);
  if (fresh) return;

  try {
    const r = await fetch(LL_API);
    if (!r.ok) throw new Error('LL ' + r.status);
    const j = await r.json();
    const results = (j.results || []).map((x) => ({
      name: x.name,
      net: x.net,
      status: x.status?.name || x.status?.abbrev || '',
      pad: x.pad?.name || (x.pad?.location?.name) || '',
    }));
    save(LS.launchCache, { results, ts: Date.now() });
    renderLaunches(results, Date.now(), false);
  } catch (e) {
    if (!cache) $('#launchList').innerHTML = `<li class="muted">Could not load launches (${e.message}). Will retry on refresh.</li>`;
  }
}

function renderLaunches(results, ts, stale) {
  const list = $('#launchList');
  if (!results || !results.length) { list.innerHTML = '<li class="muted">No upcoming Starship launches listed.</li>'; return; }

  list.innerHTML = results.map((x) => {
    const d = parseDate(x.net);
    const dd = d ? d.getUTCDate() : '?';
    const mm = d ? MONTHS[d.getUTCMonth()] : '';
    const when = d ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : (x.net || 'TBD');
    return `<li class="row">
      <div class="date-badge"><div class="d">${dd}</div><div class="m">${mm}</div></div>
      <div class="body">
        <div class="title">${escapeHtml(x.name)}</div>
        <div class="sub">${escapeHtml(when)} · ${escapeHtml(x.pad || 'Pad TBD')}</div>
      </div>
      <span class="tag">${escapeHtml(x.status || '—')}</span>
    </li>`;
  }).join('');

  $('#launchUpdated').textContent = (stale ? 'Cached · ' : 'Updated ') + timeAgo(ts) + ' · The Space Devs';
  updateCountdown(results);
  notifyChart();
}

/* ---------- Countdown ---------- */
let countdownTarget = null;
function updateCountdown(results) {
  const now = Date.now();
  const upcoming = (results || [])
    .map((x) => ({ ...x, t: parseDate(x.net) }))
    .filter((x) => x.t && x.t.getTime() > now)
    .sort((a, b) => a.t - b.t)[0];

  if (!upcoming) {
    $('#nextLaunchName').textContent = 'No scheduled flight';
    $('#countdownTimer').textContent = '—';
    $('#nextLaunchWhen').textContent = '';
    countdownTarget = null;
    return;
  }
  countdownTarget = upcoming;
  $('#nextLaunchName').textContent = upcoming.name;
  $('#nextLaunchWhen').textContent = upcoming.t.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  tickCountdown();
}

function tickCountdown() {
  if (!countdownTarget) return;
  let diff = countdownTarget.t.getTime() - Date.now();
  const el = $('#countdownTimer');
  if (diff <= 0) { el.textContent = 'LIFTOFF'; return; }
  const d = Math.floor(diff / 86400000); diff -= d * 86400000;
  const h = Math.floor(diff / 3600000); diff -= h * 3600000;
  const m = Math.floor(diff / 60000); diff -= m * 60000;
  const s = Math.floor(diff / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  el.textContent = `T- ${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
}
setInterval(tickCountdown, 1000);

/* ---------- Editable event lists (calls + lockups) ---------- */
function getEvents(kind) {
  return load(kind === 'calls' ? LS.calls : LS.lockups, kind === 'calls' ? SEED_CALLS : SEED_LOCKUPS);
}
function setEvents(kind, arr) {
  save(kind === 'calls' ? LS.calls : LS.lockups, arr);
}
function renderEvents(kind) {
  const items = getEvents(kind).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const list = $(kind === 'calls' ? '#callsList' : '#lockupsList');
  if (!items.length) { list.innerHTML = '<li class="muted">Nothing yet. Tap “+ Add”.</li>'; return; }
  list.innerHTML = items.map((it) => {
    const d = parseDate(it.date);
    const dd = d ? d.getUTCDate() : '?';
    const mm = d ? MONTHS[d.getUTCMonth()] : '';
    const past = daysUntil(it.date) < 0;
    return `<li class="row" style="${past ? 'opacity:.55' : ''}">
      <div class="date-badge"><div class="d">${dd}</div><div class="m">${mm}</div></div>
      <div class="body">
        <div class="title">${escapeHtml(it.title)}</div>
        <div class="sub">${escapeHtml(it.note || '')}${it.note ? ' · ' : ''}${relLabel(it.date)}</div>
      </div>
      <button class="edit" data-edit="${kind}" data-id="${it.id}">✎</button>
    </li>`;
  }).join('');
}

/* ---------- Dialog for add/edit ---------- */
let dialogState = { kind: null, id: null };
function openDialog(kind, id) {
  dialogState = { kind, id: id || null };
  const dlg = $('#eventDialog');
  const existing = id ? getEvents(kind).find((e) => e.id === id) : null;
  $('#dialogTitle').textContent = (existing ? 'Edit ' : 'Add ') + (kind === 'calls' ? 'call' : 'unlock');
  $('#evtTitle').value = existing ? existing.title : '';
  $('#evtDate').value = existing ? existing.date : '';
  $('#evtNote').value = existing ? (existing.note || '') : '';
  $('#evtDelete').hidden = !existing;
  dlg.showModal();
}
function closeDialog() { $('#eventDialog').close(); }

function saveDialog() {
  const { kind, id } = dialogState;
  const title = $('#evtTitle').value.trim();
  const date = $('#evtDate').value;
  const note = $('#evtNote').value.trim();
  if (!title || !date) return;
  const arr = getEvents(kind);
  if (id) {
    const i = arr.findIndex((e) => e.id === id);
    if (i >= 0) arr[i] = { ...arr[i], title, date, note };
  } else {
    arr.push({ id: 'u' + Date.now(), title, date, note });
  }
  setEvents(kind, arr);
  renderEvents(kind);
  closeDialog();
}
function deleteEvent() {
  const { kind, id } = dialogState;
  if (!id) return;
  setEvents(kind, getEvents(kind).filter((e) => e.id !== id));
  renderEvents(kind);
  closeDialog();
}

/* ---------- Utils ---------- */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Bridge for chart.js ---------- */
window.SPCXData = {
  events: () => ({ calls: getEvents('calls'), lockups: getEvents('lockups') }),
  launches: () => (load(LS.launchCache, { results: [] }).results || []),
  price: () => load(LS.priceCache, null),
  ipo: { date: IPO_DATE, price: IPO_PRICE },
};
function notifyChart() {
  if (window.SPCXChart && !document.getElementById('chartView').hidden) {
    window.SPCXChart.render();
  }
}

/* ---------- View toggle ---------- */
function switchView(view) {
  const isChart = view === 'chart';
  document.getElementById('chartView').hidden = !isChart;
  document.getElementById('listView').hidden = isChart;
  document.querySelectorAll('#viewTabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
  localStorage.setItem('spcx.view', view);
  // defer a frame so the canvas measures its final laid-out width (crisp on first open)
  if (isChart && window.SPCXChart) requestAnimationFrame(() => window.SPCXChart.render());
}

/* ---------- Clear cache & reload ---------- */
async function clearCacheReload() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    // drop cached data so everything re-fetches fresh
    localStorage.removeItem(LS.launchCache);
    localStorage.removeItem(LS.priceCache);
    localStorage.removeItem('spcx.hist');
  } catch (e) { /* ignore */ }
  location.reload();
}

/* ---------- Wire up ---------- */
function init() {
  // Settings
  const keyInput = $('#apiKeyInput');
  keyInput.value = load(LS.apiKey, '');
  $('#providerNote').textContent = keyInput.value ? 'Using Finnhub for live quotes.' : 'No key set — trying Stooq (end-of-day) as fallback.';
  $('#saveKeyBtn').addEventListener('click', () => {
    save(LS.apiKey, keyInput.value.trim());
    $('#providerNote').textContent = 'Saved. Refreshing…';
    loadPrice();
  });

  // Alpha Vantage key (real chart history)
  const avInput = $('#avKeyInput');
  avInput.value = load(LS.avKey, '');
  $('#avNote').textContent = avInput.value
    ? 'Using Alpha Vantage for real daily history.'
    : 'No key — chart uses Stooq/sample history. Add a key for the real price path.';
  $('#saveAvKeyBtn').addEventListener('click', () => {
    save(LS.avKey, avInput.value.trim());
    localStorage.removeItem('spcx.hist'); // drop cached history so it refetches
    $('#avNote').textContent = 'Saved. Reloading chart…';
    if (window.SPCXChart) window.SPCXChart.render();
  });

  // Add buttons
  document.querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => openDialog(b.dataset.add)));

  // Edit (event delegation)
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-edit]');
    if (t) openDialog(t.dataset.edit, t.dataset.id);
  });

  // Dialog buttons
  $('#eventForm').addEventListener('submit', (e) => { e.preventDefault(); saveDialog(); });
  $('#evtCancel').addEventListener('click', closeDialog);
  $('#evtDelete').addEventListener('click', deleteEvent);

  // Refresh
  $('#refreshBtn').addEventListener('click', () => { loadPrice(); loadLaunches(); });

  // View toggle
  document.querySelectorAll('#viewTabs button').forEach((b) =>
    b.addEventListener('click', () => switchView(b.dataset.view)));
  switchView(localStorage.getItem('spcx.view') || 'list');

  // Clear cache & reload
  $('#clearCacheBtn').addEventListener('click', () => {
    if (confirm('Clear cached data and reload the app?')) clearCacheReload();
  });

  // Initial render
  renderEvents('calls');
  renderEvents('lockups');
  loadPrice();
  loadLaunches();

  // Refresh price when app regains focus
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadPrice(); });

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
