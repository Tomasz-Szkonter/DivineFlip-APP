# DivineFlip — Main Section Redesign (next-session brief)

> Paste-ready prompt for the new chat session is in the **"PROMPT"** block at the very bottom.
> Everything above it is the spec the prompt refers to.

## Why this redesign

The app works and is live, but the **"Best flips to hunt"** table is too dense to act on, and it
shows noise (tiny-volume listings, ~0% "implied" rows) that we'd never actually trade. The goal of
this pass is **usability**: surface the handful of genuinely tradeable Exalted↔item↔Divine loops in
a way you can read and act on in seconds.

Scope is the **main/hero area only**. Do **not** rebuild the data pipeline, worker, deploy, gold
model, calculator, or theme — reuse them.

## Current state (so you don't have to re-derive it)

- **Live:** https://tomasz-szkonter.github.io/DivineFlip-APP/ · repo `DivineFlip-APP` (GitHub Pages
  via Actions; data refreshed every 30 min by `update-data.yml`).
- **Stack:** Vite 5 + React 18 (single `src/App.jsx`, no router). Tests: vitest. `base: './'`.
- **Data the UI consumes** — `public/data/snapshot.json`, loaded same-origin:
  ```json
  { "league": "Runes of Aldur", "divinePrice": 200.4, "updated": "...", "source": "github-action",
    "items": [ { "name": "Chaos Orb", "cat": "currency", "ex": 20.43, "div": 0.1146, "vol": 91318 } ] }
  ```
  - `ex` = item price in Exalted, `div` = item price in Divine (**`null` = no independent divine
    book → "implied", ~0%, NOT a real edge**), `vol` = units traded (smaller of the two books),
    `divinePrice` = exalted per divine (~200). ~320 of ~587 items have a real `div`.
- **Math lib** `src/lib/arb.js` (already unit-tested in `arb.test.js`):
  - `analyze(d, iE, pItemDiv, units, goldPerUnit)` → `{ iE, iDx, perUnit, marginPct, forward, grossTotal, goldTotal, profitPerGold }`. `iDx = pItemDiv*d`; `forward=true` ⇒ loop **Ex→Item→Div→Ex**.
  - `buildOpportunities(rows, d, {minVol, goldPerUnit, capInEx})` → per-item opp objects
    (`marginPct, forward, perUnit, ppg, totalProfit, units, hasRealDiv, hunt=vol*ex, vol, ex, div`).
  - `rankOpportunities(opps, sortKey, {minMargin, limit})`.
- **Theme** (`src/styles.css`): dark; semantic colors — **cyan = Divine, amber = Exalted, green =
  profit, rose = loss, indigo/purple = actions/liquidity**. Reuse the existing classes/vars.
- Files this redesign will touch: `src/App.jsx`, `src/lib/arb.js`, `src/lib/arb.test.js`,
  `src/styles.css` (optionally add small components under `src/`).

## Decisions (locked with the user)

1. **TOP FLIPS ranking = smart score (margin × liquidity).** Start with
   `score = marginPct * Math.log10(1 + vol)` over the eligible pool (real divine quote, `vol ≥
   minVol`, `marginPct > 0`). `log10` keeps a fat margin from being buried by a mega-volume item
   while still demoting thin books. Treat the exact weighting as tunable; expose it in `arb.js`.
2. **Default liquidity floor `vol ≥ 50`** (change `DEFAULTS.minVol` from `'0'` to `'50'`), still
   adjustable via a live slider.
