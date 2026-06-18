// src/lib/arb.js
//
// Core triangular-arbitrage math.
//
// Unit of account = Exalted (E). An item is observed on up to three independent order
// books — Exalted, Divine and Chaos — so it carries a (possibly different) exalted value
// via each: valEx = ex, valDiv = div * divinePrice, valCha = cha * chaosPrice. The best
// loop buys the item on the CHEAPEST market and sells it on the RICHEST; the gap is the
// triangular arbitrage edge. A loop is only real if the SELL (receive) side is two-way
// liquid — otherwise you can buy but never sell back (the "Verisium" false positive).
//
// analyze() is the original 2-market (ex/div) helper, kept byte-compatible for the
// calculator. bestLoop() is the N-market generalization.

const CURRENCIES = ['ex', 'div', 'cha'];

/**
 * Original Ex<->item<->Div edge. UNCHANGED — the live calculator depends on this exact
 * shape. d = ex per divine, iE = item's exalted price, pItemDiv = item's divine price,
 * iDx = pItemDiv * d = item's value via the Divine market.
 *
 *   forward (iDx > iE)  => loop Ex  -> buy Item -> sell for Div -> convert to Ex
 *   reverse (iDx < iE)  => loop Div -> buy Item -> sell for Ex
 *
 * @param {number} d            exalted per divine
 * @param {number} iE           item's price in exalted
 * @param {number} pItemDiv     item's price in divine
 * @param {number} [units=1]    units flipped per loop
 * @param {number} [goldPerUnit=0] modelled gold fee per unit
 */
export function analyze(d, iE, pItemDiv, units = 1, goldPerUnit = 0) {
  const iDx = pItemDiv * d;
  const high = Math.max(iE, iDx);
  const low = Math.min(iE, iDx);
  const perUnit = high - low;
  const marginPct = low > 0 ? (perUnit / low) * 100 : 0;
  const forward = iDx > iE;
  const grossTotal = perUnit * units;
  const goldTotal = goldPerUnit * units;
  return {
    iE,
    iDx,
    d,
    pItemDiv,
    perUnit,
    marginPct,
    forward,
    units,
    grossTotal,
    goldTotal,
    profitPerGold: goldTotal > 0 ? grossTotal / goldTotal : 0,
  };
}

/**
 * Value-in-exalted of an item via each market it has a book on.
 * @returns {{ex:?number, div:?number, cha:?number}} null where the item has no book.
 */
export function valuesInEx(item, { divinePrice = 0, chaosPrice = 0 } = {}) {
  return {
    ex: item.ex > 0 ? item.ex : null,
    div: item.div > 0 && divinePrice ? item.div * divinePrice : null,
    cha: item.cha > 0 && chaosPrice ? item.cha * chaosPrice : null,
  };
}

/**
 * Generalize the 2-market (ex/div) edge to N markets over {ex, div, cha}: buy on the
 * cheapest market, sell on the richest. The sell (receive) side must be two-way liquid.
 *
 * @param {{ex:?number, div:?number, cha:?number, liq?:object}} item
 * @param {{divinePrice:number, chaosPrice:number}} rates
 * @param {{minRecvVol?:number, minRecvStock?:number, exFloor?:number}} [opts]
 * @returns {{buyCur, sellCur, buyValEx, sellValEx, perUnit, marginPct, twoWay,
 *           recvStock, recvVol, vals} | null}  null when fewer than 2 tradeable markets.
 */
