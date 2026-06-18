import { describe, it, expect } from 'vitest';
import {
  analyze,
  bestLoop,
  valuesInEx,
  buildOpportunities,
  rankOpportunities,
  scoreOf,
  topFlips,
} from './arb.js';

// A two-way-liquid book on every market, so liquidity never gates these fixtures unless we
// deliberately zero it out. s = receive-side StockValue, v = receive-side VolumeTraded.
const LIQ = { ex: { s: 1e6, v: 1e6 }, div: { s: 1e6, v: 1e6 }, cha: { s: 1e6, v: 1e6 } };

describe('analyze — Omen of Light worked example (the brief)', () => {
  // 1 Divine = 198 ex, Omen = 1380 ex, Omen = 7.2 div
  // iDx = 7.2 * 198 = 1425.6 ex  => +45.6 ex over the 1380 ex exalted price => +3.30%
  const r = analyze(198, 1380, 7.2, 1, 350);

  it('computes +3.30% margin', () => {
    expect(r.marginPct).toBeCloseTo(3.3, 2);
  });

  it('runs forward: Ex -> Item -> Div -> Ex', () => {
    expect(r.forward).toBe(true);
  });

  it('nets 45.6 ex per unit before gold', () => {
    expect(r.perUnit).toBeCloseTo(45.6, 1);
  });

  it('reports value via the divine market as 1425.6 ex', () => {
    expect(r.iDx).toBeCloseTo(1425.6, 1);
  });
});

describe('analyze — direction & implied edge cases', () => {
  it('runs reverse when the divine market values the item lower', () => {
    const r = analyze(198, 1500, 7.2); // iDx 1425.6 < iE 1500
    expect(r.forward).toBe(false);
  });

  it('yields ~0% when the divine price is implied (ex / d)', () => {
    const r = analyze(198, 1380, 1380 / 198);
    expect(r.marginPct).toBeCloseTo(0, 6);
  });
});

describe('bestLoop — N-market buy-cheapest / sell-richest', () => {
  // d=200, chaosPrice=20. ex=1000, div=4.8 (->960 ex), cha=52 (->1040 ex).
  // cheapest = div (960), richest = cha (1040) => perUnit 80, margin 80/960 = 8.33%.
  const item = { ex: 1000, div: 4.8, cha: 52, liq: LIQ };
  const l = bestLoop(item, { divinePrice: 200, chaosPrice: 20 });

  it('computes value-in-ex per market', () => {
    const v = valuesInEx(item, { divinePrice: 200, chaosPrice: 20 });
    expect(v).toEqual({ ex: 1000, div: 960, cha: 1040 });
  });

  it('buys the cheapest market and sells the richest', () => {
    expect(l.buyCur).toBe('div');
    expect(l.sellCur).toBe('cha');
    expect(l.buyValEx).toBeCloseTo(960, 6);
    expect(l.sellValEx).toBeCloseTo(1040, 6);
  });

  it('nets the gap and the margin off the buy price', () => {
    expect(l.perUnit).toBeCloseTo(80, 6);
    expect(l.marginPct).toBeCloseTo(8.3333, 3);
  });

  it('flags two-way liquidity when the sell side has stock + volume', () => {
    expect(l.twoWay).toBe(true);
  });

  it('returns null when fewer than two markets are tradeable', () => {
    expect(bestLoop({ ex: 1000, div: null, cha: null, liq: LIQ }, { divinePrice: 200 })).toBe(null);
  });

  it('matches analyze() for the classic ex/div case', () => {
    // ex=1380, div=7.2, d=198 => richest div (1425.6), buy ex (1380): +45.6, +3.30%
    const e = bestLoop({ ex: 1380, div: 7.2, cha: null, liq: LIQ }, { divinePrice: 198 });
    const a = analyze(198, 1380, 7.2);
    expect(e.perUnit).toBeCloseTo(a.perUnit, 6);
    expect(e.marginPct).toBeCloseTo(a.marginPct, 6);
    expect(e.buyCur).toBe('ex');
    expect(e.sellCur).toBe('div');
  });
});

