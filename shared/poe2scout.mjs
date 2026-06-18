// shared/poe2scout.mjs
//
// Single source of truth that turns the poe2scout API into DivineFlip's normalized
// snapshot. Imported by BOTH scripts/fetch-data.mjs (Node) and worker/worker.js
// (Cloudflare) so the data logic never diverges. Uses the global `fetch` available in
// Node 18+ and in Workers.
//
// See API_NOTES.md for the confirmed endpoint shapes. The key fact:
// `SnapshotPairs` exposes an INDEPENDENT order book per currency pair, so an item's
// exalted-market price and its divine-market price are observed separately. The drift
// between them is the triangular arbitrage edge (Exalted <-> item <-> Divine).

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
// Returns the rate (target priced in the counter currency) plus the target's traded volume.
function pairRate(pair, targetApiId) {
  const oneIsTarget = pair.CurrencyOne.ApiId === targetApiId;
  const tData = oneIsTarget ? pair.CurrencyOneData : pair.CurrencyTwoData;
  const cData = oneIsTarget ? pair.CurrencyTwoData : pair.CurrencyOneData;
  const t = num(tData.RelativePrice);
  const c = num(cData.RelativePrice);
  if (!t || !c) return null;
  return { rate: t / c, vol: num(tData.VolumeTraded) ?? 0 };
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
 * @returns {Promise<{league:string,divinePrice:number,updated:string,source:string,items:Array}>}
 */
export async function fetchSnapshot({
  apiBase = DEFAULT_API_BASE,
  realm = DEFAULT_REALM,
  league,
  categories,
  source = 'unknown',
} = {}) {
  const base = apiBase.replace(/\/+$/, '');

  // 1. Leagues -> pick the current (or requested) league and its headline divine price.
  const leagues = await getJSON(`${base}/${realm}/Leagues`);
  const pick =
    (league && leagues.find((l) => l.Value === league || l.ShortName === league)) ||
    leagues.find((l) => l.IsCurrent) ||
    leagues[0];
  if (!pick) throw new Error('No leagues returned from poe2scout');
  const leagueName = pick.Value;
  const headlineDivine = num(pick.DivinePrice);

  // 2. Per-pair independent order books (one call, no pagination).
  const pairs = await getJSON(
    `${base}/${realm}/Leagues/${encodeURIComponent(leagueName)}/SnapshotPairs`,
  );
  if (!Array.isArray(pairs)) throw new Error('SnapshotPairs did not return an array');

  // 3. Divine's exalted price from the direct divine/exalted book = the rate you'd
  //    actually transact the final leg at. Fall back to the league headline.
  let bookDivine = null;
  for (const p of pairs) {
    const ids = [p.CurrencyOne.ApiId, p.CurrencyTwo.ApiId];
    if (ids.includes('divine') && ids.includes('exalted')) {
      const r = pairRate(p, 'divine'); // divine priced in exalted
      if (r) bookDivine = r.rate;
      break;
    }
  }
  const divinePrice = bookDivine ?? headlineDivine;

  // 4. Walk pairs; collect each item's exalted-book price and divine-book price.
  const catFilter = categories && categories.length ? new Set(categories) : null;
  const acc = new Map(); // apiId -> { name, cat, ex, exVol, divInDiv, divVol }
  const note = (cur) => {
    let e = acc.get(cur.ApiId);
    if (!e) {
      e = {
        name: cur.Text || cur.ApiId,
        cat: (cur.CategoryApiId || '').toLowerCase(),
        ex: null,
        exVol: 0,
        divInDiv: null,
        divVol: 0,
      };
      acc.set(cur.ApiId, e);
    }
    return e;
  };

  for (const p of pairs) {
    const ids = [p.CurrencyOne.ApiId, p.CurrencyTwo.ApiId];
    if (ids.includes('exalted')) {
      const target = p.CurrencyOne.ApiId === 'exalted' ? p.CurrencyTwo : p.CurrencyOne;
      if (target.ApiId !== 'divine') {
        const r = pairRate(p, target.ApiId); // item priced in exalted
        if (r) {
          const e = note(target);
          e.ex = r.rate;
          e.exVol = r.vol;
        }
      }
    }
    if (ids.includes('divine')) {
      const target = p.CurrencyOne.ApiId === 'divine' ? p.CurrencyTwo : p.CurrencyOne;
      if (target.ApiId !== 'exalted') {
        const r = pairRate(p, target.ApiId); // item priced in divines
        if (r) {
          const e = note(target);
          e.divInDiv = r.rate;
          e.divVol = r.vol;
        }
      }
    }
  }

  // 5. Emit normalized items. `ex` is required (the exalted anchor leg); `div` is the
  //    independent divine quote when the item has a divine book, else null (the app then
  //    computes the implied ex/divinePrice and labels the row "implied").
  const items = [];
  for (const [apiId, e] of acc) {
    if (apiId === 'divine' || apiId === 'exalted') continue;
    if (!(e.ex > 0)) continue;
    if (catFilter && !catFilter.has(e.cat)) continue;
    const hasDiv = e.divInDiv != null && e.divInDiv > 0;
    items.push({
      name: e.name,
      cat: e.cat || 'currency',
      ex: round(e.ex),
      div: hasDiv ? round(e.divInDiv) : null,
      vol: Math.round(hasDiv ? Math.min(e.exVol, e.divVol) : e.exVol),
    });
  }

  // Order by liquidity (hunt = vol * ex) so the file is sensibly sorted; the UI re-ranks.
  items.sort((a, b) => b.vol * b.ex - a.vol * a.ex);

  return {
    league: leagueName,
    divinePrice: round(divinePrice),
    updated: new Date().toISOString(),
    source,
    items,
  };
}
