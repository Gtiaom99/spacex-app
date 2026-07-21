# SPCX Tracker (PWA)

A phone-optimized web app for **SpaceX (NASDAQ: SPCX)**. Two views, toggled at the top:

**📅 Dates view**
- 📈 **Live stock price** (SPCX) — current, day change, vs. IPO price ($135)
- 🚀 **Starship launches & attempts** — live from The Space Devs API, with a T‑minus countdown
- 📞 **Investor / earnings calls** — editable list
- 🔓 **Shares freed to market** — staggered IPO lock‑up expirations, editable

**📈 Chart view**
- SPCX price line with **D / W / M** timeframes
- Timeline extends **into the future**, with colored vertical markers for each
  category: **blue** = earnings calls, **amber** = shares freed, **green** = launches
- Dashed **IPO $135** reference line and a **Today** divider separating actual price
  from the upcoming‑events zone

**Settings** has a **🧹 Clear cache & reload** button that wipes the service‑worker
cache and cached data, forcing a fresh download of the latest code and data.

Installs to your Android home screen and runs full‑screen like a native app.

---

## 1. Get a free stock API key (2 min)

Live quotes use **Finnhub** (free tier, no card):

1. Go to https://finnhub.io → sign up → copy your API key.
2. Open the app → **Settings** → paste the key → **Save key**.

Without a key it tries a keyless end‑of‑day source (Stooq), but that is often
blocked by browsers — the Finnhub key is the reliable path.

## 2. Put it on your phone

A PWA needs to be served over **HTTPS** (or localhost) for install + offline to work.
Pick one:

### Option A — Netlify Drop (easiest, free, no account needed to try)
1. Go to https://app.netlify.com/drop
2. Drag the whole `spacex-app` folder onto the page.
3. It gives you an `https://…netlify.app` URL. Open it on your phone.

### Option B — GitHub Pages
1. Push this folder to a GitHub repo.
2. Repo → Settings → Pages → deploy from branch → `/root`.
3. Open the `https://<you>.github.io/<repo>/` URL on your phone.

### Option C — Same Wi‑Fi as your PC (quick local test)
```
cd "D:\Claude projects\spacex-app"
python -m http.server 5178
```
On your phone (same Wi‑Fi) open `http://<your-PC-IP>:5178`.
Note: install/offline needs HTTPS, so this is for a quick look only.

## 3. Install to home screen (Android / Chrome)

1. Open the HTTPS URL in Chrome.
2. Tap the **⋮** menu → **Add to Home screen** (or the install prompt).
3. Launch it from your home screen — runs full‑screen, works offline for the
   shell, and refreshes data when you open it.

---

## Notes on the data

- **Price**: Finnhub `SPCX` quote. Delayed depending on Finnhub's free tier.
- **Launches**: The Space Devs "Launch Library 2" (filtered to Starship), cached
  ~25 min because the free API is rate‑limited.
- **Investor calls & lock‑ups**: No clean free API, so these are **seeded from
  public reporting and editable** (tap ✎). Researched values:
  - **Q2 2026 earnings** — Aug 4, 2026, audio webcast 3:30pm CT (first as a public co.)
  - **Q3 2026 earnings** — ~early Nov 2026 (estimated)
  - **Lock‑up is staggered**, not one cliff: ~20% after Q2 earnings (Aug 4; +~10%
    early if SPCX trades >$175.50 on 5 of 10 days), ~7% time‑based tranches
    (Sep/Oct), ~28% after Q3 earnings (~1.3B shares), full 180‑day expiry
    **Dec 8, 2026**, and **Elon Musk's ~6.4B shares unlock June 12, 2027**.
  - Sources: SpaceX IR, Benzinga, and IPO lock‑up trackers. These are best‑available
    public estimates — confirm against SpaceX's SEC filings (S‑1 / prospectus) and
    official IR announcements before trading on them.
- Not investment advice.

## Files
```
index.html      UI (Dates + Chart views)
styles.css      styling (dark space theme)
app.js          data fetching, view toggle, events, clear-cache
chart.js        canvas price chart + future event markers
manifest.json   PWA manifest
sw.js           service worker (network-first, offline shell)
icon.svg / icon-192.png / icon-512.png   app icons
```