describe('liquidity guards — kill the Verisium false positive', () => {
  // Verisium: near-zero ex price (rounds to a rounding artifact) AND the divine side it
  // would sell into has zero stock. Must be excluded and flagged one-way.
  const verisium = {
    name: 'Verisium',
    cat: 'currency',
    ex: 0.0003,
    div: 0.0000016,
    cha: null,
    vol: 4,
    liq: { div: { s: 0, v: 4 } },
  };

  it('drops sub-floor legs so a near-zero price cannot fabricate a margin', () => {
    const opps = buildOpportunities([verisium], 200, { minVol: 0, chaosPrice: 20 });
    const o = opps.find((x) => x.name === 'Verisium');
    expect(o.marginPct).toBe(0); // both legs below the 0.05 ex floor => no loop
    expect(o.twoWay).toBe(false);
    expect(o.hasEdge).toBe(false);
  });

  it('flags a juicy-margin but one-sided book as NOT two-way and hides it from top flips', () => {
    // Normal prices (so the floor is not what saves us) but the divine sell side is empty.
    const oneSided = {
      name: 'OneSided',
      cat: 'currency',
      ex: 1000,
      div: 7.2, // valDiv = 1440 ex => +44% margin, looks great...
      cha: null,
      vol: 500,
      liq: { ex: { s: 1e6, v: 1e6 }, div: { s: 0, v: 0 } }, // ...but nothing to sell into
    };
    const opps = buildOpportunities([oneSided], 200, { minVol: 0, chaosPrice: 20 });
    const o = opps.find((x) => x.name === 'OneSided');
    expect(o.marginPct).toBeGreaterThan(40);
    expect(o.sellCur).toBe('div');
    expect(o.twoWay).toBe(false);
    const top = topFlips(opps, { minVol: 0, n: 5 });
    expect(top.some((x) => x.name === 'OneSided')).toBe(false);
  });

  it('keeps a thin-but-two-way edge OUT of the headline (strict receive-side floor)', () => {
    // The sell side can technically fill (twoWay true) but only ~40 trades deep — below the
    // headline's 500 receive-vol floor. Live data shows these are stale-price 300%+ artifacts.
    const thin = {
      name: 'ThinChaos', cat: 'currency', ex: 1.5, cha: 0.4, div: null, vol: 200,
      liq: { ex: { s: 1e6, v: 1e6 }, cha: { s: 400, v: 40 } },
    };
    const opps = buildOpportunities([thin], 200, { minVol: 0, chaosPrice: 20 });
    const o = opps.find((x) => x.name === 'ThinChaos');
    expect(o.twoWay).toBe(true); // badge: the loop *can* close
    expect(o.marginPct).toBeGreaterThan(400);
    expect(topFlips(opps, { minVol: 0, n: 5 }).some((x) => x.name === 'ThinChaos')).toBe(false);
  });

  it('keeps an over-cap margin OUT of the headline even when deeply liquid (80% ceiling)', () => {
    const fat = {
      name: 'FatButFishy', cat: 'currency', ex: 1000, div: 11, cha: null, vol: 1000, // valDiv=2200 => +120%
      liq: { div: { s: 1e6, v: 1e6 } },
    };
    const opps = buildOpportunities([fat], 200, { minVol: 0, chaosPrice: 20 });
    expect(opps[0].twoWay).toBe(true);
    expect(opps[0].marginPct).toBeCloseTo(120, 0);
    expect(topFlips(opps, { minVol: 0, n: 5 }).length).toBe(0); // 120% > 80% headline cap
  });

  it('topFlips excludes absurd margins unless two-way is confirmed', () => {
    const absurd = {
      name: 'Absurd',
      cat: 'currency',
      ex: 1,
      div: 30, // valDiv = 6000 ex => ~600,000% margin
      cha: null,
      vol: 100,
      liq: { div: { s: 0, v: 0 } }, // one-way => excluded by twoWay as well
    };
    const sane = {
      name: 'Sane',
      cat: 'currency',
      ex: 1000,
      div: 5.5, // valDiv = 1100 => +10%, two-way
      cha: null,
      vol: 100,
      liq: { div: { s: 1e6, v: 1e6 } },
    };
    const opps = buildOpportunities([absurd, sane], 200, { minVol: 0, chaosPrice: 20 });
    const top = topFlips(opps, { minVol: 0, n: 5, maxMargin: 500 });
    expect(top.map((o) => o.name)).toEqual(['Sane']);
  });
});