export function bestLoop(
  item,
  { divinePrice = 0, chaosPrice = 0 } = {},
  { minRecvVol = 5, minRecvStock = 0, exFloor = 0.05 } = {},
) {
  const vals = valuesInEx(item, { divinePrice, chaosPrice });
  // Markets with a usable price above the rounding-artifact floor.
  const markets = CURRENCIES.filter((c) => vals[c] != null && vals[c] >= exFloor);
  if (markets.length < 2) return null;

  let buyCur = markets[0];
  let sellCur = markets[0];
  for (const c of markets) {
    if (vals[c] < vals[buyCur]) buyCur = c;
    if (vals[c] > vals[sellCur]) sellCur = c;
  }
  if (buyCur === sellCur) return null;

  const buyValEx = vals[buyCur];
  const sellValEx = vals[sellCur];
  const perUnit = sellValEx - buyValEx;
  const marginPct = buyValEx > 0 ? (perUnit / buyValEx) * 100 : 0;

  // Two-way liquidity: you can always add a buy order against existing stock on the cheap
  // book; the risk is the rich book has no counter-currency stock to sell INTO. Check the
  // receive side (liq[sellCur]). Missing liq => unknown => treat as one-way (conservative).
  const recv = (item.liq && item.liq[sellCur]) || null;
  const recvStock = recv ? recv.s ?? 0 : 0;
  const recvVol = recv ? recv.v ?? 0 : 0;
  const twoWay = !!recv && recvStock > minRecvStock && recvVol >= minRecvVol;

  return { buyCur, sellCur, buyValEx, sellValEx, perUnit, marginPct, twoWay, recvStock, recvVol, vals };
}

/**
 * Smart score = margin weighted by a log of liquidity, so a fat margin isn't
 * buried by a mega-volume item while thin books are still demoted.
 * NOTE: log10(1 + vol) only spans ~1.7 (vol 50) to ~5.0 (vol ~90k), so the
 * volume penalty is gentle — treat the weighting as tunable.
 */
export function scoreOf(marginPct, vol) {
  return marginPct * Math.log10(1 + (vol || 0));
}

/**
 * Turn normalized snapshot items into ranked arbitrage opportunities, comparing value
 * across all three markets (ex/div/cha) and flagging two-way liquidity.
 *
 * Items without a real divine quote (`div == null`) and no chaos edge fall back to a
 * 0%-margin "implied" opp, flagged `hasRealDiv: false` (the UI hides them by default).
 *
 * @param {Array<{name,cat,ex,div,cha,vol,liq}>} rows
 * @param {number} d  exalted per divine (snapshot.divinePrice)
 * @param {{minVol?:number, goldPerUnit?:number, capInEx?:number, chaosPrice?:number,
 *          minRecvVol?:number, minRecvStock?:number, exFloor?:number}} [opts]
 */
export function buildOpportunities(
  rows,
  d,
  {
    minVol = 0,
    goldPerUnit = 0,
    capInEx = 0,
    chaosPrice = 0,
    minRecvVol = 5,
    minRecvStock = 0,
    exFloor = 0.05,
  } = {},
) {
  return rows
    .filter((r) => r.ex > 0)
    .map((r) => {
      const hasRealDiv = r.div != null;
      const pItemDiv = hasRealDiv ? r.div : d ? r.ex / d : 0;
      const loop = bestLoop(
        r,
        { divinePrice: d || 0, chaosPrice },
        { minRecvVol, minRecvStock, exFloor },
      );

      const marginPct = loop ? loop.marginPct : 0;
      const perUnit = loop ? loop.perUnit : 0;
      const buyCur = loop ? loop.buyCur : 'ex';
      const sellCur = loop ? loop.sellCur : 'div';
      const buyValEx = loop ? loop.buyValEx : r.ex;
      const sellValEx = loop ? loop.sellValEx : r.ex;

      const unitPrice = buyValEx > 0 ? buyValEx : r.ex;
      const units = unitPrice > 0 ? Math.floor(capInEx / unitPrice) : 0;
      const vol = r.vol || 0;
      return {
        name: r.name,
        cat: r.cat,
        vol,
        vph: r.vph != null ? r.vph : null,
        spark: r.spark || null,
        ex: r.ex,
        div: pItemDiv,
        cha: r.cha ?? null,
        marginPct,
        // forward kept as a compat field for any un-migrated reference; the UI renders from
        // buyCur/sellCur. True for the classic ex->div-style loop.
        forward: loop ? loop.sellCur === 'div' || (loop.sellCur === 'cha' && loop.buyCur === 'ex') : true,
        buyCur,
        sellCur,
        buyValEx,
        sellValEx,
        twoWay: loop ? loop.twoWay : false,
        recvStock: loop ? loop.recvStock : 0,
        recvVol: loop ? loop.recvVol : 0,
        perUnit,
        ppg: goldPerUnit > 0 ? perUnit / goldPerUnit : 0,
        totalProfit: perUnit * units,
        units,
        // hasRealDiv: an independent Divine book exists (calculator/pickRow use it).
        hasRealDiv,
        // hasEdge: a genuine cross-market loop exists (>=2 markets, real price gap). Replaces
        // hasRealDiv as the "is this a real flip vs an implied ~0% artifact" signal, so an
        // item with a chaos book but no divine book still counts as a real edge.
        hasEdge: !!loop,
        hunt: vol * r.ex,
        // Smart score (margin x liquidity) and a volume-capped "realistic" total.
        score: scoreOf(marginPct, vol),
        realisticTotal: perUnit * vol,
      };
    })
    .filter((r) => r.vol >= minVol);
}

