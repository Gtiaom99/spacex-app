'use strict';
/* SPCX price chart: line + future event markers. Vanilla canvas, no libs.
   Default window spans from the IPO date onward; the time axis is zoomable
   (wheel / pinch) and pannable (drag), with double-click / double-tap reset. */
(function () {
  const DAY = 86400000;
  const MIN_SPAN = 14 * DAY;   // closest zoom-in
  const COLORS = { price: '#eef2ff', earn: '#4f8cff', shares: '#f5a623', launch: '#26d07c', today: '#8892b8', ipo: '#5566aa' };
  const HIST_KEY = 'spcx.hist';
  const HIST_TTL = 6 * 3600 * 1000;

  let tf = localStorage.getItem('spcx.tf') || 'D';
  let histLoaded = false;

  // Time-axis viewport state.
  let view = null;                 // { t0, t1 } currently shown; null = show full extent
  let bounds = { t0: 0, t1: 0 };   // full extent [IPO, last event]
  let metrics = null;              // { padL, plotW, t0, t1 } from last draw, for pixel<->time
  let wired = false;               // interaction handlers attached once

  const $ = (s) => document.querySelector(s);

  /* ---- Price history ----
     Priority: Alpha Vantage (real daily closes, needs a free key) →
     Stooq daily CSV (keyless, often CORS-blocked) → deterministic sample walk. */
  const SYMBOL = 'SPCX';

  async function getHistory() {
    const cached = safeParse(localStorage.getItem(HIST_KEY));
    if (cached && Date.now() - cached.ts < HIST_TTL) return cached;

    // 1) Alpha Vantage — real daily OHLC (free key, allows browser CORS).
    //    This is the preferred, fully-real source.
    const avKey = localStorage.getItem('spcx.avKey');
    if (avKey) {
      try {
        const series = await fetchAlphaVantage(avKey);
        return cache({ source: 'Alpha Vantage (daily close)', series });
      } catch (e) {
        // AV unavailable (usually a free-tier rate-limit). Keep showing the last
        // good AV chart rather than dropping to the modeled line.
        if (cached && /Alpha Vantage/.test(cached.source || '')) {
          cached.ts = Date.now(); // extend so we don't hammer the rate limit
          localStorage.setItem(HIST_KEY, JSON.stringify(cached));
          return cached;
        }
      }
    }

    // 2) Real anchors (IPO price + recorded daily + today's live quote) with the
    //    IPO->present gap filled by a smooth modeled curve, so the chart reads
    //    like an online chart yet honors every real price we have. As real daily
    //    points accumulate, the modeled filler shrinks and the recent line is real.
    const filled = buildFilledSeries();
    if (filled.length >= 2) return cache({ source: 'Modeled since IPO · real daily updates', series: filled });

    // 3) Stooq keyless daily history (may be CORS-blocked; that's fine).
    try {
      const r = await fetch('https://stooq.com/q/d/l/?s=spcx.us&i=d');
      if (r.ok) {
        const text = await r.text();
        const rows = text.trim().split('\n').slice(1);
        const series = rows.map((line) => {
          const c = line.split(',');
          return { t: Date.parse(c[0]), v: +c[4] };
        }).filter((p) => p.t && p.v);
        if (series.length > 3) return cache({ source: 'Stooq (daily close)', series });
      }
    } catch (e) { /* fall through to synth */ }

    // 4) No real source available — deterministic placeholder walk.
    return cache({ source: 'Sample data (no live history)', series: synth() });
  }

  // Combine the recorded daily series with the current live quote so the chart
  // has real points (IPO anchor + today at minimum) without any history API.
  function buildRecordedSeries() {
    const stored = safeParse(localStorage.getItem('spcx.realHist'));
    const series = (stored && Array.isArray(stored.series)) ? stored.series.slice()
      : [{ t: Date.parse(SPCXData().ipo.date), v: SPCXData().ipo.price }];
    const q = SPCXData().price && SPCXData().price();
    if (q && q.data && q.data.price != null) {
      const today = Math.floor(Date.now() / DAY) * DAY;
      const i = series.findIndex((p) => p.t === today);
      if (i >= 0) series[i] = { t: today, v: q.data.price };
      else series.push({ t: today, v: q.data.price });
    }
    return series.filter((p) => p.t && p.v != null).sort((a, b) => a.t - b.t);
  }

  // Take the real anchor points and fill any multi-day gap between consecutive
  // anchors with a deterministic Brownian-bridge walk (pinned to 0 at both ends),
  // so the line looks organic but always passes exactly through the real prices.
  function buildFilledSeries() {
    const anchors = buildRecordedSeries();
    if (anchors.length < 2) return synth(); // no real endpoints yet — plain walk
    const out = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i], b = anchors[i + 1];
      out.push(a);
      const gap = Math.round((b.t - a.t) / DAY);
      if (gap <= 1) continue; // consecutive real days — nothing to fill

      // deterministic RNG seeded from the segment start (stable across renders)
      let seed = Math.floor(a.t / DAY) & 0x7fffffff;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
      const amp = Math.max(1.5, ((a.v + b.v) / 2) * 0.035); // daily wiggle size

      const W = [0];                       // random walk W[0..gap]
      for (let s = 1; s <= gap; s++) W.push(W[s - 1] + rnd() * amp);
      for (let s = 1; s < gap; s++) {      // interior days only
        const frac = s / gap;
        const base = a.v + (b.v - a.v) * frac;      // linear trend a -> b
        const bridge = W[s] - frac * W[gap];        // 0 at both endpoints
        out.push({ t: a.t + s * DAY, v: Math.max(1, base + bridge) });
      }
    }
    out.push(anchors[anchors.length - 1]);
    return out;
  }

  function cache(out) {
    out.ts = Date.now();
    localStorage.setItem(HIST_KEY, JSON.stringify(out));
    return out;
  }

  async function fetchAlphaVantage(key) {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${SYMBOL}` +
                `&outputsize=compact&apikey=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('alphavantage ' + r.status);
    const j = await r.json();
    const ts = j['Time Series (Daily)'];
    // AV returns Note/Information on rate-limit, Error Message on bad symbol/key.
    if (!ts) throw new Error(j.Note || j.Information || j['Error Message'] || 'alphavantage no data');
    const series = Object.entries(ts)
      .map(([d, o]) => ({ t: Date.parse(d), v: +o['4. close'] }))
      .filter((p) => p.t && p.v)
      .sort((a, b) => a.t - b.t);
    if (series.length < 2) throw new Error('alphavantage empty');
    return series;
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

  /* ---- Viewport helpers ---- */
  // Keep a viewport inside the full extent, honoring the min-zoom span.
  function clampView(t0, t1) {
    const fullSpan = bounds.t1 - bounds.t0;
    let span = Math.min(fullSpan, Math.max(MIN_SPAN, t1 - t0));
    t1 = t0 + span;
    if (t0 < bounds.t0) { t0 = bounds.t0; t1 = t0 + span; }
    if (t1 > bounds.t1) { t1 = bounds.t1; t0 = t1 - span; }
    if (t0 < bounds.t0) t0 = bounds.t0; // span == fullSpan
    return { t0, t1 };
  }

  /* ---- Draw ---- */
  async function render() {
    if (!window.SPCXData) return;
    const canvas = $('#priceChart');
    if (!canvas || canvas.offsetParent === null) return; // hidden

    const hist = await getHistory();
    histLoaded = true;
    const series = aggregate(hist.series.slice().sort((a, b) => a.t - b.t), tf);

    // Full extent: IPO -> last scheduled event (ignore far-future TBD launch
    // placeholders when sizing the horizon).
    const now = Date.now();
    const ipoT = Date.parse(SPCXData().ipo.date);
    const events = collectEvents();
    const rangeEvents = events.filter((e) => !(e.cat === 'launch' && e.t > now + 550 * DAY));
    const lastEvent = Math.max(now, ...rangeEvents.map((e) => e.t));
    bounds = { t0: ipoT, t1: lastEvent + (lastEvent - ipoT) * 0.04 };

    // Default viewport = full extent (starts at IPO). Re-clamp if data shifted.
    view = view ? clampView(view.t0, view.t1) : { t0: bounds.t0, t1: bounds.t1 };

    draw(canvas, series, events, now, view.t0, view.t1);
    updateHeader(series);
    wireInteractions(canvas);
    const hint = 'scroll / pinch to zoom · drag to pan · double-click to reset';
    $('#chartNote').textContent = hist.source + ' · ' + hint;
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

  function draw(canvas, series, events, now, t0, t1) {
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

    metrics = { padL, plotW, t0, t1 }; // for pixel<->time in interaction handlers

    // Price points visible in this window (past only — no future prices).
    const vis = series.filter((p) => p.t >= t0 && p.t <= Math.min(now, t1));
    const pool = vis.length ? vis : series.filter((p) => p.t <= now).slice(-2);
    let lo = Math.min(SPCXData().ipo.price, ...pool.map((p) => p.v));
    let hi = Math.max(SPCXData().ipo.price, ...pool.map((p) => p.v));
    if (!isFinite(lo) || !isFinite(hi)) { lo = SPCXData().ipo.price * 0.8; hi = SPCXData().ipo.price * 1.2; }
    const pad = (hi - lo) * 0.08 || 5; lo -= pad; hi += pad;

    const X = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * plotH;

    // future shading (only if "now" falls inside the window)
    if (now > t0 && now < t1) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(X(now), padT, X(t1) - X(now), plotH);
    }

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
      ctx.fillText('IPO ' + money(SPCXData().ipo.price), padL + 2, y - 2);
    }

    // clip event/price drawing to the plot so zoomed-out markers never spill
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip();

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
    if (now > t0 && now < t1) {
      const xNow = X(now);
      ctx.strokeStyle = COLORS.today; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xNow, padT); ctx.lineTo(xNow, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
    }

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
    }
    ctx.restore();

    if (vis.length <= 1) {
      ctx.fillStyle = '#66708f'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No price history for this range', padL + plotW / 2, padT + plotH / 2);
    }
  }

  /* ---- Zoom / pan interaction ---- */
  function timeAtX(clientX, canvas) {
    if (!metrics) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const frac = (x - metrics.padL) / metrics.plotW;
    return metrics.t0 + frac * (metrics.t1 - metrics.t0);
  }

  function zoomAround(anchorT, factor, canvas) {
    if (!view) return;
    const span = view.t1 - view.t0;
    const fullSpan = bounds.t1 - bounds.t0;
    const newSpan = Math.min(fullSpan, Math.max(MIN_SPAN, span * factor));
    const rel = span ? (anchorT - view.t0) / span : 0.5;
    view = clampView(anchorT - rel * newSpan, anchorT - rel * newSpan + newSpan);
    redraw(canvas);
  }

  function panByPixels(dxPx, canvas) {
    if (!view || !metrics) return;
    const dt = -(dxPx / metrics.plotW) * (view.t1 - view.t0);
    view = clampView(view.t0 + dt, view.t1 + dt);
    redraw(canvas);
  }

  // Redraw synchronously from current state (no refetch) for smooth interaction.
  function redraw(canvas) {
    const hist = safeParse(localStorage.getItem(HIST_KEY));
    if (!hist) { render(); return; }
    const series = aggregate(hist.series.slice().sort((a, b) => a.t - b.t), tf);
    draw(canvas, series, collectEvents(), Date.now(), view.t0, view.t1);
  }

  function wireInteractions(canvas) {
    if (wired) return;
    wired = true;
    canvas.style.touchAction = 'none'; // we handle pan/zoom ourselves
    canvas.style.cursor = 'grab';

    // Wheel / trackpad zoom, anchored at the cursor.
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const anchor = timeAtX(e.clientX, canvas);
      if (anchor == null) return;
      zoomAround(anchor, e.deltaY > 0 ? 1.15 : 1 / 1.15, canvas);
    }, { passive: false });

    // Pointer-based drag pan + two-finger pinch zoom.
    const pts = new Map();
    let lastX = 0, pinchDist = 0, pinchMid = 0;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, e.clientX);
      lastX = e.clientX;
      canvas.style.cursor = 'grabbing';
      if (pts.size === 2) {
        const xs = [...pts.values()];
        pinchDist = Math.abs(xs[0] - xs[1]);
        pinchMid = (xs[0] + xs[1]) / 2;
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, e.clientX);
      if (pts.size === 2) {
        const xs = [...pts.values()];
        const dist = Math.abs(xs[0] - xs[1]) || 1;
        const mid = (xs[0] + xs[1]) / 2;
        if (pinchDist) {
          const anchor = timeAtX(pinchMid, canvas);
          if (anchor != null) zoomAround(anchor, pinchDist / dist, canvas);
        }
        pinchDist = dist; pinchMid = mid;
      } else if (pts.size === 1) {
        panByPixels(e.clientX - lastX, canvas);
        lastX = e.clientX;
      }
    });

    const release = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinchDist = 0;
      if (pts.size === 0) canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    // Double-click / double-tap resets to the full IPO->future window.
    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      view = { t0: bounds.t0, t1: bounds.t1 };
      redraw(canvas);
    });
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
