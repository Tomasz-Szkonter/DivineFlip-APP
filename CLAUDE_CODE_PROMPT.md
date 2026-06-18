# DivineFlip — build brief for Claude Code

Paste everything below the line into Claude Code (with this folder open as the workspace).

---

You are building **DivineFlip**, a web app that detects **triangular arbitrage** in the *Path of Exile 2* in-game Currency Exchange across **Exalted ↔ item ↔ Divine**. There is already a working single-file prototype at `index.html` in this folder — read it first; it contains the correct arbitrage math, the ranking logic, the parser, and the dark theme. Port that logic; don't reinvent it. We are converting it to **Vite + React** and solving the data/CORS problem properly.

## Background you must respect (already researched — don't re-litigate)

- **The edge:** the Currency Exchange runs an independent order book per pair, so an item has one rate vs Exalted and a separate rate vs Divine. When they drift apart you profit by looping. Worked example (must compute to +3.3%): `1 Divine = 198 ex`, `1 Omen of Light = 1380 ex`, `1 Omen = 7.2 div`. Loop **Ex → buy Omen → sell for Divine → convert to Ex** = `7.2 × 198 − 1380 = +45.6 ex (+3.30%)`. The reverse loop loses — direction matters.
- **Why normalized prices hide it:** if a feed gives one base price per item, then `item_in_div = item_in_ex ÷ div_in_ex` is internally consistent → 0%. Real edges need **independently-observed per-pair rates**. poe2scout's currency *exchange snapshot* (`get_exchange_snapshot` / `get_snapshot_pairs`) is where per-pair `relative_price` lives; the plain currency list is normalized. Wire the snapshot/pairs data for true arbitrage; fall back to implied (≈0%) + liquidity ranking when a per-pair divine quote isn't available.
- **CORS is the whole problem.** `poe2scout.com` sends **no `Access-Control-Allow-Origin`** header, so a browser call from any web origin fails. Confirmed from console. Public proxies (allorigins, corsproxy.io) are unreliable / 403. So all browser data must come from **our own same-origin JSON** or **our own CORS-enabled proxy**.
- **Gold fee:** GGG never published the formula; it scales with units traded and item rarity. Model it as a tunable `goldPerUnit` (default 350) that the user can **calibrate from a real trade** (`goldPerUnit = totalGold / units`).
- **Current league:** "Return of the Ancients" (Runes of Aldur mechanic). Don't hardcode — read it from `/leagues`.

## STEP 0 — verify the real poe2scout API FIRST (you have no CORS here)

Before writing app code, hit the API from Node/curl and record the real shapes:

```bash
curl -s "https://poe2scout.com/api/leagues" | head -c 2000
curl -s "https://poe2scout.com/api/items/currency?page=1&perPage=10" | head -c 2000   # try variants
# also probe the currency exchange snapshot / pairs endpoints:
curl -s "https://poe2scout.com/api/currencyExchangeSnapshot?league=..." | head -c 2000
curl -s "https://poe2scout.com/api/currencyExchange/pairs?league=..." | head -c 2000
```

Find: (a) the league object field giving **divine price in exalted** (e.g. `divinePrice`); (b) the endpoint(s) returning currency items with their **exalted price**, **volume**, and **category**; (c) whether any endpoint returns **per-pair divine rates** (the real arbitrage signal). Write the confirmed endpoints + field names into `shared/poe2scout.mjs` and a short `API_NOTES.md`. Everything downstream depends on this — do it before building UI.

## Architecture (decided — implement exactly this)

Two data paths, **both producing the same normalized JSON**, so the React app is source-agnostic:

1. **Baseline snapshot (default, free, no CORS):** a GitHub Action runs every 30 min, executes `scripts/fetch-data.mjs` (Node, no CORS), writes `public/data/snapshot.json`, commits it. The deployed page reads `./data/snapshot.json` **same-origin** on load.
2. **"Live now" button (free, on-demand):** a Cloudflare Worker (`worker/`) fetches poe2scout server-side and returns the same normalized JSON **with `Access-Control-Allow-Origin: *`**. The app calls the Worker URL (configurable via `VITE_LIVE_URL` env + a settings field; if unset, the button is disabled with a tooltip explaining how to deploy it).

