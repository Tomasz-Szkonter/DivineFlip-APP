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
      return {
        name: r.name,
        cat: r.cat,
        vol: r.vol || 0,
        ex: r.ex,
        div: pItemDiv,
        marginPct: a.marginPct,
        forward: a.forward,
        perUnit: a.perUnit,
        ppg: a.profitPerGold,
        totalProfit: a.perUnit * units,
        units,
        hasRealDiv,
        hunt: (r.vol || 0) * r.ex,
      };
    })
    .filter((r) => r.vol >= minVol);
}

/**
 * Sort + slice opportunities for one of the four ranking tabs.
 *  - "ppg"    profit per gold (default)
 *  - "margin" % margin
 *  - "total"  total profit at capital
 *  - "liq"    liquidity / safety (hunt = vol * ex), ignores margin filter
 */
export function rankOpportunities(opps, sortKey, { minMargin = 0, limit = 40 } = {}) {
  const rows = [...opps];
  if (sortKey === 'liq') return rows.sort((a, b) => b.hunt - a.hunt).slice(0, limit);
  const filtered = rows.filter((r) => r.marginPct >= minMargin);
  if (sortKey === 'margin') return filtered.sort((a, b) => b.marginPct - a.marginPct).slice(0, limit);
  if (sortKey === 'total') return filtered.sort((a, b) => b.totalProfit - a.totalProfit).slice(0, limit);
  return filtered.sort((a, b) => b.ppg - a.ppg).slice(0, limit);
}