describe('ranking helpers', () => {
  const items = [
    { name: 'Omen of Light', cat: 'omens', ex: 1380, div: 7.2, cha: null, vol: 100, liq: LIQ },
    { name: 'Implied Orb', cat: 'currency', ex: 198, div: null, cha: null, vol: 5000, liq: LIQ },
  ];
  const opps = buildOpportunities(items, 198, { minVol: 0, goldPerUnit: 350, capInEx: 10000 });

  it('flags rows that fell back to an implied divine price', () => {
    expect(opps.find((o) => o.name === 'Omen of Light').hasRealDiv).toBe(true);
    expect(opps.find((o) => o.name === 'Implied Orb').hasRealDiv).toBe(false);
  });

  it('flags the implied row as having no real cross-market edge', () => {
    expect(opps.find((o) => o.name === 'Omen of Light').hasEdge).toBe(true);
    expect(opps.find((o) => o.name === 'Implied Orb').hasEdge).toBe(false);
  });

  it('ranks liquidity by hunt = vol * ex', () => {
    const liq = rankOpportunities(opps, 'liq');
    expect(liq[0].name).toBe('Implied Orb'); // 5000*198 > 100*1380
  });

  it('surfaces the real edge in the margin ranking', () => {
    const m = rankOpportunities(opps, 'margin', { minMargin: 1 });
    expect(m).toHaveLength(1);
    expect(m[0].name).toBe('Omen of Light');
  });
});

describe('smart score & top flips', () => {
  // d = 200. THIN has the juicier per-flip margin but tiny volume; SOLID has a
  // smaller margin on a huge book. Smart score should rank SOLID above THIN.
  //   THIN : iDx 5.15*200 = 1030 => +30 over 1000 => 3.0%, vol 50  => score ~5.12
  //   SOLID: iDx 5.10*200 = 1020 => +20 over 1000 => 2.0%, vol 8000 => score ~7.81
  // Both now need a two-way-liquid divine sell side (liq.div) to reach the headline.
  const items = [
    { name: 'THIN-juicy', cat: 'a', ex: 1000, div: 5.15, cha: null, vol: 50, liq: LIQ },
    { name: 'SOLID-highvol', cat: 'b', ex: 1000, div: 5.1, cha: null, vol: 8000, liq: LIQ },
    { name: 'Implied', cat: 'c', ex: 200, div: null, cha: null, vol: 9999, liq: LIQ },
  ];
  const opps = buildOpportunities(items, 200, { minVol: 0 });
  const thin = opps.find((o) => o.name === 'THIN-juicy');
  const solid = opps.find((o) => o.name === 'SOLID-highvol');

  it('demotes a juicy-but-thin item below a solid margin on good volume', () => {
    expect(thin.marginPct).toBeCloseTo(3.0, 6);
    expect(solid.marginPct).toBeCloseTo(2.0, 6);
    expect(thin.marginPct).toBeGreaterThan(solid.marginPct); // juicier per-flip edge
    expect(solid.score).toBeGreaterThan(thin.score); // ...but lower smart score
    const ranked = rankOpportunities(opps, 'score');
    expect(ranked[0].name).toBe('SOLID-highvol');
    expect(ranked.findIndex((r) => r.name === 'THIN-juicy')).toBeGreaterThan(0);
  });

  it('scoreOf matches the field built into each opportunity', () => {
    expect(thin.score).toBeCloseTo(scoreOf(thin.marginPct, thin.vol), 6);
  });

  it('excludes implied & one-way rows from the top flips', () => {
    const top = topFlips(opps, { minVol: 50, n: 5 });
    expect(top.map((o) => o.name)).toEqual(['SOLID-highvol', 'THIN-juicy']);
    expect(top.some((o) => !o.twoWay)).toBe(false);
    expect(top.some((o) => !o.hasEdge)).toBe(false);
  });

  it('computes a volume-capped realistic total = perUnit * vol', () => {
    expect(solid.realisticTotal).toBeCloseTo(solid.perUnit * solid.vol, 6);
    expect(thin.realisticTotal).toBeCloseTo(30 * 50, 4);
  });
});