3. **Show both profit numbers, volume-capped realism:**
   - **Per-flip edge** (size-independent): `marginPct` + `perUnit` ex/flip + `profit/1k gold`.
   - **Realistic total** = `perUnit * vol` ("≈ if you clear the book, ~`vol` units"). Capital is
     assumed unlimited, so the book volume is the binding constraint — this is the headline "total".
   - Keep the theoretical/per-flip framing visible too (don't only show one number).
4. **TOP FLIPS = big cards, top 3–5** (responsive), a new section **above** "Best flips to hunt".
5. **Readability: fewer columns + click-to-expand.** Lead with the few numbers that matter; reveal
   the full breakdown on row expand.
6. **Hide implied rows by default** (`hasRealDiv === false`). They're ~0% and not tradeable. A
   filter toggle may bring them back, but default off.
7. **Capital = unlimited.** Rankings/score are independent of the user's orb holdings. The capital
   inputs can stay in Settings (they still feed the calculator) but must **not** drive Top Flips /
   table ranking.
8. **Table controls:** search by name, category filter, direction filter (All / Ex→Div / Div→Ex),
   and min-margin + min-volume sliders. Columns sortable (click header); **default sort = smart
   score desc**.

## Build spec

### A. `src/lib/arb.js`
- Add a **smart score** + **realistic total** to each opportunity in `buildOpportunities` (or a new
  enrich step): `score`, `realisticTotal = perUnit * vol`. Keep existing fields for the calculator.
- Add a `'score'` ranking branch (default) to `rankOpportunities`, or a dedicated
  `topFlips(opps, {minVol, n})` helper that filters `hasRealDiv && vol>=minVol && marginPct>0`,
  sorts by `score`, returns top N.
- Keep `analyze` unchanged. Add/extend tests in `arb.test.js`:
  - score ordering (a juicy-but-thin item ranks below a solid margin + good volume item),
  - implied items excluded from top flips,
  - `realisticTotal === perUnit * vol`,
  - existing Omen 3.30%/forward tests still pass.

### B. `src/App.jsx`
- **New `TopFlips` section (cards), above the hero table.** Top 3–5 by smart score. Each card:
  - Item name + category chip.
  - Bold **action line**, color-coded: `Buy with Exalted → Sell for Divine` (forward) or
    `Buy with Divine → Sell for Exalted` (reverse).
  - Big **% margin** (green) + **profit/flip** in ex.
  - **Realistic total**: `~{realisticTotal} ex if you clear ~{vol} units`.
  - Small: profit/1k gold, gold cost, the two market prices (`ex` and `iDx`).
  - Click → fills the calculator (reuse existing `pickRow`).
- **Rework "Best flips to hunt" table:**
  - Controls bar: search input, category chips (reuse existing), direction select
    (All / Ex→Div / Div→Ex), min-margin slider, min-volume slider, and (optional) "show implied"
    toggle (default off).
  - **Hide implied by default** in the view filter (`hasRealDiv`), unless the toggle is on.
  - **Fewer lead columns:** `# · Item (+cat) · Action (buy→sell) · Margin % · Profit/flip (ex) ·
    Volume · ⌄`. Replace the four ranking *tabs* with **sortable column headers** (click to sort;
    default = smart score). Keep a visible "Liquidity/safety" sort option.
  - **Row expand** reveals: value via Exalted market (`iE`), value via Divine market (`iDx`),
    profit/unit, **realistic total** (`perUnit*vol`), profit/1k gold, est. gold cost, raw div price,
    and a "Send to calculator" action.
  - Wire `search`, `direction`, `category`, `minMargin`, `minVol` into the `useMemo` that builds the
    view. Persist new UI state in the existing `localStorage` settings object (`LS`).
- Keep the **calculator, capital, gold model, settings, diagnostics, ticker, worker/Live-now** as-is.

### C. `src/styles.css`
- Add: top-flip card grid + card styling, expandable-row styling, sortable-header affordance (hover
  + active arrow), range-slider styling, search input. Reuse existing color vars and the `.card`,
  `.dir.fwd/.rev`, `.pill`, `.num`, `.bar` patterns. Keep the dark theme consistent.

## Acceptance criteria

1. A **TOP FLIPS** card section sits above "Best flips to hunt", showing the top 3–5 **real**
   (non-implied) opportunities ranked by smart score, each with a plain-English action line, %
   margin, profit/flip, and a volume-capped realistic total.
2. "Best flips to hunt" is **searchable, category- and direction-filterable, slider-thresholded, and
   column-sortable**, hides implied rows by default, shows **fewer columns with click-to-expand**
   detail, and defaults to `vol ≥ 50`.
3. Profit is shown as **both** a per-flip edge and a **realistic total capped by available volume**.
4. `npm test` passes (existing + new), `npm run build` succeeds, and the page still loads the
   snapshot same-origin with no console errors. Calculator + Live-now still work.
5. Theme/feel unchanged (same dark palette and semantic colors).

## Must not break
- `shared/poe2scout.mjs`, `scripts/fetch-data.mjs`, `worker/`, `.github/workflows/*`, the normalized
  JSON schema, the calculator, and the existing arb.js public API used by the calculator.

---

## PROMPT (paste this to start the next session)

```
Read REDESIGN_BRIEF.md in this repo, then redesign the main section of DivineFlip per that brief.

Summary of what I want:
- Add a new "TOP FLIPS" section of big cards (top 3–5) ABOVE "Best flips to hunt", ranked by a
  smart score = margin × liquidity, real (non-implied) edges only, vol ≥ 50.
- Make "Best flips to hunt" usable: searchable by name, filterable by category and by direction
  (Ex→Div / Div→Ex), min-margin & min-volume sliders, sortable columns (default = smart score).
- Hide "implied" (~0%, no independent divine book) rows by default.
- Fewer columns, click a row to expand the full breakdown.
- Show profit two ways: per-flip edge AND a realistic total capped by available volume.
- Capital is assumed unlimited — don't let my orb holdings drive the rankings.
- Keep the dark theme, the calculator, settings, gold model, the data pipeline, the worker, and the
  deploy untouched. Reuse src/lib/arb.js; extend it + its tests rather than rewriting.

Start by reading index/App.jsx, src/lib/arb.js, and public/data/snapshot.json, then propose a plan.
Acceptance criteria are in REDESIGN_BRIEF.md.
```
