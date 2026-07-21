'use strict';
/* SPCX price chart: line + future event markers. Vanilla canvas, no libs. */
(function () {
  const DAY = 86400000;
  const COLORS = { price: '#eef2ff', earn: '#4f8cff', shares: '#f5a623', launch: '#26d07c', today: '#8892b8', ipo: '#5566aa' };
  const HIST_KEY = 'spcx.hist';
  const HIST_TTL = 6 * 3600 * 1000;

  let tf = localStorage.getItem('spcx.tf') || 'D';
  let histLoaded = false;

  const $ = (s) => document.querySelector(s);

  /* ---- Price history ---- */
  async function getHistory() {
    const cached = safeParse(localStorage.getItem(HIST_KEY));
    if (cached && Date.now() - cached.ts < HIST_TTL) return cached;

    // Try keyless daily history from Stooq (may be CORS-blocked; that's fine).
    try {
      const r = await fetch('https://stooq.com/q/d/l/?s=spcx.us&i=d');
      if (r.ok) {
        const text = await r.text();
        const rows = text.trim().split('\n').slice(1);
        const series = rows.map((line) => {
          const c = line.split(',');
          return { t: Date.parse(c[0]), v: +c[4] };
        }).filter((p) => p.t && p.v);
        if (series.length > 3) {
          const out = { ts: Date.now(), source: 'Stooq (daily close)', series };
          localStorage.setItem(HIST_KEY, JSON.stringify(out));
          return out;
        }
      }
    } catch (e) { /* fall through to synth */ }

    const out = { ts: Date.now(), source: 'Sample data (no live history)', series: synth() };
    localStorage.setItem(HIST_KEY, JSON.stringify(out));
    return out;
  }

  // Deterministic pseudo price walk from IPO day to today, ending near last quote.
  function synth() {
    const ipo = SPCXData().ipo;
    const start = Date.parse(ipo.date);
    const days = Math.max(2, Math.round((Date.now() - start) / DAY));
    const q = SPCXData().price();
    const end = (q && q.data && q.data.price) ? q.data.price : 123.99;
    const open = 150; // first-day open
    let seed = 20260612;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const nDays = Math.floor((Date.now() - start) / DAY); // floor: never overshoot "now"
    const series = [];
    for (let i = 0; i <= nDays; i++) {
      const base = open + (end - open) * (i / nDays);
      const noise = base * 0.03 * rnd() * (1 - i / nDays * 0.4);
      series.push({ t: start + i * DAY, v: Math.max(5, base + noise) });
    }
    series.push({ t: Date.now(), v: end }); // pin a point exactly at now
    return series;
  }

  function aggregate(series, mode) {
    if (mode === 'D') return series;
    const buckets = new Map();
    for (const p of series) {
      const d = new Date(p.t);
      let key;
      if (mode === 'M') key = d.getUTCFullYear() + '-' + d.getUTCMonth();
      else { const onejan = Date.UTC(d.getUTCFullYear(), 0, 1); key = d.getUTCFullYear() + '-w' + Math.floor((p.t - onejan) / (7 * DAY)); }
      buckets.set(key, p); // last point in bucket wins (sorted input)
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t);
  }

  /* ---- Events (future markers) ---- */
  function collectEvents() {
    const d = SPCXData();
    const ev = d.events();
    const out = [];
    ev.calls.forEach((c) => out.push({ t: Date.parse(c.date), cat: 'earn' }));
    ev.lockups.forEach((l) => out.push({ t: Date.parse(l.date), cat: 'shares' }));
    d.launches().forEach((x) => { const t = Date.parse(x.net); if (t) out.push({ t, cat: 'launch' }); });
    return out.filter((e) => e.t);
  }

  function SPCXData() { return window.SPCXData; }
  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
  const money = (n) => '$' + n.toFixed(n < 100 ? 2 : 1);

  /* ---- Draw ---- */
  async function render() {
    if (!window.SPCXData) return;
    const canvas = $('#priceChart');
    if (!canvas || canvas.offsetParent === null) return; // hidden

    const hist = await getHistory();
    histLoaded = true;
    const series = aggregate(hist.series.slice().sort((a, b) => a.t - b.t), tf);
    draw(canvas, series, hist.source);
    updateHeader(series);
    $('#chartNote').textContent = hist.source + ' · markers = scheduled events (see other tab). Future dates are estimates.';
  }

  function updateHeader(series) {
    const q = SPCXData().price();
    const price = (q && q.data) ? q.data.price : (series.length ? series[series.length - 1].v : null);
    $('#chartPrice').textContent = price != null ? money(price) : '—';
    const chg = $('#chartChange');
    if (q && q.data && q.data.change != null) {
      const up = q.data.change >= 0;
      chg.textContent = `${up ? '+' : ''}${q.data.change.toFixed(2)} (${up ? '+' : ''}${(q.data.pct ?? 0).toFixed(2)}%)`;
      chg.className = 'price-change ' + (up ? 'up' : 'down');
    } else {
      chg.textContent = 'SPCX · NASDAQ';
      chg.className = 'price-change';
    }
  }

  function draw(canvas, series, source) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 340;
    const cssH = 300;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padL = 46, padR = 12, padT = 14, padB = 26;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;

    const now = Date.now();
    const ipoT = Date.parse(SPCXData().ipo.date);
    const events = collectEvents();

    // time window — each timeframe frames a sensible past + future horizon so
    // the price line stays readable and the right amount of future is shown.
    // Ignore far-future TBD launch placeholders (e.g. "Dec 31") when sizing.
    const rangeEvents = events.filter((e) => !(e.cat === 'launch' && e.t > now + 550 * DAY));
    const lastEvent = Math.max(now, ...rangeEvents.map((e) => e.t));
    let t0, t1;
    if (tf === 'D') {          // near-term: ~6wks back, ~2mo ahead
      t0 = Math.max(ipoT, now - 45 * DAY);
      t1 = now + 60 * DAY;
    } else if (tf === 'W') {    // medium: since IPO, ~7mo ahead (all 2026 events)
      t0 = ipoT;
      t1 = now + 220 * DAY;
    } else {                   // M — full picture: IPO → last event (Musk 2027)
      t0 = ipoT;
      t1 = lastEvent + (lastEvent - t0) * 0.04;
    }

    const vis = series.filter((p) => p.t >= t0 && p.t <= now);
    const pool = vis.length ? vis : series.slice(-2);
    let lo = Math.min(SPCXData().ipo.price, ...pool.map((p) => p.v));
    let hi = Math.max(SPCXData().ipo.price, ...pool.map((p) => p.v));
    const pad = (hi - lo) * 0.08 || 5; lo -= pad; hi += pad;

    const X = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * plotH;

    // future shading
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(X(now), padT, X(t1) - X(now), plotH);

    // horizontal grid + y labels
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = lo + (hi - lo) * (i / steps);
      const y = Y(v);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
      ctx.fillStyle = '#8892b8'; ctx.textAlign = 'right';
      ctx.fillText(money(v), padL - 6, y);
    }

    // month x labels — thinned so they never overlap on long ranges
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d0 = new Date(t0);
    const totalMonths = (new Date(t1).getUTCFullYear() * 12 + new Date(t1).getUTCMonth()) - (d0.getUTCFullYear() * 12 + d0.getUTCMonth());
    const step = Math.max(1, Math.ceil(totalMonths / 6));
    let idx = 0;
    for (let t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1); t < t1; ) {
      const x = X(t);
      const show = (idx % step === 0);
      if (show && x > padL && x < cssW - padR) {
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
        const dd = new Date(t);
        ctx.fillStyle = '#66708f';
        ctx.fillText(MON[dd.getUTCMonth()] + (dd.getUTCMonth() === 0 || totalMonths > 11 ? " '" + String(dd.getUTCFullYear()).slice(2) : ''), x, padT + plotH + 6);
      }
      const dd = new Date(t); t = Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth() + 1, 1); idx++;
    }

    // IPO reference line
    if (SPCXData().ipo.price >= lo && SPCXData().ipo.price <= hi) {
      const y = Y(SPCXData().ipo.price);
      ctx.strokeStyle = COLORS.ipo; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.ipo; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('IPO $135', padL + 2, y - 2);
    }

    // event vertical lines + top triangles (offset triangles per category so
    // same-date events of different categories both stay visible)
    const OFF = { earn: -5, shares: 0, launch: 5 };
    events.filter((e) => e.t >= t0 && e.t <= t1).forEach((e) => {
      const x = X(e.t);
      ctx.strokeStyle = COLORS[e.cat]; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, padT + 8); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.globalAlpha = 1;
      const tx = x + (OFF[e.cat] || 0);
      ctx.fillStyle = COLORS[e.cat];
      ctx.beginPath(); ctx.moveTo(tx, padT); ctx.lineTo(tx - 4, padT + 8); ctx.lineTo(tx + 4, padT + 8); ctx.closePath(); ctx.fill();
    });

    // today divider
    const xNow = X(now);
    ctx.strokeStyle = COLORS.today; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xNow, padT); ctx.lineTo(xNow, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);

    // price line + fill (past only)
    if (vis.length > 1) {
      ctx.beginPath();
      vis.forEach((p, i) => { const x = X(p.t), y = Y(p.v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, 'rgba(79,140,255,0.25)'); grad.addColorStop(1, 'rgba(79,140,255,0)');
      ctx.lineTo(X(vis[vis.length - 1].t), padT + plotH);
      ctx.lineTo(X(vis[0].t), padT + plotH); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();

      ctx.beginPath();
      vis.forEach((p, i) => { const x = X(p.t), y = Y(p.v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = COLORS.price; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

      // current dot
      const last = vis[vis.length - 1];
      ctx.fillStyle = COLORS.price;
      ctx.beginPath(); ctx.arc(X(last.t), Y(last.v), 3.5, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = '#66708f'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No price history for this range', padL + plotW / 2, padT + plotH / 2);
    }
  }

  /* ---- wire up ---- */
  function initTf() {
    document.querySelectorAll('#tfGroup button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tf === tf);
      b.addEventListener('click', () => {
        tf = b.dataset.tf;
        localStorage.setItem('spcx.tf', tf);
        document.querySelectorAll('#tfGroup button').forEach((x) => x.classList.toggle('active', x === b));
        render();
      });
    });
  }

  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(render, 150); });

  window.SPCXChart = { render };
  document.addEventListener('DOMContentLoaded', initTf);
})();
