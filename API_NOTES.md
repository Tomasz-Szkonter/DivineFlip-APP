# poe2scout API notes (confirmed live)

All endpoints verified by hitting the API directly from Node on 2026-06-18 (the realm/league/field
names below are what the shipping code in `shared/poe2scout.mjs` depends on).

- **Base:** `https://poe2scout.com/api`
- **Realm:** `poe2` (from `GET /api/Realms` → `{game_api_id:"poe2", realm_api_id:"poe2", ...}`)
- **OpenAPI spec:** `GET /api/openapi.json` (FastAPI; the source of truth for every path)
- **CORS:** a request with an `Origin` header returns `200` with **no `Access-Control-Allow-Origin`**
  header → direct browser calls fail. This is why DivineFlip uses a committed snapshot + a Worker.

## Leagues — `GET /api/poe2/Leagues`

Array of:
```json
{ "Value": "Runes of Aldur", "ShortName": "runes", "IsCurrent": true,
  "DivinePrice": 189.97, "ChaosDivinePrice": 18.6, "BaseCurrencyApiId": "exalted", "...": "..." }
```
- Pick the league with `IsCurrent === true` (do **not** hardcode — at time of writing it is
  "Runes of Aldur", not the brief's assumed "Return of the Ancients").
- `DivinePrice` = the league headline divine price in exalted (used as the ticker fallback).

## Currencies by category (normalized) — `GET /api/poe2/Leagues/{League}/Currencies/ByCategory?Category={cat}&page=1&perPage=200`

Note the **PascalCase** `Category` query param. Returns:
```json
{ "CurrentPage": 1, "Pages": 2, "Total": 38, "Items": [
  { "ApiId": "mirror", "Text": "Mirror of Kalandra", "CategoryApiId": "currency",
    "CurrentPrice": 785361.4, "CurrentQuantity": 27,
    "PriceLogs": [{ "Price": 725060.9, "Time": "2026-06-18T00:00:00", "Quantity": 247 }] } ] }
```
This is the **normalized** list (one base/exalted price per item) → yields only implied (~0%) margins.
DivineFlip does not use it for the edge; it is handy for category names / display.

## Per-pair order books (the real arbitrage signal) — `GET /api/poe2/Leagues/{League}/SnapshotPairs`

Returns **all ~2157 independent currency-pair order books in one call** (no pagination). Each:
```json
{ "Volume": "173312.0", "BaseCurrencyApiId": "exalted",
  "CurrencyOne": { "ApiId": "vaal", "Text": "Vaal Orb", "CategoryApiId": "currency" },
  "CurrencyTwo": { "ApiId": "exalted", "Text": "Exalted Orb" },
  "CurrencyOneData": { "RelativePrice": "1.89565", "ValueTraded": "164507", "VolumeTraded": 91426,
                       "StockValue": "...", "HighestStock": 142 },
  "CurrencyTwoData": { "RelativePrice": "0.94920", "...": "..." } }
```

### Verified price semantics (tested on chaos / vaal / regal / annul / divine)

- **In-book exchange rate is the ratio of the two RelativePrices:**
  `1 A = (A.RelativePrice / B.RelativePrice) · B`. Each book is **independent**, so the same item
  reads a *different* exalted value in its exalted book vs via its divine book — e.g. chaos = 20.4 ex
  in its exalted book but ~23 ex via its divine book (~12% gap). **That drift is the triangular
  edge.** Thin/illiquid books are noisy → filter by volume / rank by liquidity in the UI.
- `ValueTraded / VolumeTraded` is *identical across books* for a currency (it's the normalized
  exalted average) → only ~0%. Use for cross-check/display, not for the edge.
- **Divine→exalted `d`:** from the direct `divine/exalted` book =
  `divine.RelativePrice / exalted.RelativePrice` (≈200 — the rate you transact the final leg at).
  Stored as `divinePrice` in the snapshot; the ticker headline can also use the league `DivinePrice`.

### How `shared/poe2scout.mjs` maps it to the normalized item

| normalized field | source |
| --- | --- |
| `ex`  | item's RelativePrice ratio in its **item/exalted** book (`item.RP / exalted.RP`) |
| `div` | item's RelativePrice ratio in its **item/divine** book (`item.RP / divine.RP`), else `null` |
| `cha` | item's RelativePrice ratio in its **item/chaos** book (`item.RP / chaos.RP`), else `null` |
| `vol` | `min(VolumeTraded)` across the books the item actually has (EX / DIV / CHA item side) |
| `liq[cur]` | the **counter-currency (receive) side** of the item/`cur` book: `{ s: StockValue, v: VolumeTraded }` |
| top-level `divinePrice` | the `divine/exalted` book ratio (ex per divine) |
| top-level `chaosPrice`  | the `chaos/exalted` book ratio (ex per chaos); fallback `divinePrice / ChaosDivinePrice` |
| top-level `epoch`       | `ExchangeSnapshot.Epoch` (unix s) — used to derive `vph` (trades/hour) from snapshot deltas |
| top-level `rateHist`    | `{ div:[...], cha:[...] }` — each base currency's HOURLY value-in-exalted (oldest→newest), for the per-currency 7d/1d/6h graphs |
| `vph` *(committed only)* | `Δvol / Δhours` vs the previous committed snapshot; `null` if unknown / a volume reset |
| `spark` *(optional)*    | `Currencies/ByCategory` `PriceLogs[].Price`, ~7 daily points, chronological (free 7-day sparkline) |

The three base currencies (`exalted`, `divine`, `chaos`) are **not** emitted as items — their pairwise
rates are the top-level `divinePrice` / `chaosPrice` cross-rates instead.

### Two-way liquidity (the receive side)

Each `*Data` block also carries **`StockValue`** (string; can be `"0E-8"` → parses to `0`) and
**`VolumeTraded`** (number). A flip A→B is only tradeable if the **B-side** currency actually has stock
to sell into — otherwise you can buy but never sell back (the "Verisium 8,178%" false positive). So
`liq[cur]` records the counter-currency side of each book, and `arb.js` requires the **sell** market's
receive side to be liquid before a flip is flagged two-way / eligible for the headline.

## Other confirmed endpoints

- `GET /api/Realms` — realms list.
- `GET /api/poe2/Leagues/{League}/ExchangeSnapshot` — `{Epoch, Volume, MarketCap, BaseCurrencyApiId}`.
- `GET /api/poe2/Leagues/{League}/SnapshotHistory?Limit=N` — `{Data:[{Epoch, Volume, MarketCap}]}`, **hourly**, newest-first (market-wide).
- `GET /api/poe2/Leagues/{League}/Currencies/Pairs/{OneItemId}/{TwoItemId}/History?Limit=N` — per-pair order-book
  **hourly** history, newest-first: `{History:[{Epoch, Data:{CurrencyOneData, CurrencyTwoData}}]}`. Rate =
  `One.RelativePrice / Two.RelativePrice`. Source for `rateHist` (each currency's value-in-ex over time).
  Currency `ItemId`s come from `Currencies/ByCategory` (e.g. exalted 290, divine 291, chaos 287 — resolve, don't hardcode).
- `GET /api/poe2/Leagues/{League}/Items/{ItemId}/DailyStatsHistory?DayCount=N` — daily OHLC
  `{DailyStats:[{Time, Open, High, Low, Close, Average, Volume}]}`. `/Items/{ItemId}/History?LogCount=N` (multiple of 4) also exists.
- `GET /api/poe2/Leagues/{League}/Items`, `/Items/Categories`, `/Uniques/ByCategory` (non-fungible
  items — not used for currency-exchange arbitrage).