const SORTERS = {
  score: (a, b) => b.score - a.score,
  margin: (a, b) => b.marginPct - a.marginPct,
  perUnit: (a, b) => b.perUnit - a.perUnit,
  ppg: (a, b) => b.ppg - a.ppg,
  total: (a, b) => b.totalProfit - a.totalProfit,
  vol: (a, b) => b.vol - a.vol,
  liq: (a, b) => b.hunt - a.hunt,
};

/**
 * Sort + slice opportunities by one of the SORTERS keys.
 *  - "score"  smart score = margin x liquidity (default for the table)
 *  - "margin" % margin            - "perUnit" profit per unit
 *  - "ppg"    profit per gold     - "total"   total profit at capital
 *  - "vol"    units traded
 *  - "liq"    liquidity / safety (hunt = vol * ex), ignores the margin filter
 * `dir` is 'desc' by default; 'asc' reverses the order.
 * `requireTwoWay` drops one-way (unsellable) flips; `maxMargin` drops absurd margins
 * unless the flip is confirmed two-way. Both default to off, preserving legacy behavior.
 */
export function rankOpportunities(
  opps,
  sortKey,
  { minMargin = 0, limit = 40, dir = 'desc', maxMargin = Infinity, requireTwoWay = false } = {},
) {
  let rows = sortKey === 'liq' ? [...opps] : [...opps].filter((r) => r.marginPct >= minMargin);
  if (requireTwoWay) rows = rows.filter((r) => r.twoWay);
  if (maxMargin !== Infinity) rows = rows.filter((r) => r.twoWay || r.marginPct <= maxMargin);
  rows.sort(SORTERS[sortKey] || SORTERS.ppg);
  if (dir === 'asc') rows.reverse();
  return rows.slice(0, limit);
}

/**
 * The headline "TOP FLIPS": real, two-way-liquid edges, ranked by smart score. The headline
 * bar is deliberately STRICTER than the per-row `twoWay` badge (which only asks "can the loop
 * close at all"): a real flip needs the SELL side to be genuinely liquid (`recvVol >= minRecvVol`)
 * and a believable margin (`<= maxMargin`). Live data shows thin/stale books otherwise fabricate
 * 300–2000% "edges" you can't actually capture. The full table still shows everything, badged.
 *   - minRecvVol  receive-side VolumeTraded floor for the headline (default 500)
 *   - maxMargin   realistic margin ceiling; above this it's almost always stale/illiquid (default 80%)
 */
export function topFlips(opps, { minVol = 50, n = 5, maxMargin = 80, minRecvVol = 500 } = {}) {
  const pool = opps.filter(
    (o) =>
      o.hasEdge &&
      o.twoWay &&
      o.recvVol >= minRecvVol &&
      o.vol >= minVol &&
      o.marginPct > 0 &&
      o.marginPct <= maxMargin,
  );
  return rankOpportunities(pool, 'score', { limit: n });
}
