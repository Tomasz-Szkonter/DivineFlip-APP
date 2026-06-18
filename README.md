# DivineFlip — PoE2 Currency Exchange Arbitrage

Detects **triangular arbitrage** across the three base currencies of the *Path of Exile 2* in-game
Currency Exchange — **Exalted (EX) ↔ item ↔ Divine (DIV) ↔ Chaos (CHA)** — gold-fee aware.
Vite + React, deployable free to GitHub Pages.

## The edge

The Currency Exchange runs an **independent order book per pair**, so one item has a separate rate vs
**EX**, vs **DIV** and vs **CHA**. When they drift, you profit by **buying on the cheapest market and
selling on the richest**, then converting back:

> 1 Divine = 198 ex · 1 Omen of Light = 1380 ex · 1 Omen = 7.2 div
> Loop **Ex → buy Omen → sell for Divine → convert to Ex** = `7.2 × 198 − 1380 = +45.6 ex (+3.30%)`.
> DivineFlip compares all three markets and tells you the exact buy→sell route to run.

poe2scout's `SnapshotPairs` endpoint exposes those independent per-pair rates, so DivineFlip surfaces
**real** edges (not just normalized ~0% implied gaps). See [API_NOTES.md](API_NOTES.md) for the full,
verified data mapping. Rows without a real cross-market edge are labelled **`implied`**.

**Two-way liquidity (kills false positives).** A fat price gap is worthless if the market you'd sell
*into* has no stock — you could buy but never sell back. Each book also carries its **receive-side**
liquidity, so every flip is flagged **two-way ✓ / one-way ✗**, and the headline **Top Flips** only
shows genuinely two-sided, realistically-sized edges (the full table shows everything, badged). The
live in-game rate (in the calculator) is always the final source of truth.

## How the data gets to the browser (CORS is the whole problem)

`poe2scout.com` sends **no `Access-Control-Allow-Origin`** header, so a browser can't call it directly.
Two paths both produce the *same* normalized JSON, so the app is source-agnostic:

1. **Baseline snapshot (default, free, no CORS):** a GitHub Action runs `scripts/fetch-data.mjs`
   every 30 min and commits `public/data/snapshot.json`. The page loads it **same-origin**.
2. **"Live now" (on-demand):** a Cloudflare Worker (`worker/`) fetches poe2scout server-side and
   returns the same JSON with `Access-Control-Allow-Origin: *`. Configure via `VITE_LIVE_URL`
   (or the field in Settings). Unset → the button is disabled with a tooltip.

`shared/poe2scout.mjs` holds the one normalization function imported by **both** the Node script and
the Worker, so the logic never diverges.

### Normalized JSON the UI consumes

```jsonc
{ "league": "Runes of Aldur", "divinePrice": 200.4, "chaosPrice": 21.96,
  "epoch": 1781791200, "updated": "2026-06-18T12:00:00Z",
  "source": "github-action | worker | sample",
  "items": [ {
    "name": "Omen of Light", "cat": "ritual",
    "ex": 1183.6, "div": 6.92, "cha": 58.16,   // item price in EX / DIV / CHA (div/cha null if no book)
    "vol": 1993,                                // min VolumeTraded across the books the item has
    "vph": 540,                                 // trades/hour (snapshot deltas; committed pipeline only)
    "liq": { "ex": { "s": 182589, "v": 2489057 },   // per-book RECEIVE-side liquidity (sell-into side)
             "div": { "s": 9974430, "v": 87890 },   //   s = StockValue, v = VolumeTraded
             "cha": { "s": 737690, "v": 117875 } },
    "spark": [840, 737, 858, 1175, 1473, 1409, 1337]  // ~7-day daily EX price (PriceLogs), chronological
  } ] }
```
`div`/`cha` = the item's independent Divine/Chaos-market price, or `null` → no book on that market.
`chaosPrice` = ex per chaos (from the direct `chaos/exalted` book). `liq[cur]` is the counter-currency
("receive") side of each book, used for the two-way-liquidity guard. The schema is an additive superset —
older consumers that only read `ex`/`div`/`vol` keep working.

## Develop

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # vitest: Omen example = 3.30%, forward = true
npm run build          # -> dist/  (base './' so it works on a Pages subpath)
npm run fetch-data     # regenerate public/data/snapshot.json from the live API
```

`public/data/snapshot.json` ships as live data refreshed by `npm run fetch-data` / the Action.
`public/data/snapshot.sample.json` is a tiny deterministic seed (the Omen example); copy it over
`snapshot.json` if you ever want a fixed offline starting point.

## Gold fee model

GGG never published the formula (it scales with units traded and item rarity). It's a tunable
**gold per unit** (default `350`). Calibrate from a real trade in Settings →
`goldPerUnit = totalGold / units`.

## Deploy

### 1. GitHub Pages (the app + the 30-min snapshot)
1. Create a **public** repo (public = unlimited free Actions) and push this project.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push to `main` (or run the **Deploy to GitHub Pages** workflow). App goes live at
   `https://<user>.github.io/<repo>/`.
4. The **Update snapshot** workflow runs every 30 min (and on demand) committing fresh data.
   Scheduled runs on public repos can be delayed a few minutes.

### 2. Cloudflare Worker (the "Live now" button — optional)
```bash
npm i -g wrangler
cd worker
wrangler login
wrangler deploy        # prints https://divineflip-proxy.<you>.workers.dev
```
Then make the app use it, either:
- **Locally / per-browser:** paste the URL into Settings → *Live Worker URL*, or
- **Baked into the build:** set repo variable `VITE_LIVE_URL`
  (Settings → Secrets and variables → Actions → **Variables**) and redeploy. For local dev, copy
  `.env.example` to `.env` and set `VITE_LIVE_URL`.

## Project layout

```
index.html                     Vite entry (mounts src/main.jsx)
src/main.jsx  src/App.jsx       React app (ticker, hero ranking, calculator, settings, diagnostics)
src/styles.css                 dark theme (ported from the prototype)
src/lib/arb.js  arb.test.js    core arbitrage math + vitest tests
shared/poe2scout.mjs           normalization — shared by the Node script AND the Worker
scripts/fetch-data.mjs         Node fetch -> public/data/snapshot.json
worker/worker.js  wrangler.toml Cloudflare "Live now" proxy
public/data/snapshot.json      committed live snapshot (auto-refreshed)
public/data/snapshot.sample.json  deterministic seed (Omen example)
.github/workflows/             update-data.yml (cron) + deploy.yml (Pages)
prototype.html                 the original single-file prototype (kept for reference)
```

---
Not affiliated with or endorsed by Grinding Gear Games. Data courtesy of
[poe2scout](https://poe2scout.com).