Share one module `shared/poe2scout.mjs` (`export async function fetchSnapshot({ apiBase, league, categories })` using global `fetch`) imported by **both** the Node script and the Worker, so logic never diverges.

### Normalized JSON schema (the only thing the UI consumes)
```json
{
  "league": "Return of the Ancients",
  "divinePrice": 198,
  "updated": "2026-06-18T12:00:00Z",
  "source": "github-action | worker | sample",
  "items": [
    { "name": "Omen of Light", "cat": "omens", "ex": 1380, "div": 7.2, "vol": 1234 }
  ]
}
```
`div` = the item's independent Divine-market price if available, else `null` (app computes implied = `ex / divinePrice`, which yields ~0% — that's expected and must be labelled "implied").

## Core math (port verbatim from index.html)

Unit of account = Exalted (E). `d` = ex per divine, `iE` = item's ex price, `pItemDiv` = item's div price, `iDx = pItemDiv * d`.
- `perUnit = |iDx − iE|`, `marginPct = perUnit / min(iE, iDx) * 100`
- `forward = iDx > iE` → loop **Ex→Item→Div→Ex**; else **Div→Item→Ex**
- `profitPerGold = perUnit / goldPerUnit`; `totalProfit = perUnit × unitsAffordableAtCapital`
Put this in `src/lib/arb.js` with unit tests (`vitest`) asserting the Omen example = 3.30% and forward=true.

## UI requirements (keep the look from index.html — modern dark, semantic colors)

- **Theme:** dark navy/near-black surfaces, rounded cards, mono font for numbers. Semantic colors: **cyan = Divine**, **amber = Exalted**, **green = profit**, **rose = loss**, **indigo/purple = actions & liquidity**.
- **Top ticker bar:** League, **1 Divine = X Exalted**, 1 Exalted = Y Divine, item count, last-updated, **Refresh** (reload snapshot) and **Live now** (Worker) buttons.
- **Hero module on top — "Best flips to hunt (live)"** with 4 ranking tabs: **Profit/gold**, **% margin**, **Total profit @ capital**, **Liquidity/safety** (`hunt = vol × ex`). Label implied rows.
- **Live flip calculator** (offline, source of truth): inputs for div rate, item-ex, item-div, units → margin %, direction, gross profit (ex + div), gold cost, profit/1k gold.
- **Settings:** capital (div/ex), gold model + calibration, league select, min margin/volume filters, category toggles, diagnostics panel (shows source, updated time, raw sample, manual JSON paste).
- Persist settings in `localStorage`.

## Files to create
```
package.json  vite.config.js  index.html  .gitignore  .nojekyll  README.md  API_NOTES.md
src/main.jsx  src/App.jsx  src/styles.css  src/lib/arb.js  src/lib/arb.test.js
shared/poe2scout.mjs
scripts/fetch-data.mjs
public/data/snapshot.json            (seed sample so the app renders before first Action run)
worker/worker.js  worker/wrangler.toml
.github/workflows/update-data.yml    (cron "*/30 * * * *" + workflow_dispatch; commits snapshot.json)
.github/workflows/deploy.yml         (build Vite + deploy to GitHub Pages on push to main + workflow_dispatch)
```
Vite: set `base: './'` so it works on a GitHub Pages project subpath; fetch data with a relative path. Add a seed `snapshot.json` (mark `"source":"sample"`) containing the Omen example so the page is never blank.

## Acceptance criteria
1. `npm install && npm run dev` runs; `npm run build` succeeds; `npm test` passes (Omen = 3.30%, forward=true).
2. `node scripts/fetch-data.mjs` produces a valid `public/data/snapshot.json` from the live API (run it to prove the endpoints work).
3. App loads snapshot **same-origin** with no console CORS errors; ticker shows the live 1 Div = X Ex.
4. "Live now" hits the Worker and refreshes without CORS errors (once `VITE_LIVE_URL` is set).
5. README documents: create public repo → enable Pages (GitHub Actions) → deploy Worker (`npm i -g wrangler`, `wrangler deploy`) → set `VITE_LIVE_URL`. Note: public repo = unlimited free Actions; scheduled runs can be delayed a few min.

Start with STEP 0, paste me the real API responses, then proceed.
