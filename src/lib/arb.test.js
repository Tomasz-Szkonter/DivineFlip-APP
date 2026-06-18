import { describe, it, expect } from 'vitest';
import { analyze, buildOpportunities, rankOpportunities } from './arb.js';

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
