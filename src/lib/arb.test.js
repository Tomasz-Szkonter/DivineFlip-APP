import { describe, it, expect } from 'vitest';
import { analyze, buildOpportunities, rankOpportunities, scoreOf, topFlips } from './arb.js';

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

describe('ranking helpers', () => {
  const items = [
    { name: 'Omen of Light', cat: 'omens', ex: 1380, div: 7.2, vol: 100 },
    { name: 'Implied Orb', cat: 'currency', ex: 198, div: null, vol: 5000 },
  ];
  const opps = buildOpportunities(items, 198, { minVol: 0, goldPerUnit: 350, capInEx: 10000 });

  it('flags rows that fell back to an implied divine price', () => {
    expect(opps.find((o) => o.name === 'Omen of Light').hasRealDiv).toBe(true);
    expect(opps.find((o) => o.name === 'Implied Orb').hasRealDiv).toBe(false);
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
  const items = [
    { name: 'THIN-juicy', cat: 'a', ex: 1000, div: 5.15, vol: 50 },
    { name: 'SOLID-highvol', cat: 'b', ex: 1000, div: 5.1, vol: 8000 },
    { name: 'Implied', cat: 'c', ex: 200, div: null, vol: 9999 },
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

  it('excludes implied rows from the top flips', () => {
    const top = topFlips(opps, { minVol: 50, n: 5 });
    expect(top.map((o) => o.name)).toEqual(['SOLID-highvol', 'THIN-juicy']);
    expect(top.some((o) => !o.hasRealDiv)).toBe(false);
  });

  it('computes a volume-capped realistic total = perUnit * vol', () => {
    expect(solid.realisticTotal).toBeCloseTo(solid.perUnit * solid.vol, 6);
    expect(thin.realisticTotal).toBeCloseTo(30 * 50, 4);
  });
});
