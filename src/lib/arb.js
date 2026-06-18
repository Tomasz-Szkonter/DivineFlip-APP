// src/lib/arb.js
//
// Core triangular-arbitrage math, ported verbatim from the index.html prototype.
//
// Unit of account = Exalted (E). d = ex per divine, iE = item's exalted price,
// pItemDiv = item's divine price, iDx = pItemDiv * d = item's value via the Divine market.
// The gap between iE and iDx is the triangular arbitrage edge.
//
//   forward (iDx > iE)  => loop Ex  -> buy Item -> sell for Div -> convert to Ex
//   reverse (iDx < iE)  => loop Div -> buy Item -> sell for Ex

/**
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
 * Smart score = margin weighted by a log of liquidity, so a fat margin isn't
 * buried by a mega-volume item while thin books are still demoted.
 * NOTE: log10(1 + vol) only spans ~1.7 (vol 50) to ~5.0 (vol ~90k), so the
 * volume penalty is gentle — treat the weighting as tunable.
 */
export function scoreOf(marginPct, vol) {
  return marginPct * Math.log10(1 + (vol || 0));
}

/**
 * Turn normalized snapshot items into ranked arbitrage opportunities.
 * Items without a real divine quote (`div == null`) fall back to the implied
 * price ex/d (=> ~0% margin) and are flagged `hasRealDiv: false`.
 *
 * @param {Array<{name:string,cat:string,ex:number,div:?number,vol:number}>} rows
 * @param {number} d  exalted per divine (snapshot.divinePrice)
 * @param {{minVol?:number, goldPerUnit?:number, capInEx?:number}} [opts]
 */
export function buildOpportunities(rows, d, { minVol = 0, goldPerUnit = 0, capInEx = 0 } = {}) {
  return rows
    .filter((r) => r.ex > 0)
    .map((r) => {
      const hasRealDiv = r.div != null;
      const pItemDiv = hasRealDiv ? r.div : d ? r.ex / d : 0;
      const a = analyze(d || 0, r.ex, pItemDiv, 1, goldPerUnit);
      const unitPrice = Math.min(a.iE, a.iDx || a.iE) || a.iE;
      const units = unitPrice > 0 ? Math.floor(capInEx / unitPrice) : 0;
      const vol = r.vol || 0;
      return {
        name: r.name,
        cat: r.cat,
        vol,
        ex: r.ex,
        div: pItemDiv,
        marginPct: a.marginPct,
        forward: a.forward,
        perUnit: a.perUnit,
        ppg: a.profitPerGold,
        totalProfit: a.perUnit * units,
        units,
        hasRealDiv,
        hunt: vol * r.ex,
        // Smart score (margin x liquidity) and a volume-capped "realistic" total.
        score: scoreOf(a.marginPct, vol),
        realisticTotal: a.perUnit * vol,
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
 */
export function rankOpportunities(opps, sortKey, { minMargin = 0, limit = 40, dir = 'desc' } = {}) {
  const rows = sortKey === 'liq' ? [...opps] : [...opps].filter((r) => r.marginPct >= minMargin);
  rows.sort(SORTERS[sortKey] || SORTERS.ppg);
  if (dir === 'asc') rows.reverse();
  return rows.slice(0, limit);
}

/**
 * The headline "TOP FLIPS": real (non-implied) edges with enough liquidity and
 * a positive margin, ranked by smart score. Thin wrapper over rankOpportunities
 * so the cards and the score-sorted table share one ordering.
 */
export function topFlips(opps, { minVol = 50, n = 5 } = {}) {
  const pool = opps.filter((o) => o.hasRealDiv && o.vol >= minVol && o.marginPct > 0);
  return rankOpportunities(pool, 'score', { limit: n });
}
