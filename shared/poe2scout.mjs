// shared/poe2scout.mjs
//
// Single source of truth that turns the poe2scout API into DivineFlip's normalized
// snapshot. Imported by BOTH scripts/fetch-data.mjs (Node) and worker/worker.js
// (Cloudflare) so the data logic never diverges. Uses the global `fetch` available in
// Node 18+ and in Workers.
//
// See API_NOTES.md for the confirmed endpoint shapes. The key fact:
// `SnapshotPairs` exposes an INDEPENDENT order book per currency pair, so an item's
// exalted-market price, divine-market price and chaos-market price are observed
// separately. The drift between them is the triangular arbitrage edge
// (Exalted <-> item <-> Divine <-> Chaos).
//
// Snapshot schema (additive superset — older consumers keep working):
//   { league, divinePrice, chaosPrice, epoch, updated, source, items:[{
//       name, cat, ex, div, cha, vol, liq:{ ex|div|cha:{s,v} }, spark:[...] }] }
//   - ex/div/cha : item price in exalted / divine / chaos (div/cha null when no book)
//   - vol        : min VolumeTraded across the books this item HAS (item side)
//   - liq[cur]   : the RECEIVE-side (counter-currency) liquidity of that book — what you
//                  sell INTO. s = StockValue, v = VolumeTraded. The two-way-liquidity guard.
//   - spark      : ~7 daily normalized exalted prices (chronological), only when withSpark
//   - chaosPrice : ex per chaos (chaos/exalted book; fallback divinePrice / ChaosDivinePrice)
//   - epoch      : ExchangeSnapshot.Epoch (unix s) — basis for volume/h deltas

const DEFAULT_API_BASE = 'https://poe2scout.com/api';
const DEFAULT_REALM = 'poe2';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Keep ~6 significant figures: handles both 700000 (Mirror) and 0.0028 (a shard)
// cleanly while stripping floating-point noise.
const round = (n) => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(6)));

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Within a pair each side carries a `RelativePrice` on the book's own scale; the
// exchange rate is the ratio: 1 target = (target.RelativePrice / counter.RelativePrice) counter.
// Returns the rate (target priced in the counter currency), the target's traded volume, and
// the COUNTER side's liquidity (`recv`) — the side you'd sell INTO (StockValue + VolumeTraded).
function pairRate(pair, targetApiId) {
  const oneIsTarget = pair.CurrencyOne.ApiId === targetApiId;
  const tData = oneIsTarget ? pair.CurrencyOneData : pair.CurrencyTwoData;
  const cData = oneIsTarget ? pair.CurrencyTwoData : pair.CurrencyOneData;
  const t = num(tData.RelativePrice);
  const c = num(cData.RelativePrice);
  if (!t || !c) return null;
  return {
    rate: t / c,
    vol: num(tData.VolumeTraded) ?? 0,
    recv: {
      // num("0E-8") -> 0, so a one-sided (zero-stock) book is captured correctly.
      stock: num(cData.StockValue) ?? 0,
      vol: num(cData.VolumeTraded) ?? 0,
    },
  };
}

// Best-effort: fetch each category's normalized PriceLogs (~7 daily points) and return an
// apiId -> [price, ...] map (chronological) plus the base-currency ItemIds (needed for the
// hourly rate history). Used for the free sparklines. Never throws: a failed category is
// skipped so the snapshot still ships.
async function fetchSparks(base, realm, leagueName, cats) {
  const map = new Map();
  const curIds = {}; // apiId -> ItemId (for divine/exalted/chaos)
  for (const cat of cats) {
    try {
      let page = 1;
      let pages = 1;
      do {
        const url =
          `${base}/${realm}/Leagues/${encodeURIComponent(leagueName)}/Currencies/ByCategory` +
          `?Category=${encodeURIComponent(cat)}&page=${page}&perPage=200`;
        const data = await getJSON(url);
        pages = num(data.Pages) ?? 1;
        for (const it of data.Items || []) {
          if (!it || !it.ApiId) continue;
          if (it.ItemId != null && ['divine', 'exalted', 'chaos'].includes(it.ApiId)) {
            curIds[it.ApiId] = it.ItemId;
          }
          if (!Array.isArray(it.PriceLogs)) continue;
          // PriceLogs come newest-first; reverse to chronological and keep finite prices.
          const series = it.PriceLogs.map((p) => round(num(p && p.Price)))
            .filter((p) => p != null)
            .reverse();
          if (series.length) map.set(it.ApiId, series);
        }
        page += 1;
      } while (page <= pages);
    } catch {
      /* skip this category, keep the rest */
    }
  }
  return { sparks: map, curIds };
}

