import React, { useEffect, useMemo, useRef, useState } from 'react';
import { bestLoop, valuesInEx, buildOpportunities, rankOpportunities, topFlips } from './lib/arb.js';

const LS = 'divineflip.react.v1';
const ENV_LIVE_URL = import.meta.env.VITE_LIVE_URL || '';
const SNAPSHOT_URL = `${import.meta.env.BASE_URL}data/snapshot.json`;
// Seed options for the Live-Worker league query (the page itself can't hit /Leagues — CORS).
const KNOWN_LEAGUES = ['Runes of Aldur', 'HC Runes of Aldur', 'Fate of the Vaal', 'Standard', 'Hardcore'];

// The three base currencies. label = abbreviation, cls = themed color class, name = full name.
const CUR = {
  ex: { label: 'EX', cls: 'exalted', name: 'Exalted' },
  div: { label: 'DIV', cls: 'divine', name: 'Divine' },
  cha: { label: 'CHA', cls: 'chaos', name: 'Chaos' },
};

const DEFAULTS = {
  minMargin: '1.5', minVol: '50',
  capDiv: '30', capEx: '0', goldPerUnit: '350',
  cDiv: '198', cIE: '1380', cID: '7.2', cCha: '21.5', cICha: '', cUnits: '30',
  sortKey: 'score', sortDir: 'desc', search: '', buyCur: 'any', sellCur: 'any', showImplied: false,
  league: '', cats: null, liveUrl: ENV_LIVE_URL,
};

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const fmt = (n, d = 2) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const r6 = (n) => (Number.isFinite(Number(n)) ? Number(Number(n).toPrecision(6)) : 0);

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS));
    if (s && typeof s === 'object') {
      const merged = { ...DEFAULTS, ...s };
      // Migrate only the stale legacy defaults to the redesigned behavior;
      // any deliberate customization (other sortKey / a non-'0' minVol) is kept.
      if (merged.sortKey === 'ppg') merged.sortKey = 'score';
      if (merged.minVol === '0' || merged.minVol === 0) merged.minVol = '50';
      // Legacy ex/div-only direction filter -> buy/sell currency filter.
      if (merged.direction) {
        if (merged.direction === 'fwd') { merged.buyCur = 'ex'; merged.sellCur = 'div'; }
        else if (merged.direction === 'rev') { merged.buyCur = 'div'; merged.sellCur = 'ex'; }
        delete merged.direction;
      }
      return merged;
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

function looseItem(o) {
  if (!o || typeof o !== 'object') return null;
  const name = o.name || o.Text || o.text || '?';
  const ex = num(o.CurrentPrice ?? o.currentPrice ?? o.price ?? o.ex);
  if (!ex) return null;
  const div = o.div != null ? num(o.div) : null;
  const cha = o.cha != null ? num(o.cha) : null;
  const cat = (o.cat || o.CategoryApiId || o.category || 'currency').toString().toLowerCase();
  const vol = num(o.CurrentQuantity ?? o.vol ?? o.Quantity ?? 0);
  // Pass through liq/spark/vph when pasting a full DivineFlip snapshot (else they're absent).
  return { name, cat, ex, div, cha, vol, liq: o.liq, spark: o.spark, vph: o.vph };
}

const RefreshIcon = ({ spin }) => (
  <svg className={spin ? 'spin' : ''} width="15" height="15" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.2"><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></svg>
);
const BoltIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9z" /></svg>
);
const BookIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
);

