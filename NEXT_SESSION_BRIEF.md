# DivineFlip — Multi-currency + data-quality pass (next-session brief)

> Paste-ready prompt is in the **"PROMPT"** block at the very bottom. Everything above is the spec it refers to.
> All API facts below were **probed live on 2026-06-18** against poe2scout (numbers will have drifted; the *shapes* are stable).

## Why this pass

The app is live and now has: a **TOP FLIPS** card section, a searchable/sortable/expandable **"Best flips to hunt"** table, a **"How to read a flip"** slideout, and a working **Cloudflare Worker** for live data. This pass is about **meaning + UX + breadth**:

1. **UX bug** — clicking a TOP FLIPS card visually expands the *whole row* of cards, not just the one clicked.
2. **Add Chaos Orb (CHA)** as a third main currency alongside Exalted (EX) and Divine (DIV); operate on the **DIV/EX, DIV/CHA, EX/CHA** pairs (cf. https://poe2scout.com/poe2/runes/exchange).
3. **Kill false-positive flips** like Verisium (8,178% "margin" you can't actually trade) by checking the book is **tradeable both ways**.
4. **Make "Live now" permanently on** (the repo variable is already set).
5. **Scope volume/h and price-history graphs** against what the API actually provides (findings below — both are partially possible).

Reuse the existing pipeline, worker, deploy, theme, calculator. Extend `arb.js` + its tests rather than rewriting.

---

## Current state (so you don't re-derive it)

- **Live:** https://tomasz-szkonter.github.io/DivineFlip-APP/ · repo `DivineFlip-APP` · data refreshed every 30 min by `.github/workflows/update-data.yml`; deployed on push to `main` by `deploy.yml`.
- **Stack:** Vite 5 + React 18, single `src/App.jsx` (no router). Tests: vitest (`npm test`). Build: `npm run build`. `base: './'`.
- **Live Worker (deployed this session):** `https://divineflip-proxy.divineflipapp.workers.dev` — returns the same normalized JSON with `Access-Control-Allow-Origin: *`. Repo variable **`VITE_LIVE_URL` is set** to that URL, and a gitignored local `.env` mirrors it. `worker/worker.js` just calls `shared/poe2scout.mjs`.
- **Data the UI consumes** — `public/data/snapshot.json`, loaded same-origin (committed) or live (worker):
  ```json
  { "league":"Runes of Aldur", "divinePrice":200.4, "updated":"...", "source":"github-action|worker",
    "items":[ { "name":"Chaos Orb", "cat":"currency", "ex":20.43, "div":0.1146, "vol":91318 } ] }
  ```
  `ex` = item price in Exalted, `div` = item price in Divine (`null` ⇒ no independent divine book ⇒ "implied", ~0%), `vol` = `min(VolumeTraded)` of the two books, `divinePrice` = exalted per divine.

### `src/lib/arb.js` (current API — keep working)
- `analyze(d, iE, pItemDiv, units, goldPerUnit)` → `{ iE, iDx=pItemDiv*d, perUnit, marginPct, forward, grossTotal, goldTotal, profitPerGold, ... }`. `forward=true` ⇒ loop **Ex→Item→Div→Ex**. **Used by the calculator — do not break.**
- `scoreOf(marginPct, vol)` = `marginPct * Math.log10(1+vol)` (exported, tunable).
- `buildOpportunities(rows, d, {minVol, goldPerUnit, capInEx})` → per-item opps with: `marginPct, forward, perUnit, ppg, totalProfit, units, hasRealDiv, hunt=vol*ex, vol, ex, div, score, realisticTotal=perUnit*vol`.
- `rankOpportunities(opps, sortKey, {minMargin, limit, dir})` → `SORTERS` map: `score|margin|perUnit|ppg|total|vol|liq`; `liq` ignores the margin filter; `dir` 'desc'|'asc'.
- `topFlips(opps, {minVol, n})` → thin wrapper: `hasRealDiv && vol>=minVol && marginPct>0`, sorted by score.

### `src/App.jsx` (current UI)
- **TOP FLIPS cards** (top 5 by score, real edges only, global headline). State `openFlip` (keyed by name) expands a card to a shared **`FlipDetail`** (full breakdown + plain-English "what these numbers mean"). Clicking a card toggles expand; "Send to calculator" + "How to read this →" buttons inside.
- **"Best flips to hunt"** table — controls bar (search, direction `all|fwd|rev`, **Smart score**/**Liquidity** sort pills, min-margin + min-volume range sliders, "show implied" toggle, category chips). Sortable headers (Margin%→`margin`, Profit/flip→`perUnit`, Volume→`vol`) via `sortBy()` toggling `sortDir`. Rows expand (`openRow`) into the same `FlipDetail`.
- **`GuideDrawer`** — right-side slideout, static Omen-of-Light worked example + "example data" disclaimer. Opened from the TOP FLIPS header button and each `FlipDetail`.
- **Settings** persisted in `localStorage` (`LS='divineflip.react.v1'`) via `DEFAULTS`: `minVol:'50', sortKey:'score', sortDir:'desc', search:'', direction:'all', showImplied:false`, plus calculator/capital/gold/league/liveUrl. `loadSettings()` migrates legacy `ppg→score` and `minVol '0'→'50'`.
- Helpers to reuse: `num`, `fmt`, `r6`, `pickRow(r)` (fills calculator), `setField`, `catActive`/`toggleCat`/`allCats`.
- **Theme** (`src/styles.css`): `--divine:#38bdf8` (cyan), `--exalted:#fbbf24` (amber), `--profit:#34d399` (green), `--loss:#fb7185` (rose), `--indigo`/`--purple` (actions/liquidity). New classes added: `.topflips/.flipcard/.fc-*`, `.controls/.sortpill/.slider`, `.fliptable/.chev/.volcell`, `.rowdetail/.rd-grid/.rd-actions`, `.plain/.plain-*`, `.drawer/.drawer-*/.guide-*`, themed `input[type=range]`.

---

## The work

### 1 · UX — expand only the clicked card (quick, do first)
**Problem:** `openFlip` is correctly keyed by name (only one card's *content* renders), but `.topflips` is a CSS grid with the default `align-items: stretch`, so every card in the expanded card's row stretches to the new tallest height → looks like the whole row opened.
**Fix:** add `align-items: start;` to `.topflips` (and/or `align-self: start;` on `.flipcard`). Then only the clicked card grows; its row-mates keep their natural height. Optionally cap the expanded panel height with internal scroll on small screens.
**Files:** `src/styles.css` (one rule). Verify by opening a card in a multi-card row.

### 2 · Add Chaos Orb (CHA) as a third main currency
**Confirmed feasible (probed):** league exposes `ChaosDivinePrice` (~8.86 chaos/div) and per-currency display text/icons; a direct **`chaos/exalted` book** gives ~**21.53 ex/chaos**; a `chaos/divine` book exists; **501 items have a chaos book** (vs 483 divine, 632 exalted). So CHA coverage is on par with DIV.

**Normalizer — `shared/poe2scout.mjs`:** also collect each item's **chaos-book price** (`cha`, item priced in chaos) and its chaos volume, and emit a top-level **`chaosPrice`** (ex per chaos, from the direct `chaos/exalted` book; fallback `divinePrice / ChaosDivinePrice`). New snapshot schema (additive — keep `ex`/`div`/`vol`):
```json
{ "divinePrice":194.5, "chaosPrice":21.5, "items":[ { "name":"...", "cat":"...",
  "ex":20.4, "div":0.114, "cha":0.95, "vol":91318, "liq": { /* see §3 */ } } ] }
```
Mirror the change in `scripts/fetch-data.mjs` output and `worker/worker.js` (no worker change needed — it reuses `shared/`).

**Math — `src/lib/arb.js`:** generalize from the 2-market (ex/div) comparison to **N markets** over `{ex, div, cha}`. For an item, its value-in-exalted via each book it has is `valEx=ex`, `valDiv=div*divinePrice`, `valCha=cha*chaosPrice`. The best loop = **buy on the cheapest market, sell on the richest**; emit `{buyCur, sellCur, perUnit, marginPct}` plus per-pair views (DIV/EX, DIV/CHA, EX/CHA) like poe2scout's exchange page. Keep `analyze()` for the calculator (ex/div) intact; add a new helper (e.g. `bestLoop(item, rates)`) rather than overloading it. Extend `topFlips`/`rankOpportunities` to rank across all currencies.

**UI — `src/App.jsx` + `styles.css`:** add a **`--chaos`** color (proposal: a bronze/olive `#d9a066` so it's distinct from amber-EX and green-profit; tunable — confirm with user). Direction filter/labels gain chaos routes (Buy Ex→Cha, Buy Cha→Div, …); action chips colored by the two currencies. Ticker shows **1 Chaos = X ex**. Abbreviations **EX / DIV / CHA** everywhere, color-coded. Optional: a chaos leg in the calculator (confirm with user).

### 3 · Kill false-positive one-way flips (the Verisium problem)
**Diagnosis (probed the actual `verisium/*` books):** two compounding causes —
- **Near-zero price:** `verisium/exalted` item price ≈ `0.00051876/1.757 ≈ 0.0003 ex` → rounds to `0 ex` → `perUnit/low` explodes to thousands of %.
- **One-sided book:** in `divine/verisium` the **divine side has `StockValue:0`, `HighestStock:0`, `VolumeTraded:4`** — i.e. you can buy verisium *with* divine (huge verisium stock) but there are ~no divines offered to sell *into*. The loop can't close. This is exactly "buy for a DIV but can't sell for a DIV."

**What the data supports:** every pair has `CurrencyOneData`/`CurrencyTwoData`, each with `RelativePrice, ValueTraded, VolumeTraded, StockValue, HighestStock`. The **receive-side** currency must have real stock + volume.

**Approach:**
- **Normalizer:** for each item leg, also record the **counter-currency side's** `StockValue`/`HighestStock`/`VolumeTraded` (not just the item side). Emit a `liq` block (or per-leg `*_recvStock`, `*_recvVol`).
- **arb.js:** a flip from market A→B is only "real" if the **B-side** has `StockValue>0` (or `HighestStock ≥ floor`) and `VolumeTraded ≥ floor`. Add guards: an **absolute price floor** (drop legs whose ex value `< ~0.05 ex` to avoid rounding artifacts) and an **absurd-margin guard** (margins above ~a configurable max are almost always one-way/illiquid — exclude from TOP FLIPS unless two-sided is confirmed).
- **UI:** show a "two-way liquidity ✓/✗" indicator; never let a one-way book reach TOP FLIPS.
- **Tests:** add a verisium-like fixture (tiny price + zero receive-side stock) and assert it's excluded from `topFlips` and flagged in `buildOpportunities`.
**Files:** `shared/poe2scout.mjs`, `src/lib/arb.js` (+`arb.test.js`), `src/App.jsx`.

### 4 · Make "Live now" permanently on
Repo variable `VITE_LIVE_URL` is set; the build bakes it in. Now: on mount, **if `effectiveLiveUrl` is set, fetch live first** (`source:'worker'`) and **fall back to the committed snapshot on any failure**. Keep the committed snapshot as instant first paint, then swap to live. Optional: auto-refresh every N minutes while the tab is open. Keep manual Refresh / Live-now buttons. Update the status banner copy. **Files:** `src/App.jsx` (initial-load effect, maybe an interval).

### 5 · volume/h (trades per hour) — feasibility + approach
**Findings:** `SnapshotPairs` only gives **cumulative `VolumeTraded`** per side; the accumulation window isn't documented. `ExchangeSnapshot` returns `{Epoch, Volume, MarketCap}` — an exact snapshot timestamp. There is **no direct per-hour field**.
**Recommended approach:** derive it from **deltas between consecutive snapshots** — carry the previous snapshot's per-item `VolumeTraded` + the `Epoch`, then `volume/h = ΔVolumeTraded / Δhours`. Our 30-min Action already runs; add a small "previous volumes" carry (sidecar or extra field). `PriceLogs.Quantity` is daily only (too coarse for /h). **Files:** `scripts/fetch-data.mjs` (+ snapshot schema), `shared/poe2scout.mjs`.

### 6 · Price-history graphs — feasibility + approach
**Findings:** `GET /Currencies/ByCategory?Category={cat}` returns **`PriceLogs`** = ~**7 daily points/item** (`{Price, Time, Quantity}`) of the *normalized* price (not the per-pair edge). `SnapshotHistory` exists but **422s without params** (discover them via `GET /api/openapi.json`).
**So:** a **7-day daily price sparkline per item is free** (just fetch `PriceLogs`, no storage). A per-pair **edge/margin** history or **hourly** granularity is **not** exposed → we'd accumulate our own time series.
**Storage tradeoff if self-gathering:** ~600 items × `{ex,div,cha,vol}` × hourly × 30 days is large to re-commit every 30 min. Mitigate: downsample to hourly, keep a rolling ~14–30 days, store a slim columnar `history.json` (or per-category files), or track only the top-N liquid items. **Recommendation:** ship the free 7-day `PriceLogs` sparkline first; defer self-gathered edge history unless the user wants it, then downsample + prune.

---

## Decisions to confirm with the user (next session)
- **CHA color** (proposal `#d9a066` bronze).
- Calculator: add a **chaos leg** or keep it ex/div only?
- volume/h: ship now (needs delta plumbing) or later?
- Graphs: free **7-day PriceLogs sparkline** now; self-gathered edge history later?
- Thresholds for §3 (receive-side `StockValue>0`, min volume, ex price floor, max sane margin).

## Confirmed API facts (probed 2026-06-18, live)
- Base `https://poe2scout.com/api`, realm `poe2`. No CORS header (hence the worker). OpenAPI at `/api/openapi.json`.
- **Leagues** → current = "Runes of Aldur"; `DivinePrice≈194.46` (ex/div), `ChaosDivinePrice≈8.86` (chaos/div); per-currency `*CurrencyText`/`*IconUrl` for EX/DIV/CHA.
- **SnapshotPairs** (~2352 pairs, one call): pair has `Volume, BaseCurrencyApiId, CurrencyOne/Two{ApiId,Text,CategoryApiId}, CurrencyOneData/TwoData`. Each `*Data` = `{ValueTraded, RelativePrice, StockValue, VolumeTraded, HighestStock}`. Rate `1 A = (A.RP/B.RP)·B`. Direct books: `divine/exalted`≈196.5, `chaos/exalted`≈21.53, `chaos/divine` exists. Items with books: **ex 632, div 483, chaos 501**.
- **ExchangeSnapshot** → `{Epoch, Volume, MarketCap, BaseCurrencyApiId}` (Epoch = unix snapshot time).
- **Currencies/ByCategory** → `Items[]` with `PriceLogs` (~7 daily `{Price,Time,Quantity}`), `CurrentPrice`, `CurrentQuantity`, `IconUrl`, `ItemMetadata`.
- **SnapshotHistory** → exists but needs query params (discover via openapi.json).

## Must not break
`analyze()` + the calculator; the existing opportunity fields; the 30-min Action + Pages deploy; the worker contract; the snapshot schema consumers; `npm test`.

## Files likely touched
`shared/poe2scout.mjs`, `scripts/fetch-data.mjs`, `src/lib/arb.js` + `arb.test.js`, `src/App.jsx`, `src/styles.css`, snapshot schema, `README.md`/`API_NOTES.md`. (`worker/worker.js` unchanged — reuses `shared/`.)

---

## PROMPT (paste this to start the next session)

```
Read NEXT_SESSION_BRIEF.md in this repo, then implement it. Scope:

1. UX fix: in the TOP FLIPS card grid, expanding one card stretches the whole row. Make only the
   clicked card grow (CSS grid align-items: start).
2. Add Chaos Orb (CHA) as a third main currency alongside Exalted (EX) and Divine (DIV). Use the
   abbreviations EX / DIV / CHA, each color-coded (add a --chaos var, propose bronze #d9a066).
   Operate on DIV/EX, DIV/CHA, EX/CHA like https://poe2scout.com/poe2/runes/exchange. The data IS
   available: chaos/exalted and chaos/divine books exist and 501 items have a chaos book — extend
   shared/poe2scout.mjs to capture `cha` + top-level `chaosPrice`, generalize arb.js to compare value
   across all three markets (buy cheapest, sell richest), keep analyze()/the calculator working.
3. Kill false-positive one-way flips (e.g. Verisium showing 8,178%): require the SELL-side currency
   to actually have stock + volume (per-pair StockValue/HighestStock/VolumeTraded), add an ex price
   floor and a sane max-margin guard, and surface a "two-way liquidity" indicator. Add a test.
4. Make "Live now" permanently on: VITE_LIVE_URL is set; on load fetch the live worker first with
   fallback to the committed snapshot.
5. volume/h and price graphs: see the brief's findings — derive volume/h from snapshot deltas (uses
   ExchangeSnapshot Epoch); ship a free 7-day price sparkline from poe2scout PriceLogs; defer
   self-gathered edge history. Confirm the open decisions with me before building those two.

Start by reading NEXT_SESSION_BRIEF.md, src/App.jsx, src/lib/arb.js, and shared/poe2scout.mjs, then
propose a plan. Reuse the pipeline/worker/deploy/theme; extend arb.js + its tests rather than rewriting.
```