// Best-effort hourly value-in-exalted history for the base currencies (Divine, Chaos), from
// the per-pair History endpoint (newest-first → reversed to chronological). `hours` points ≈
// that many hours back. The UI slices this into 7d / 1d / 6h windows. Never throws.
async function fetchRateHist(base, realm, leagueName, curIds, hours = 168) {
  const ex = curIds.exalted;
  if (ex == null) return null;
  const out = {};
  for (const [key, apiId] of [['div', 'divine'], ['cha', 'chaos']]) {
    const id = curIds[apiId];
    if (id == null) continue;
    try {
      const url =
        `${base}/${realm}/Leagues/${encodeURIComponent(leagueName)}/Currencies/Pairs/` +
        `${id}/${ex}/History?Limit=${hours}`;
      const data = await getJSON(url);
      const series = (data.History || [])
        .slice()
        .reverse() // oldest -> newest
        .map((h) => {
          const o = num(h?.Data?.CurrencyOneData?.RelativePrice); // the target currency
          const t = num(h?.Data?.CurrencyTwoData?.RelativePrice); // exalted
          return o && t ? round(o / t) : null;
        })
        .filter((v) => v != null);
      if (series.length > 1) out[key] = series;
    } catch {
      /* skip this currency, keep the rest */
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Fetch and normalize a market snapshot.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.apiBase]    poe2scout API base, default https://poe2scout.com/api
 * @param {string}   [opts.realm]      realm id, default "poe2"
 * @param {string}   [opts.league]     league Value or ShortName; default = current (IsCurrent)
 * @param {string[]} [opts.categories] optional CategoryApiId allowlist (lowercase)
 * @param {string}   [opts.source]     stamped onto the result ("github-action" | "worker" | ...)
 * @param {boolean}  [opts.withSpark]  also fetch per-category PriceLogs for the 7-day sparkline
 * @returns {Promise<{league:string,divinePrice:number,chaosPrice:?number,epoch:?number,updated:string,source:string,items:Array}>}
 */
export async function fetchSnapshot({
  apiBase = DEFAULT_API_BASE,
  realm = DEFAULT_REALM,
  league,
  categories,
  source = 'unknown',
  withSpark = false,
} = {}) {
  const base = apiBase.replace(/\/+$/, '');

  // 1. Leagues -> pick the current (or requested) league and its headline rates.
  const leagues = await getJSON(`${base}/${realm}/Leagues`);
  const pick =
    (league && leagues.find((l) => l.Value === league || l.ShortName === league)) ||
    leagues.find((l) => l.IsCurrent) ||
    leagues[0];
  if (!pick) throw new Error('No leagues returned from poe2scout');
  const leagueName = pick.Value;
  const headlineDivine = num(pick.DivinePrice);
  const chaosPerDiv = num(pick.ChaosDivinePrice); // chaos per divine (~8.79)

  // 2. Per-pair independent order books (one call, no pagination).
  const pairs = await getJSON(
    `${base}/${realm}/Leagues/${encodeURIComponent(leagueName)}/SnapshotPairs`,
  );
  if (!Array.isArray(pairs)) throw new Error('SnapshotPairs did not return an array');

  // 3. Cross rates from the direct books = the rate you'd actually transact the final
  //    convert-back leg at. Fall back to the league headline / ChaosDivinePrice.
  let bookDivine = null;
  let bookChaos = null;
  for (const p of pairs) {
    const ids = [p.CurrencyOne.ApiId, p.CurrencyTwo.ApiId];
    if (bookDivine == null && ids.includes('divine') && ids.includes('exalted')) {
      const r = pairRate(p, 'divine'); // divine priced in exalted
      if (r) bookDivine = r.rate;
    }
    if (bookChaos == null && ids.includes('chaos') && ids.includes('exalted')) {
      const r = pairRate(p, 'chaos'); // chaos priced in exalted
      if (r) bookChaos = r.rate;
    }
    if (bookDivine != null && bookChaos != null) break;
  }
  const divinePrice = bookDivine ?? headlineDivine;
  const chaosPrice = bookChaos ?? (divinePrice && chaosPerDiv ? divinePrice / chaosPerDiv : null);

  // 4. Walk pairs; collect each item's exalted / divine / chaos book price, its volume, and
  //    each book's RECEIVE-side liquidity (the counter-currency side you sell into).
  const catFilter = categories && categories.length ? new Set(categories) : null;
  const acc = new Map(); // apiId -> { name, cat, ex, exVol, exRecv, divInDiv, divVol, divRecv, chaInCha, chaVol, chaRecv }
  const note = (cur) => {
    let e = acc.get(cur.ApiId);
    if (!e) {
      e = {
        name: cur.Text || cur.ApiId,
        cat: (cur.CategoryApiId || '').toLowerCase(),
        ex: null,
        exVol: 0,
        exRecv: null,
        divInDiv: null,
        divVol: 0,
        divRecv: null,
        chaInCha: null,
        chaVol: 0,
        chaRecv: null,
      };
      acc.set(cur.ApiId, e);
    }
    return e;
  };

  for (const p of pairs) {
    const ids = [p.CurrencyOne.ApiId, p.CurrencyTwo.ApiId];
    if (ids.includes('exalted')) {
      const target = p.CurrencyOne.ApiId === 'exalted' ? p.CurrencyTwo : p.CurrencyOne;
      if (target.ApiId !== 'divine' && target.ApiId !== 'chaos') {
        const r = pairRate(p, target.ApiId); // item priced in exalted
        if (r) {
          const e = note(target);
          e.ex = r.rate;
          e.exVol = r.vol;
          e.exRecv = r.recv;
        }
      }
    }
    if (ids.includes('divine')) {
      const target = p.CurrencyOne.ApiId === 'divine' ? p.CurrencyTwo : p.CurrencyOne;
      if (target.ApiId !== 'exalted' && target.ApiId !== 'chaos') {
        const r = pairRate(p, target.ApiId); // item priced in divines
        if (r) {
          const e = note(target);
          e.divInDiv = r.rate;
          e.divVol = r.vol;
          e.divRecv = r.recv;
        }
      }
    }
    if (ids.includes('chaos')) {
      const target = p.CurrencyOne.ApiId === 'chaos' ? p.CurrencyTwo : p.CurrencyOne;
      if (target.ApiId !== 'exalted' && target.ApiId !== 'divine') {
        const r = pairRate(p, target.ApiId); // item priced in chaos
        if (r) {
          const e = note(target);
          e.chaInCha = r.rate;
          e.chaVol = r.vol;
          e.chaRecv = r.recv;
        }
      }
    }
  }

  // 5. Optional snapshot timestamp (for volume/h deltas) + per-category sparklines.
  let epoch = null;
  try {
    const ex = await getJSON(
      `${base}/${realm}/Leagues/${encodeURIComponent(leagueName)}/ExchangeSnapshot`,
    );
    const e = Array.isArray(ex) ? ex[0] : ex;
    epoch = num(e && e.Epoch);
  } catch {
    /* epoch is optional; volume/h just stays null this run */
  }

  // 6. Emit normalized items. `ex` is required (the exalted anchor leg); `div`/`cha` are the
  //    independent divine/chaos quotes when the item has that book, else null. `vol` is the
  //    thinner book among the books the item actually has.
  const items = [];
  const emitted = []; // [apiId, item] so we can attach sparks by apiId after the fact
  for (const [apiId, e] of acc) {
    if (apiId === 'divine' || apiId === 'exalted' || apiId === 'chaos') continue;
    if (!(e.ex > 0)) continue;
    if (catFilter && !catFilter.has(e.cat)) continue;
    const hasDiv = e.divInDiv != null && e.divInDiv > 0;
    const hasCha = e.chaInCha != null && e.chaInCha > 0;

    const vols = [e.exVol];
    if (hasDiv) vols.push(e.divVol);
    if (hasCha) vols.push(e.chaVol);

    const liq = {};
    if (e.exRecv) liq.ex = { s: round(e.exRecv.stock), v: Math.round(e.exRecv.vol) };
    if (hasDiv && e.divRecv) liq.div = { s: round(e.divRecv.stock), v: Math.round(e.divRecv.vol) };
    if (hasCha && e.chaRecv) liq.cha = { s: round(e.chaRecv.stock), v: Math.round(e.chaRecv.vol) };

    const item = {
      name: e.name,
      cat: e.cat || 'currency',
      ex: round(e.ex),
      div: hasDiv ? round(e.divInDiv) : null,
      cha: hasCha ? round(e.chaInCha) : null,
      vol: Math.round(Math.min(...vols)),
      liq,
    };
    items.push(item);
    emitted.push([apiId, item]);
  }

  // 7. Free per-item 7-day sparkline from PriceLogs (best-effort), attached by apiId. The same
  //    fetch yields the base-currency ItemIds, used to pull each currency's HOURLY value-in-ex
  //    history (rateHist) for the per-currency multi-timeframe (7d / 1d / 6h) graphs.
  let rateHist = null;
  if (withSpark) {
    const cats = [...new Set(emitted.map(([, it]) => it.cat).filter(Boolean))];
    const { sparks, curIds } = await fetchSparks(base, realm, leagueName, cats);
    for (const [apiId, item] of emitted) {
      const s = sparks.get(apiId);
      if (s && s.length) item.spark = s;
    }
    rateHist = await fetchRateHist(base, realm, leagueName, curIds);
  }

  // Order by liquidity (hunt = vol * ex) so the file is sensibly sorted; the UI re-ranks.
  items.sort((a, b) => b.vol * b.ex - a.vol * a.ex);

  return {
    league: leagueName,
    divinePrice: round(divinePrice),
    chaosPrice: round(chaosPrice),
    epoch,
    rateHist, // { div:[...hourly ex values, oldest->newest], cha:[...] } | null — per-currency history
    updated: new Date().toISOString(),
    source,
    items,
  };
}