// Tiny inline-SVG sparkline of a price series (newest point on the right). Tinted by the
// overall 7-day trend: green when the latest price is up vs the first, rose when down.
function Sparkline({ data, w = 116, h = 30 }) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const stepX = w / (data.length - 1);
  const pts = data.map((v, i) => `${(i * stepX).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`);
  const up = data[data.length - 1] >= data[0];
  const color = up ? 'var(--profit)' : 'var(--loss)';
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(w).toFixed(1)} cy={pts[pts.length - 1].split(',')[1]} r="2" fill={color} />
    </svg>
  );
}

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [snapshot, setSnapshot] = useState(null);
  const [status, setStatus] = useState({ msg: 'Loading live market…', kind: 'warn' });
  const [busy, setBusy] = useState(null); // 'refresh' | 'live' | null
  const [calUnits, setCalUnits] = useState('');
  const [calGold, setCalGold] = useState('');
  const [rawJson, setRawJson] = useState('');
  const [openRow, setOpenRow] = useState(null); // expanded table row, keyed by item name
  const [openFlip, setOpenFlip] = useState(null); // expanded TOP FLIPS card, keyed by item name
  const [guideOpen, setGuideOpen] = useState(false); // "How to read a flip" slideout

  const setField = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const effectiveLiveUrl = (settings.liveUrl || '').trim() || ENV_LIVE_URL;
  const prevSnapRef = useRef(null); // last applied snapshot — basis for client-side volume/h

  // persist settings
  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(settings)); } catch { /* ignore */ }
  }, [settings]);

  // Fill missing per-item volume/h from the delta vs the previously displayed snapshot.
  // The committed snapshot ships baked vph; a live (worker) snapshot doesn't, so we derive
  // a fresher value from the two readings the app already holds (Δvol / Δhours via epoch).
  function fillVph(data) {
    const prev = prevSnapRef.current;
    if (!prev || prev.epoch == null || data.epoch == null || data.epoch <= prev.epoch) return;
    const dtH = (data.epoch - prev.epoch) / 3600;
    if (!(dtH > 0)) return;
    const before = new Map(prev.items.map((i) => [i.name, i.vol]));
    for (const it of data.items) {
      if (it.vph != null) continue;
      const b = before.get(it.name);
      if (b == null) continue;
      const delta = it.vol - b;
      it.vph = delta > 0 ? Math.round(delta / dtH) : null;
    }
  }

  // A snapshot is "full schema" once it carries the multi-currency / liquidity fields.
  const isFull = (snap) => !!snap && snap.chaosPrice != null;

  function applySnapshot(data, live) {
    if (!data || !Array.isArray(data.items)) throw new Error('missing items[]');
    // Don't let a stale Worker (old 2-currency schema, no chaos/liquidity) clobber a richer
    // committed snapshot — that would empty Top Flips and blank the Chaos rate.
    if (live && !isFull(data) && isFull(prevSnapRef.current)) {
      setStatus({
        msg: 'Live Worker returned old-format data (no Chaos / liquidity). Redeploy it — '
          + '<code>cd worker &amp;&amp; wrangler deploy</code> — to enable live Chaos + two-way data. '
          + 'Keeping the committed snapshot.',
        kind: 'warn',
      });
      return;
    }
    // The Worker can lag the committed pipeline until it's redeployed (and never computes vph).
    // Carry slow-moving rich fields forward so a live swap never silently drops a feature.
    const prev = prevSnapRef.current;
    if (!data.rateHist && prev?.rateHist) data.rateHist = prev.rateHist;
    fillVph(data);
    prevSnapRef.current = data;
    setSnapshot(data);
    if (data.league) setSettings((s) => (s.league ? s : { ...s, league: data.league }));
    const real = data.items.filter((i) => i.div != null).length;
    const stale = isFull(data)
      ? ''
      : ' ⚠ old-format data — redeploy the Worker / refresh the snapshot to enable Chaos + liquidity.';
    setStatus({
      msg: `${live ? 'Live now' : 'Loaded'}: ${data.items.length} items · ${real} with real divine quotes · `
        + `source "${data.source}" · ${data.league}.${stale} Confirm the in-game rate in the calculator before trading.`,
      kind: stale ? 'warn' : 'ok',
    });
  }

  async function loadFrom(url, live) {
    setBusy(live ? 'live' : 'refresh');
    setStatus({ msg: live ? 'Fetching live market via Worker…' : 'Loading market snapshot…', kind: 'warn' });
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      applySnapshot(await res.json(), live);
      return true;
    } catch (e) {
      setStatus({
        msg: `Couldn't load data (${e.message}). The calculator still works — open Diagnostics to paste JSON.`,
        kind: 'err',
      });
      return false;
    } finally {
      setBusy(null);
    }
  }

  // Live-first on mount: paint the committed snapshot instantly, then swap to the live
  // Worker; if the Worker fails, the committed snapshot stays. "Live now" is the default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await loadFrom(`${SNAPSHOT_URL}?t=${Date.now()}`, false);
      if (cancelled || !effectiveLiveUrl) return;
      const q = ''; // initial league not yet known; the snapshot's own league is fine
      await loadFrom(effectiveLiveUrl + q, true).catch(() => ok);
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line

  const refresh = () => loadFrom(`${SNAPSHOT_URL}?t=${Date.now()}`, false);
  const liveNow = () => {
    if (!effectiveLiveUrl) return;
    const q = settings.league ? `${effectiveLiveUrl.includes('?') ? '&' : '?'}league=${encodeURIComponent(settings.league)}` : '';
    loadFrom(effectiveLiveUrl + q, true);
  };

  const d = snapshot ? num(snapshot.divinePrice) : 0;
  const ch = snapshot ? num(snapshot.chaosPrice) : 0;

  const opps = useMemo(() => {
    if (!snapshot) return [];
    const capInEx = num(settings.capEx) + num(settings.capDiv) * d;
    return buildOpportunities(snapshot.items, d, {
      minVol: num(settings.minVol),
      goldPerUnit: num(settings.goldPerUnit),
      capInEx,
      chaosPrice: ch,
    });
  }, [snapshot, d, ch, settings.capEx, settings.capDiv, settings.minVol, settings.goldPerUnit]);

  const allCats = useMemo(() => {
    const set = new Set((snapshot?.items || []).map((i) => i.cat).filter(Boolean));
    return [...set].sort();
  }, [snapshot]);

  const catActive = (c) => settings.cats == null || settings.cats.includes(c);
  const toggleCat = (c) =>
    setSettings((s) => {
      const base = s.cats == null ? allCats : s.cats;
      const next = base.includes(c) ? base.filter((x) => x !== c) : [...base, c];
      return { ...s, cats: next };
    });

  // Headline TOP FLIPS — a global ranking, independent of the table controls
  // below (so typing a search query never empties it).
  const flips = useMemo(
    () => topFlips(opps, { minVol: num(settings.minVol), n: 5 }),
    [opps, settings.minVol],
  );

  const passesFilters = (o) => {
    if (!catActive(o.cat)) return false;
    // Rows without a real cross-market edge (~0% by construction) are gated on the toggle +
    // volume floor only — never on min-margin, or the toggle would be a no-op.
    if (!o.hasEdge) return settings.showImplied;
    if (o.marginPct < num(settings.minMargin)) return false;
    if (settings.buyCur !== 'any' && o.buyCur !== settings.buyCur) return false;
    if (settings.sellCur !== 'any' && o.sellCur !== settings.sellCur) return false;
    const q = settings.search.trim().toLowerCase();
    if (q && !o.name.toLowerCase().includes(q)) return false;
    return true;
  };

  const view = useMemo(
    () => rankOpportunities(opps.filter(passesFilters), settings.sortKey, { limit: 60, dir: settings.sortDir }),
    [opps, settings.cats, settings.showImplied, settings.minMargin, settings.buyCur, settings.sellCur, settings.search, settings.sortKey, settings.sortDir], // eslint-disable-line
  );

  const sortBy = (key) =>
    setSettings((s) => ({ ...s, sortKey: key, sortDir: s.sortKey === key && s.sortDir === 'desc' ? 'asc' : 'desc' }));
  const toggleRow = (name) => setOpenRow((cur) => (cur === name ? null : name));
  const toggleFlip = (name) => setOpenFlip((cur) => (cur === name ? null : name));
  const sortTh = (label, k) => (
    <th className={`sortable${settings.sortKey === k ? ' active' : ''}`} onClick={() => sortBy(k)}>
      {label}{settings.sortKey === k && <span className="arrow">{settings.sortDir === 'desc' ? '▼' : '▲'}</span>}
    </th>
  );

  // 3-currency calculator. Reuses bestLoop over the manually-entered rates; with the Chaos
  // fields blank it reduces to the classic Ex/Div edge (numerically identical to analyze()).
  const calc = useMemo(() => {
    const dd = num(settings.cDiv), iE = num(settings.cIE), pid = num(settings.cID);
    const cc = num(settings.cCha), iCha = num(settings.cICha);
    const units = num(settings.cUnits) || 1, gpu = num(settings.goldPerUnit);
    if (!dd || !iE || !pid) return null;
    const item = { ex: iE, div: pid, cha: iCha > 0 ? iCha : null };
    const rates = { divinePrice: dd, chaosPrice: cc };
    const vals = valuesInEx(item, rates);
    // Guards off: manual entry carries no liquidity data and we want the raw edge.
    const loop = bestLoop(item, rates, { exFloor: 0, minRecvVol: 0, minRecvStock: -1 });
    const perUnit = loop ? loop.perUnit : 0;
    const marginPct = loop ? loop.marginPct : 0;
    const grossTotal = perUnit * units, goldTotal = gpu * units;
    return {
      vals, buyCur: loop ? loop.buyCur : 'ex', sellCur: loop ? loop.sellCur : 'div',
      perUnit, marginPct, units, dd,
      grossTotal, goldTotal, profitPerGold: goldTotal > 0 ? grossTotal / goldTotal : 0,
    };
  }, [settings.cDiv, settings.cIE, settings.cID, settings.cCha, settings.cICha, settings.cUnits, settings.goldPerUnit]);

  const pickRow = (r) =>
    setSettings((s) => ({
      ...s,
      cIE: String(r6(r.ex)),
      // Calculator stays Ex/Div-anchored; fall back to the implied divine price for a
      // chaos-route flip that has no independent divine book (so the field isn't blank).
      cID: String(r6(r.div != null ? r.div : (d ? r.ex / d : num(s.cID)))),
      cICha: r.cha != null ? String(r6(r.cha)) : '',
      cCha: String(r6(ch || num(s.cCha))),
      cDiv: String(Math.round(d || num(s.cDiv))),
    }));

  const calibrate = () => {
    const u = num(calUnits), g = num(calGold);
    if (u > 0 && g > 0) {
      setField('goldPerUnit', String(Math.round(g / u)));
      setStatus({ msg: `Gold/unit set to ${Math.round(g / u)} from your trade.`, kind: 'ok' });
    }
  };

  const parsePasted = () => {
    try {
      const j = JSON.parse(rawJson);
      let data;
      if (j && Array.isArray(j.items)) data = j;
      else {
        const arr = Array.isArray(j) ? j : (j.Items || j.items || j.data || []);
        const items = arr.map(looseItem).filter(Boolean);
        if (!items.length) throw new Error('no recognizable items');
        data = { league: j.league || 'pasted', divinePrice: num(settings.cDiv), updated: new Date().toISOString(), source: 'pasted', items };
      }
      applySnapshot(data, false);
    } catch (e) {
      setStatus({ msg: 'Could not parse JSON: ' + e.message, kind: 'err' });
    }
  };

  const updatedLabel = snapshot?.updated
    ? new Date(snapshot.updated).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';
  const leagueOptions = [...new Set([snapshot?.league, settings.league, ...KNOWN_LEAGUES].filter(Boolean))];
  const maxVol = Math.max(...view.map((r) => r.vol), 1);

  return (
    <>
      <div className="topbar">
        <div className="logo"><span className="dot" /><span className="d">Divine</span><span className="f">Flip</span></div>
        <div className="ticker">
          <Stat label="League" small>{snapshot ? snapshot.league : <span className="skel" />}</Stat>
          <Stat label="1 Divine">
            {snapshot ? <Rate parts={[[fmt(d, 0), 'ex', 'exalted'], ch ? [fmt(d / ch, 1), 'cha', 'chaos'] : null]} /> : <span className="skel" />}
          </Stat>
          <Stat label="1 Exalted">
            {d ? <Rate parts={[[fmt(1 / d, 4), 'div', 'divine'], ch ? [fmt(1 / ch, 4), 'cha', 'chaos'] : null]} /> : '—'}
          </Stat>
          <Stat label="1 Chaos">
            {ch ? <Rate parts={[[fmt(ch), 'ex', 'exalted'], d ? [fmt(ch / d, 4), 'div', 'divine'] : null]} /> : '—'}
          </Stat>
          <Stat label="Items"><span className="num">{snapshot ? fmt(snapshot.items.length, 0) : '—'}</span></Stat>
          <Stat label="Updated" small>{updatedLabel}</Stat>
          <button className="ghost" disabled={busy === 'refresh'} onClick={refresh} title="Reload the committed snapshot (same-origin)">
            <RefreshIcon spin={busy === 'refresh'} /> Refresh
          </button>
          <button
            className="ghost live-btn"
            disabled={!effectiveLiveUrl || busy === 'live'}
            onClick={liveNow}
            title={effectiveLiveUrl ? 'Fetch a fresh market snapshot via your Cloudflare Worker' : 'Set VITE_LIVE_URL (or the field in Settings) to a deployed Worker to enable live fetch'}
          >
            <BoltIcon /> {busy === 'live' ? 'Fetching…' : 'Live now'}
          </button>
        </div>
      </div>

      <div className="wrap">
        <div className={`banner ${status.kind}`}><span dangerouslySetInnerHTML={{ __html: status.msg }} /></div>

        {/* Currency rates + 7-day price history (EX is the base unit) */}
        {snapshot && (
          <div className="rates">
            <RateTile cur="ex" valEx={1} note="base unit — always 1 ex" />
            <RateTile cur="div" valEx={d} hist={snapshot.rateHist?.div} note="price history unavailable (refresh data)" />
            <RateTile cur="cha" valEx={ch} hist={snapshot.rateHist?.cha} note="price history unavailable (refresh data)" />
          </div>
        )}

        {/* TOP FLIPS: headline cards */}
        {snapshot && flips.length > 0 && (
          <section className="topflips-section">
            <div className="ch" style={{ marginBottom: 12 }}>
              <h2>Top flips</h2>
              <span className="live">live</span>
              <span className="muted" style={{ fontSize: 12 }}>
                highest smart score (margin × liquidity) · real edges only · click a card for the full breakdown
              </span>
              <button className="ghost guide-btn" style={{ marginLeft: 'auto' }} onClick={() => setGuideOpen(true)}>
                <BookIcon /> How to read a flip
              </button>
            </div>
            <div className="topflips">
              {flips.map((f) => {
                const open = openFlip === f.name;
                const buy = CUR[f.buyCur], sell = CUR[f.sellCur];
                return (
                  <div key={f.name} className={`flipcard sell-${f.sellCur}${open ? ' open' : ''}`} onClick={() => toggleFlip(f.name)} title="Click for the full breakdown">
                    <div className="fc-top">
                      <span className="iname">{f.name}</span>
                      <span className="cat">{f.cat || '—'}</span>
                      {f.spark && <Sparkline data={f.spark} w={64} h={20} />}
                      <span className={`chev${open ? ' open' : ''}`} style={{ marginLeft: 'auto' }}>⌄</span>
                    </div>
                    <div className="fc-act">
                      Buy with <b className={buy.cls}>{buy.name}</b> → Sell for <b className={sell.cls}>{sell.name}</b>
                      <span className="twoway ok" title="Two-way liquid — the sell side has stock to fill">✓</span>
                    </div>
                    <div className="fc-big">
                      <span className="big profit">+{fmt(f.marginPct)}%</span>
                      <span className="fc-per num">{fmt(f.perUnit)} <span className="exalted">ex</span>/flip</span>
                    </div>
                    <div className="fc-real">
                      ≈ <span className="num profit">{fmt(f.realisticTotal, 0)}</span> <span className="exalted">ex</span> if you clear ~{fmt(f.vol, 0)} units
                      {f.vph != null && <> · <span className="num">{fmt(f.vph, 0)}</span>/h</>}
                    </div>
                    <div className="fc-small">
                      <span className="num">{fmt(f.ppg * 1000)}</span> /1k gold · <span className="num">{fmt(num(settings.goldPerUnit), 0)}</span> gold/flip
                      {' · '}buy <span className={`num ${buy.cls}`}>{fmt(f.buyValEx)}</span> · sell <span className={`num ${sell.cls}`}>{fmt(f.sellValEx)}</span> <span className="exalted">ex</span>
                    </div>
                    {open && (
                      <div className="fc-expand" onClick={(e) => e.stopPropagation()}>
                        <FlipDetail
                          r={f} d={d} ch={ch} goldPerUnit={num(settings.goldPerUnit)}
                          onSend={() => pickRow(f)} onGuide={() => setGuideOpen(true)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* HERO: best flips */}
        <div className="card hero">
          <div className="ch">
            <h2>Best flips to hunt</h2>
            <span className="live">live</span>
            {snapshot && <span className="src">source: {snapshot.source}</span>}
          </div>
          <p className="sub">
            Search, filter and sort the full book across the <b className="exalted">EX</b> / <b className="divine">DIV</b> /{' '}
            <b className="chaos">CHA</b> markets — each flip buys on the cheapest and sells on the richest. Rows marked{' '}
            <span className="pill">implied</span> have no real cross-market edge (≈0%) and are hidden until you toggle them
            on; a <span className="oneway">✗</span> means the sell side has no stock to fill. Click any row for the full
            breakdown, then confirm the live in-game rate in the calculator before you trade.
          </p>

          <div className="controls">
            <input
              className="search" type="text" placeholder="Search item…"
              value={settings.search} onChange={(e) => setField('search', e.target.value)}
            />
            <select value={settings.buyCur} onChange={(e) => setField('buyCur', e.target.value)} title="Buy-side currency">
              <option value="any">Buy: any</option>
              <option value="ex">Buy: EX</option>
              <option value="div">Buy: DIV</option>
              <option value="cha">Buy: CHA</option>
            </select>
            <select value={settings.sellCur} onChange={(e) => setField('sellCur', e.target.value)} title="Sell-side currency">
              <option value="any">Sell: any</option>
              <option value="ex">Sell: EX</option>
              <option value="div">Sell: DIV</option>
              <option value="cha">Sell: CHA</option>
            </select>
            <div className="sortpills">
              <span className={`sortpill${settings.sortKey === 'score' ? ' on' : ''}`} onClick={() => setField('sortKey', 'score')}>Smart score</span>
              <span className={`sortpill${settings.sortKey === 'liq' ? ' on' : ''}`} onClick={() => setField('sortKey', 'liq')}>Liquidity / safety</span>
            </div>
            <div className="slider">
              <label>Min % margin · <span className="num">{fmt(num(settings.minMargin))}</span></label>
              <input type="range" min="0" max="10" step="0.5" value={num(settings.minMargin)} onChange={(e) => setField('minMargin', e.target.value)} />
            </div>
            <div className="slider">
              <label>Min volume · <span className="num">{fmt(num(settings.minVol), 0)}</span></label>
              <input type="range" min="0" max="1000" step="10" value={num(settings.minVol)} onChange={(e) => setField('minVol', e.target.value)} />
            </div>
            <label className="implied-toggle">
              <input type="checkbox" checked={settings.showImplied} onChange={(e) => setField('showImplied', e.target.checked)} />
              Show implied
            </label>
          </div>
          <div className="chips" style={{ marginBottom: 14 }}>
            {allCats.length === 0
              ? <span className="muted" style={{ fontSize: 12 }}>—</span>
              : allCats.map((c) => (
                <span key={c} className={`chip${catActive(c) ? ' on' : ''}`} onClick={() => toggleCat(c)}>{c}</span>
              ))}
          </div>

          <div className="scrollx">
            {!snapshot ? (
              <table><tbody><tr><td className="empty">Pulling snapshot…</td></tr></tbody></table>
            ) : view.length === 0 ? (
              <table><tbody><tr><td className="empty">
                No flips match your filters. Lower the min-margin / min-volume sliders, clear the search, or toggle{' '}
                <b style={{ color: 'var(--purple)' }}>Show implied</b> for high-volume targets.
              </td></tr></tbody></table>
            ) : (
              <table className="fliptable">
                <thead><tr>
                  <th>#</th><th>Item</th><th>Action</th>
                  {sortTh('Margin %', 'margin')}
                  {sortTh('Profit/flip', 'perUnit')}
                  {sortTh('Volume', 'vol')}
                  <th aria-label="expand" />
                </tr></thead>
                <tbody>
                  {view.map((r, i) => {
                    const pc = r.perUnit > 0 ? 'profit' : '';
                    const open = openRow === r.name;
                    return (
                      <React.Fragment key={r.name + i}>
                        <tr className={open ? 'open' : ''} onClick={() => toggleRow(r.name)}>
                          <td className="rank">{i + 1}</td>
                          <td>
                            <span className="iname">{r.name}</span>
                            <span className="cat">{r.cat || '—'}</span>
                            {!r.hasEdge && <span className="pill">implied</span>}
                          </td>
                          <td>
                            <span className={`dir sell-${r.sellCur}`}>Buy {CUR[r.buyCur].label}→{CUR[r.sellCur].label}</span>
                            {r.hasEdge && (r.twoWay
                              ? <span className="twoway" title="Two-way liquid — the sell side has stock to fill">✓</span>
                              : <span className="oneway" title="One-way — the sell side has no stock; you may not be able to sell back">✗</span>)}
                          </td>
                          <td className={`num ${pc}`}>{fmt(r.marginPct)}%</td>
                          <td className={`num ${pc}`}>{fmt(r.perUnit)} <span className="exalted">ex</span></td>
                          <td className="num">
                            <div className="volcell">
                              <span>{fmt(r.vol, 0)}{r.vph != null && <span className="vph"> · {fmt(r.vph, 0)}/h</span>}</span>
                              <div className="bar"><i style={{ width: `${Math.max(4, (r.vol / maxVol) * 100)}%`, background: 'var(--purple)' }} /></div>
                            </div>
                          </td>
                          <td className="chevcell"><span className={`chev${open ? ' open' : ''}`}>⌄</span></td>
                        </tr>
                        {open && (
                          <tr className="rowdetail">
                            <td colSpan={7}>
                              <FlipDetail
                                r={r} d={d} ch={ch} goldPerUnit={num(settings.goldPerUnit)}
                                onSend={() => pickRow(r)} onGuide={() => setGuideOpen(true)}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* CALCULATOR + SETTINGS */}
        <div className="grid">
          <div className="card">
            <div className="ch"><h2>Live flip calculator</h2></div>
            <p className="sub">Enter the rates you read in-game. This is your source of truth — instant, offline, gold-aware. Leave the Chaos row blank for a plain Ex/Div flip.</p>
            <div className="r2">
              <Field label="1 Divine = ? Exalted" value={settings.cDiv} onChange={(v) => setField('cDiv', v)} />
              <Field label="Units to flip" value={settings.cUnits} onChange={(v) => setField('cUnits', v)} />
            </div>
            <div className="r2">
              <Field label="Item price in Exalted" labelClass="exalted" value={settings.cIE} onChange={(v) => setField('cIE', v)} />
              <Field label="Item price in Divine" labelClass="divine" value={settings.cID} onChange={(v) => setField('cID', v)} />
            </div>
            <div className="r2">
              <Field label="1 Chaos = ? Exalted" labelClass="chaos" value={settings.cCha} onChange={(v) => setField('cCha', v)} />
              <Field label="Item price in Chaos (optional)" labelClass="chaos" value={settings.cICha} onChange={(v) => setField('cICha', v)} />
            </div>
            {calc ? (
              <div className="verdict">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div className={`verbig ${calc.perUnit > 0 ? 'profit' : 'loss'}`}>
                    {calc.marginPct > 0 ? '+' : ''}{fmt(calc.marginPct)}%
                    <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}> / loop</span>
                  </div>
                  <span className={`dir sell-${calc.sellCur}`}>{CUR[calc.buyCur].label} → Item → {CUR[calc.sellCur].label}</span>
                </div>
                <p style={{ margin: '10px 0 14px', fontSize: 13.5 }}>
                  Buy item with <b className={CUR[calc.buyCur].cls}>{CUR[calc.buyCur].name}</b> → sell for{' '}
                  <b className={CUR[calc.sellCur].cls}>{CUR[calc.sellCur].name}</b> → convert back to Exalted
                </p>
                {calc.vals.ex != null && <KV k="Value via Exalted market"><span className="num">{fmt(calc.vals.ex)} <span className="exalted">ex</span></span></KV>}
                {calc.vals.div != null && <KV k="Value via Divine market"><span className="num">{fmt(calc.vals.div)} <span className="exalted">ex</span> <span className="muted">({fmt(num(settings.cID), 3)} div)</span></span></KV>}
                {calc.vals.cha != null && <KV k="Value via Chaos market"><span className="num">{fmt(calc.vals.cha)} <span className="exalted">ex</span> <span className="muted">({fmt(num(settings.cICha), 3)} cha)</span></span></KV>}
                <KV k="Profit / unit (pre-gold)"><span className={`num ${calc.perUnit > 0 ? 'profit' : 'loss'}`}>{fmt(calc.perUnit)} ex</span></KV>
                <KV k={`Gross profit · ${fmt(calc.units, 0)} units`}><span className={`num ${calc.perUnit > 0 ? 'profit' : 'loss'}`}>{fmt(calc.grossTotal)} ex ({fmt(calc.grossTotal / calc.dd, 2)} div)</span></KV>
                <KV k="Est. gold cost"><span className="num">{fmt(calc.goldTotal, 0)} gold</span></KV>
                <KV k="Profit / 1000 gold"><span className={`num ${calc.perUnit > 0 ? 'profit' : 'loss'}`}>{fmt(calc.profitPerGold * 1000)} ex</span></KV>
                {calc.marginPct < 1 && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                    ⚠ Thin margin — spread, rounding &amp; gold can erase it. Re-check the live rates.
                  </p>
                )}
              </div>
            ) : (
              <div className="verdict"><span className="loss">Enter the Divine rate and both item prices.</span></div>
            )}
          </div>

          <div>
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="ch"><h2>Your capital</h2></div>
              <div className="r2">
                <Field label="Divine orbs" labelClass="divine" value={settings.capDiv} onChange={(v) => setField('capDiv', v)} />
                <Field label="Exalted orbs" labelClass="exalted" value={settings.capEx} onChange={(v) => setField('capEx', v)} />
              </div>
              <p className="sub" style={{ margin: '10px 0 0' }}>
                Rankings assume unlimited capital. These only drive the “units / total @ capital” figures shown when you expand a flip.
              </p>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="ch"><h2>Gold model</h2></div>
              <Field label="Gold per unit traded (per loop)" value={settings.goldPerUnit} onChange={(v) => setField('goldPerUnit', v)} />
              <details>
                <summary>Calibrate from a real trade</summary>
                <div className="r2" style={{ marginTop: 8 }}>
                  <div><label>Units traded</label><input type="number" placeholder="50" value={calUnits} onChange={(e) => setCalUnits(e.target.value)} /></div>
                  <div><label>Gold it cost</label><input type="number" placeholder="17500" value={calGold} onChange={(e) => setCalGold(e.target.value)} /></div>
                </div>
                <button className="btn sec" style={{ marginTop: 10 }} onClick={calibrate}>Set gold/unit</button>
              </details>
            </div>

            <div className="card">
              <div className="ch"><h2>Scan settings</h2></div>
              <label>League (current snapshot · Live Worker query)</label>
              <select value={settings.league} onChange={(e) => setField('league', e.target.value)}>
                {leagueOptions.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <label>Live Worker URL (VITE_LIVE_URL override)</label>
              <input placeholder="https://divineflip-proxy.<you>.workers.dev" value={settings.liveUrl} onChange={(e) => setField('liveUrl', e.target.value)} />
              <div className="r2">
                <Field label="Min % margin" value={settings.minMargin} onChange={(v) => setField('minMargin', v)} step="0.5" />
                <Field label="Min volume" value={settings.minVol} onChange={(v) => setField('minVol', v)} step="10" />
              </div>
              <p className="sub" style={{ margin: '10px 0 0' }}>
                Search, direction, category and the min sliders live in the “Best flips to hunt” controls bar above.
              </p>
              <details style={{ marginTop: 12 }}>
                <summary>Diagnostics / manual paste</summary>
                {snapshot && (
                  <pre style={{ marginTop: 8 }}>
{`source:   ${snapshot.source}
league:   ${snapshot.league}
divine:   ${snapshot.divinePrice} ex
updated:  ${snapshot.updated}
items:    ${snapshot.items.length}
sample:   ${JSON.stringify(snapshot.items[0] || {}, null, 0)}`}
                  </pre>
                )}
                <p className="sub" style={{ margin: '8px 0' }}>
                  Paste a DivineFlip snapshot, or a raw poe2scout currency JSON, and Parse.
                </p>
                <textarea placeholder="paste JSON…" value={rawJson} onChange={(e) => setRawJson(e.target.value)} />
                <button className="btn sec" style={{ marginTop: 8 }} onClick={parsePasted}>Parse pasted JSON</button>
              </details>
            </div>
          </div>
        </div>

        <div className="foot">
          DivineFlip · personal analysis tool · data via <a href="https://poe2scout.com" target="_blank" rel="noopener noreferrer">poe2scout</a>.<br />
          Not affiliated with or endorsed by Grinding Gear Games. The live in-game rate in the calculator is always the source of truth.
        </div>
      </div>

      <GuideDrawer open={guideOpen} onClose={() => setGuideOpen(false)} />
    </>
  );
}

function Stat({ label, children, small }) {
  return (
    <div className="stat">
      <div className="lbl">{label}</div>
      <div className="val" style={small ? { fontSize: 13 } : undefined}>{children}</div>
    </div>
  );
}
function Field({ label, labelClass, value, onChange, step }) {
  return (
    <div>
      <label className={labelClass}>{label}</label>
      <input type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
function KV({ k, children }) {
  return <div className="kv"><span className="k">{k}</span>{children}</div>;
}
// One-line multi-unit rate, e.g. "200 ex · 9.1 cha". parts = [[value, unit, colorClass]|null, ...]
function Rate({ parts }) {
  const items = parts.filter(Boolean);
  return (
    <>
      {items.map(([val, unit, cls], i) => (
        <React.Fragment key={unit}>
          {i > 0 && <span className="faint" style={{ fontSize: 11 }}>{' · '}</span>}
          <span className={`num ${cls}`}>{val}</span>{' '}
          <span className={cls} style={{ fontSize: 11 }}>{unit}</span>
        </React.Fragment>
      ))}
    </>
  );
}
// Timeframes sliced from the hourly rate history (oldest -> newest).
const RATE_WINDOWS = [{ label: '7d', n: 168 }, { label: '1d', n: 24 }, { label: '6h', n: 6 }];

// One timeframe: label, % change over the window, and a mini price sparkline.
function MiniChart({ label, data }) {
  const chg = data.length > 1 ? (data[data.length - 1] / data[0] - 1) * 100 : 0;
  return (
    <div className="rt-chart">
      <div className="rt-chart-top">
        <span className="rt-tf">{label}</span>
        <span className={`rt-chg num ${chg >= 0 ? 'profit' : 'loss'}`}>{chg >= 0 ? '+' : ''}{fmt(chg, 1)}%</span>
      </div>
      <Sparkline data={data} w={86} h={26} />
    </div>
  );
}

// Base-currency tile: value in exalted + 7d / 1d / 6h price-history graphs (hourly source).
function RateTile({ cur, valEx, hist, note }) {
  const c = CUR[cur];
  const has = Array.isArray(hist) && hist.length > 1;
  return (
    <div className={`rate-tile sell-${cur}`}>
      <div className="rt-head">
        <span className={`rt-name ${c.cls}`}>1 {c.name}</span>
        <span className="rt-val num">
          {valEx === 1 ? '1.00' : fmt(valEx, valEx < 10 ? 2 : 0)} <span className="exalted">ex</span>
        </span>
      </div>
      {has ? (
        <div className="rt-charts">
          {RATE_WINDOWS.map((w) => {
            const data = hist.slice(-w.n);
            return data.length > 1 ? <MiniChart key={w.label} label={w.label} data={data} /> : null;
          })}
        </div>
      ) : (
        <div className="rt-note muted">{note || 'history unavailable'}</div>
      )}
    </div>
  );
}

// Shared expanded detail: the full number breakdown + a plain-English explainer.
// Used by both the TOP FLIPS cards and the "Best flips to hunt" table rows.
function FlipDetail({ r, d, ch, goldPerUnit, onSend, onGuide }) {
  const pc = r.perUnit > 0 ? 'profit' : '';
  const buy = CUR[r.buyCur], sell = CUR[r.sellCur];
  const buyPrice = r.buyValEx; // ex you pay for one unit on the cheap book
  const sellPrice = r.sellValEx; // ex one unit is worth on the rich book
  // Per-market value-in-ex (only the markets this item actually has a book on).
  const markets = [
    { cur: 'ex', valEx: r.ex, native: r.ex, unit: 'ex' },
    { cur: 'div', valEx: r.div != null ? r.div * d : null, native: r.div, unit: 'div' },
    { cur: 'cha', valEx: r.cha != null ? r.cha * ch : null, native: r.cha, unit: 'cha' },
  ].filter((m) => m.valEx != null);
  // Step-by-step playbook amounts (per 1 item; you start and end holding the SELL currency).
  const CUR_EX = { ex: 1, div: d, cha: ch }; // 1 unit of each currency, in exalted
  const NATIVE = { ex: r.ex, div: r.div, cha: r.cha }; // item's price in each currency
  const buyN = NATIVE[r.buyCur]; // units of buy currency to buy 1 item
  const sellN = NATIVE[r.sellCur]; // units of sell currency you receive for 1 item
  const fundS = CUR_EX[r.sellCur] ? r.buyValEx / CUR_EX[r.sellCur] : null; // sell-cur spent to fund the buy
  const netS = CUR_EX[r.sellCur] ? r.perUnit / CUR_EX[r.sellCur] : null; // net sell-cur gained per item
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  return (
    <div className="fd">
      <div className="rd-grid">
        {markets.map((m) => (
          <KV key={m.cur} k={<>Value via <b className={CUR[m.cur].cls}>{CUR[m.cur].label}</b> market{m.cur === r.buyCur ? ' · buy' : m.cur === r.sellCur ? ' · sell' : ''}</>}>
            <span className="num">{fmt(m.valEx)} <span className="exalted">ex</span>{m.cur !== 'ex' && <span className="muted"> ({fmt(m.native, 3)} {m.unit})</span>}</span>
          </KV>
        ))}
        <KV k="Profit / unit"><span className={`num ${pc}`}>{fmt(r.perUnit)} ex</span></KV>
        <KV k={`Realistic total · clear ~${fmt(r.vol, 0)} units`}><span className={`num ${pc}`}>{fmt(r.realisticTotal, 0)} ex</span></KV>
        <KV k="Profit / 1000 gold"><span className={`num ${pc}`}>{fmt(r.ppg * 1000)} ex</span></KV>
        <KV k="Est. gold to clear book"><span className="num">{fmt(goldPerUnit * r.vol, 0)} gold</span></KV>
        <KV k="Volume / hour"><span className="num">{r.vph != null ? `${fmt(r.vph, 0)}/h` : '—'}</span></KV>
        <KV k="Two-way liquidity">{r.twoWay
          ? <span className="num profit">✓ {fmt(r.recvVol, 0)} vol</span>
          : <span className="num loss">✗ one-way</span>}</KV>
        <KV k="Units @ your capital"><span className="num">{fmt(r.units, 0)}</span></KV>
        <KV k="Total @ your capital"><span className={`num ${pc}`}>{fmt(r.totalProfit, 0)} ex</span></KV>
      </div>

      {r.hasEdge && (
        <div className="playbook">
          <div className="plain-h">How to run this loop — you start &amp; end holding <b className={sell.cls}>{sell.name}</b></div>
          <ol className="steps">
            <li>
              <span className="step-n">1</span>
              Convert ~<span className={`num ${sell.cls}`}>{fmt(fundS)}</span> <b className={sell.cls}>{sell.name}</b>
              {' → '}~<span className={`num ${buy.cls}`}>{fmt(buyN)}</span> <b className={buy.cls}>{buy.name}</b>
              <span className="muted"> (your buy funds)</span>
            </li>
            <li>
              <span className="step-n">2</span>
              Buy <b>1 {r.name}</b> with ~<span className={`num ${buy.cls}`}>{fmt(buyN)}</span> <b className={buy.cls}>{buy.name}</b>
              <span className="muted"> (≈{fmt(r.buyValEx)} ex)</span>
            </li>
            <li>
              <span className="step-n">3</span>
              Sell <b>1 {r.name}</b> for ~<span className={`num ${sell.cls}`}>{fmt(sellN)}</span> <b className={sell.cls}>{sell.name}</b>
              <span className="muted"> (≈{fmt(r.sellValEx)} ex)</span>
            </li>
            <li className="step-result">
              <span className="step-n">✓</span>
              Net <span className="num profit">+{fmt(netS)}</span> <b className={sell.cls}>{sell.name}</b>
              <span className="muted"> (≈{fmt(r.perUnit)} ex)</span> per loop, minus ~<span className="num">{fmt(goldPerUnit, 0)}</span> gold in fees
            </li>
          </ol>
          <div className="pb-scale muted">
            At your capital: ~<span className="num">{fmt(r.units, 0)}</span> loops → ~<span className="num profit">{fmt(r.totalProfit, 0)}</span> ex
            for ~<span className="num">{fmt(goldPerUnit * r.units, 0)}</span> gold. Clearing the whole ~{fmt(r.vol, 0)}-unit book ≈{' '}
            <span className="num profit">{fmt(r.realisticTotal, 0)}</span> ex for ~<span className="num">{fmt(goldPerUnit * r.vol, 0)}</span> gold.
          </div>
        </div>
      )}

      {r.spark && (
        <div className="fd-spark">
          <span className="plain-h">7-day price (ex)</span>
          <Sparkline data={r.spark} w={180} h={36} />
          <span className="muted" style={{ fontSize: 11 }}>{fmt(r.spark[0])} → {fmt(r.spark[r.spark.length - 1])} ex</span>
        </div>
      )}

      <div className="plain">
        <div className="plain-h">What these numbers mean</div>
        <ul>
          <li>
            <b>The play:</b> buy 1 <b>{r.name}</b> on the <b className={buy.cls}>{buy.name}</b> market
            for ~<span className="num">{fmt(buyPrice)}</span> ex, then sell it on the <b className={sell.cls}>{sell.name}</b>{' '}
            market for ~<span className="num">{fmt(sellPrice)}</span> ex. You keep the gap.
          </li>
          <li>
            <b>Two-way liquidity {r.twoWay ? '✓' : '✗'}</b> — {r.twoWay
              ? <>the <b className={sell.cls}>{sell.name}</b> book has real stock ({fmt(r.recvStock)}) and volume ({fmt(r.recvVol, 0)}) to sell into, so the loop actually closes.</>
              : <>the <b className={sell.cls}>{sell.name}</b> book shows little/no stock to sell into — this edge may be <i>one-way</i> (you can buy but not sell back). Treat it with caution.</>}
          </li>
          <li><b>Margin {fmt(r.marginPct)}%</b> — your pile of ex grows this much every time you complete one full loop (before gold fees).</li>
          <li><b>Profit/flip {fmt(r.perUnit)} ex</b> — what you net for pushing a single unit through the loop.</li>
          <li><b>Volume {fmt(r.vol, 0)}{r.vph != null ? ` · ~${fmt(r.vph, 0)}/h` : ''}</b> — units recently traded on the thinner book{r.vph != null ? ', and the approximate trades per hour (from snapshot deltas)' : ''}. Higher = your buy/sell orders actually get filled; low volume = you may sit unfilled.</li>
          <li><b>Realistic total {fmt(r.realisticTotal, 0)} ex</b> — profit <i>if</i> you flipped every one of the ~{fmt(r.vol, 0)} units on the book. You won't clear it all (prices move, orders run dry) — treat it as a ceiling, not a promise.</li>
          <li><b>Profit / 1000 gold {fmt(r.ppg * 1000)} ex</b> — the exchange charges gold per trade; this is the ex you earn per 1,000 gold of fees. Higher = more gold-efficient.</li>
          <li><b>@ your capital</b> — with the orbs you entered in Settings → Your capital you can run ~<span className="num">{fmt(r.units, 0)}</span> loops now for ~<span className="num">{fmt(r.totalProfit, 0)}</span> ex. This is just a personal figure — it never affects the ranking.</li>
        </ul>
        <p className="plain-warn">⚠ Markets move and the snapshot can be up to ~30 min old. Confirm both live rates in the calculator before you trade.</p>
      </div>

      <div className="rd-actions">
        <button className="btn sec" onClick={stop(onSend)}>Send to calculator</button>
        <button className="btn sec" onClick={stop(onGuide)}>How to read this →</button>
      </div>
    </div>
  );
}

// Right-hand slideout: a worked example of how to read & act on a flip, using the
// Omen of Light numbers from the screenshot. Static, illustrative data on purpose.
function GuideDrawer({ open, onClose }) {
  const EX = [
    ['Action', 'Buy Ex→Div'],
    ['Margin %', '17.02%'],
    ['Profit / flip', '200.8 ex'],
    ['Volume', '1,471'],
    ['Value via Exalted market', '1,179.83 ex'],
    ['Value via Divine market', '1,380.63 ex (6.888 div)'],
    ['Profit / unit', '200.8 ex'],
    ['Realistic total · clear ~1,471 units', '295,379 ex'],
    ['Profit / 1000 gold', '573.72 ex'],
    ['Est. gold to clear book', '514,850 gold'],
    ['Units @ your capital', '5'],
    ['Total @ your capital', '1,004 ex'],
  ];
  return (
    <>
      <div className={`drawer-backdrop${open ? ' open' : ''}`} onClick={onClose} />
      <aside className={`drawer${open ? ' open' : ''}`} role="dialog" aria-modal="true" aria-label="How to read a flip" aria-hidden={!open}>
        <div className="drawer-head">
          <h2>How to read a flip</h2>
          <button className="drawer-close" onClick={onClose} aria-label="Close guide">✕</button>
        </div>
        <div className="drawer-body">
          <div className="guide-note">
            <b>Worked example — Omen of Light.</b> The numbers below are <b>illustrative example data</b> (not a live quote).
            Your real values will differ — and are usually smaller — but the way you read and act on them is exactly the same.
          </div>

          <h3>1 · Why the edge exists</h3>
          <p>
            The in-game Currency Exchange runs a <b>separate order book for every pair</b>. So one item has a price vs{' '}
            <b className="exalted">Exalted</b>, vs <b className="divine">Divine</b> <i>and</i> vs <b className="chaos">Chaos</b> —
            each can drift apart. DivineFlip compares all three and picks the play that <b>buys on the cheapest market and
            sells on the richest</b>; that gap is the whole game.
          </p>
          <p>
            One catch: a price gap is only tradeable if the market you sell <i>into</i> actually has currency on offer. A{' '}
            <span className="twoway">✓</span> means the sell side is <b>two-way liquid</b> (real stock + volume to fill your
            order); a <span className="oneway">✗</span> means it's <b>one-way</b> — you could buy but get stuck unable to sell
            back. Top flips only ever show two-way edges.
          </p>

          <h3>2 · The example row</h3>
          <div className="guide-row">
            {EX.map(([k, v]) => (
              <div className="kv" key={k}><span className="k">{k}</span><span className="num">{v}</span></div>
            ))}
          </div>

          <h3>3 · What each number tells you</h3>
          <ul className="guide-list">
            <li><b>Action — Buy Ex→Div.</b> The loop direction. Here: spend <b className="exalted">Exalted</b> to buy the Omen, sell the Omen for <b className="divine">Divine</b>, convert that Divine back to Exalted. (A <span className="dir rev">Buy Div→Ex</span> row runs the opposite way.)</li>
            <li><b>Value via Exalted market — 1,179.83 ex.</b> What one Omen costs on the Exalted book. This is your <b>buy price</b>.</li>
            <li><b>Value via Divine market — 1,380.63 ex (6.888 div).</b> What one Omen is worth on the Divine book, shown in ex. This is your effective <b>sell price</b> after converting the Divine back to Exalted.</li>
            <li><b>Margin % — 17.02%.</b> The sell value is 17% above the buy cost, so your ex stack grows ~17% per completed loop (before gold).</li>
            <li><b>Profit / flip — 200.8 ex.</b> The ex you net on a single unit: 1,380.63 − 1,179.83.</li>
            <li><b>Volume — 1,471.</b> How many units recently traded on the thinner book. High volume = your orders fill fast; thin volume = you may not get filled at the shown price.</li>
            <li><b>Realistic total — 295,379 ex (clear ~1,471 units).</b> Profit if you flipped the <i>entire</i> book (200.8 × 1,471). A ceiling — in practice prices move and the book empties before you clear it.</li>
            <li><b>Profit / 1000 gold — 573.72 ex.</b> The exchange burns gold per trade. This is your ex earned per 1,000 gold of fees — a gold-efficiency score.</li>
            <li><b>Est. gold to clear book — 514,850 gold.</b> The gold you'd spend in fees to flip all ~1,471 units. Make sure you actually have the gold.</li>
            <li><b>Units / Total @ your capital — 5 · 1,004 ex.</b> Based on the orbs you typed into Settings → Your capital: how many loops you can afford <i>right now</i> and the ex that yields. Purely personal — it never changes the ranking.</li>
          </ul>

          <h3>4 · How to actually trade it</h3>
          <ol className="guide-list">
            <li>Open the in-game <b>Currency Exchange</b> and find the item.</li>
            <li><b>Confirm both live rates yourself</b> and punch them into DivineFlip's calculator — markets move and the snapshot can be ~30 min old, so the live rate is the only source of truth.</li>
            <li>If the edge still holds, run the loop in the shown direction: buy on the cheap book → sell on the rich book → convert back.</li>
            <li><b>Start small</b> to confirm your orders actually fill, then scale up while the gap and the volume hold.</li>
            <li>Re-check often. Arbitrage gaps close fast as others trade the same edge.</li>
          </ol>

          <div className="guide-note">
            ⚠ <b>Reminder:</b> these figures are an example for illustration only. Trade on your own freshly-confirmed numbers, mind the gold cost, and never assume you can clear the whole book.
          </div>
        </div>
      </aside>
    </>
  );
}
