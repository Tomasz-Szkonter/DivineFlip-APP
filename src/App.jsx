import React, { useEffect, useMemo, useState } from 'react';
import { analyze, buildOpportunities, rankOpportunities, topFlips } from './lib/arb.js';

const LS = 'divineflip.react.v1';
const ENV_LIVE_URL = import.meta.env.VITE_LIVE_URL || '';
const SNAPSHOT_URL = `${import.meta.env.BASE_URL}data/snapshot.json`;
// Seed options for the Live-Worker league query (the page itself can't hit /Leagues — CORS).
const KNOWN_LEAGUES = ['Runes of Aldur', 'HC Runes of Aldur', 'Fate of the Vaal', 'Standard', 'Hardcore'];

const DEFAULTS = {
  minMargin: '1.5', minVol: '50',
  capDiv: '30', capEx: '0', goldPerUnit: '350',
  cDiv: '198', cIE: '1380', cID: '7.2', cUnits: '30',
  sortKey: 'score', sortDir: 'desc', search: '', direction: 'all', showImplied: false,
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
      // Migrate only the two stale legacy defaults to the redesigned behavior;
      // any deliberate customization (other sortKey / a non-'0' minVol) is kept.
      if (merged.sortKey === 'ppg') merged.sortKey = 'score';
      if (merged.minVol === '0' || merged.minVol === 0) merged.minVol = '50';
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
  const cat = (o.cat || o.CategoryApiId || o.category || 'currency').toString().toLowerCase();
  const vol = num(o.CurrentQuantity ?? o.vol ?? o.Quantity ?? 0);
  return { name, cat, ex, div, vol };
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

  // persist settings
  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(settings)); } catch { /* ignore */ }
  }, [settings]);

  function applySnapshot(data, live) {
    if (!data || !Array.isArray(data.items)) throw new Error('missing items[]');
    setSnapshot(data);
    if (data.league) setSettings((s) => (s.league ? s : { ...s, league: data.league }));
    const real = data.items.filter((i) => i.div != null).length;
    setStatus({
      msg: `${live ? 'Live' : 'Loaded'}: ${data.items.length} items · ${real} with real divine quotes · `
        + `source "${data.source}" · ${data.league}. Confirm the in-game rate in the calculator before trading.`,
      kind: 'ok',
    });
  }

  async function loadFrom(url, live) {
    setBusy(live ? 'live' : 'refresh');
    setStatus({ msg: live ? 'Fetching live market via Worker…' : 'Loading market snapshot…', kind: 'warn' });
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      applySnapshot(await res.json(), live);
    } catch (e) {
      setStatus({
        msg: `Couldn't load data (${e.message}). The calculator still works — open Diagnostics to paste JSON.`,
        kind: 'err',
      });
    } finally {
      setBusy(null);
    }
  }

  // initial same-origin load
  useEffect(() => { loadFrom(`${SNAPSHOT_URL}?t=${Date.now()}`, false); }, []); // eslint-disable-line

  const refresh = () => loadFrom(`${SNAPSHOT_URL}?t=${Date.now()}`, false);
  const liveNow = () => {
    if (!effectiveLiveUrl) return;
    const q = settings.league ? `${effectiveLiveUrl.includes('?') ? '&' : '?'}league=${encodeURIComponent(settings.league)}` : '';
    loadFrom(effectiveLiveUrl + q, true);
  };

  const d = snapshot ? num(snapshot.divinePrice) : 0;

  const opps = useMemo(() => {
    if (!snapshot) return [];
    const capInEx = num(settings.capEx) + num(settings.capDiv) * d;
    return buildOpportunities(snapshot.items, d, {
      minVol: num(settings.minVol),
      goldPerUnit: num(settings.goldPerUnit),
      capInEx,
    });
  }, [snapshot, d, settings.capEx, settings.capDiv, settings.minVol, settings.goldPerUnit]);

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
    // Implied rows (~0% by construction) are gated on the toggle + volume floor
    // only — never on min-margin, or the toggle would be a no-op.
    if (!o.hasRealDiv) return settings.showImplied;
    if (o.marginPct < num(settings.minMargin)) return false;
    if (settings.direction === 'fwd' && !o.forward) return false;
    if (settings.direction === 'rev' && o.forward) return false;
    const q = settings.search.trim().toLowerCase();
    if (q && !o.name.toLowerCase().includes(q)) return false;
    return true;
  };

  const view = useMemo(
    () => rankOpportunities(opps.filter(passesFilters), settings.sortKey, { limit: 60, dir: settings.sortDir }),
    [opps, settings.cats, settings.showImplied, settings.minMargin, settings.direction, settings.search, settings.sortKey, settings.sortDir], // eslint-disable-line
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

  const calc = useMemo(() => {
    const dd = num(settings.cDiv), iE = num(settings.cIE), pid = num(settings.cID);
    const units = num(settings.cUnits) || 1, gpu = num(settings.goldPerUnit);
    if (!dd || !iE || !pid) return null;
    return { ...analyze(dd, iE, pid, units, gpu), units, dd };
  }, [settings.cDiv, settings.cIE, settings.cID, settings.cUnits, settings.goldPerUnit]);

  const pickRow = (r) =>
    setSettings((s) => ({ ...s, cIE: String(r6(r.ex)), cID: String(r6(r.div)), cDiv: String(Math.round(d || num(s.cDiv))) }));

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
            <span className="num exalted">{snapshot ? fmt(d, 0) : <span className="skel" />}</span>{' '}
            <span className="exalted" style={{ fontSize: 12 }}>ex</span>
          </Stat>
          <Stat label="1 Exalted">
            <span className="num divine">{d ? fmt(1 / d, 4) : '—'}</span>{' '}
            <span className="divine" style={{ fontSize: 12 }}>div</span>
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
                const iDx = f.div * d;
                const open = openFlip === f.name;
                return (
                  <div key={f.name} className={`flipcard ${f.forward ? 'fwd' : 'rev'}${open ? ' open' : ''}`} onClick={() => toggleFlip(f.name)} title="Click for the full breakdown">
                    <div className="fc-top">
                      <span className="iname">{f.name}</span>
                      <span className="cat">{f.cat || '—'}</span>
                      <span className={`chev${open ? ' open' : ''}`} style={{ marginLeft: 'auto' }}>⌄</span>
                    </div>
                    <div className="fc-act">
                      {f.forward
                        ? <>Buy with <b className="exalted">Exalted</b> → Sell for <b className="divine">Divine</b></>
                        : <>Buy with <b className="divine">Divine</b> → Sell for <b className="exalted">Exalted</b></>}
                    </div>
                    <div className="fc-big">
                      <span className="big profit">+{fmt(f.marginPct)}%</span>
                      <span className="fc-per num">{fmt(f.perUnit)} <span className="exalted">ex</span>/flip</span>
                    </div>
                    <div className="fc-real">
                      ≈ <span className="num profit">{fmt(f.realisticTotal, 0)}</span> <span className="exalted">ex</span> if you clear ~{fmt(f.vol, 0)} units
                    </div>
                    <div className="fc-small">
                      <span className="num">{fmt(f.ppg * 1000)}</span> /1k gold · <span className="num">{fmt(num(settings.goldPerUnit), 0)}</span> gold/flip
                      {' · '}ex <span className="num">{fmt(f.ex)}</span> · div-mkt <span className="num">{fmt(iDx)}</span>
                    </div>
                    {open && (
                      <div className="fc-expand" onClick={(e) => e.stopPropagation()}>
                        <FlipDetail
                          r={f} d={d} goldPerUnit={num(settings.goldPerUnit)}
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
            Search, filter and sort the full book. Rows marked <span className="pill">implied</span> have no independent
            Divine book (≈0%) and are hidden until you toggle them on. Click any row for the full breakdown, then confirm
            the live in-game rate in the calculator before you trade.
          </p>

          <div className="controls">
            <input
              className="search" type="text" placeholder="Search item…"
              value={settings.search} onChange={(e) => setField('search', e.target.value)}
            />
            <select value={settings.direction} onChange={(e) => setField('direction', e.target.value)} title="Loop direction">
              <option value="all">All directions</option>
              <option value="fwd">Ex → Div</option>
              <option value="rev">Div → Ex</option>
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
                            {!r.hasRealDiv && <span className="pill">implied</span>}
                          </td>
                          <td>{r.forward
                            ? <span className="dir fwd">Buy Ex→Div</span>
                            : <span className="dir rev">Buy Div→Ex</span>}</td>
                          <td className={`num ${pc}`}>{fmt(r.marginPct)}%</td>
                          <td className={`num ${pc}`}>{fmt(r.perUnit)} <span className="exalted">ex</span></td>
                          <td className="num">
                            <div className="volcell">
                              <span>{fmt(r.vol, 0)}</span>
                              <div className="bar"><i style={{ width: `${Math.max(4, (r.vol / maxVol) * 100)}%`, background: 'var(--purple)' }} /></div>
                            </div>
                          </td>
                          <td className="chevcell"><span className={`chev${open ? ' open' : ''}`}>⌄</span></td>
                        </tr>
                        {open && (
                          <tr className="rowdetail">
                            <td colSpan={7}>
                              <FlipDetail
                                r={r} d={d} goldPerUnit={num(settings.goldPerUnit)}
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
            <p className="sub">Enter the two rates you read in-game. This is your source of truth — instant, offline, gold-aware.</p>
            <div className="r2">
              <Field label="1 Divine = ? Exalted" value={settings.cDiv} onChange={(v) => setField('cDiv', v)} />
              <Field label="Units to flip" value={settings.cUnits} onChange={(v) => setField('cUnits', v)} />
            </div>
            <div className="r2">
              <Field label="Item price in Exalted" labelClass="exalted" value={settings.cIE} onChange={(v) => setField('cIE', v)} />
              <Field label="Item price in Divine" labelClass="divine" value={settings.cID} onChange={(v) => setField('cID', v)} />
            </div>
            {calc ? (
              <div className="verdict">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div className={`verbig ${calc.perUnit > 0 ? 'profit' : 'loss'}`}>
                    {calc.marginPct > 0 ? '+' : ''}{fmt(calc.marginPct)}%
                    <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}> / loop</span>
                  </div>
                  {calc.forward
                    ? <span className="dir fwd">Ex → Item → Div</span>
                    : <span className="dir rev">Div → Item → Ex</span>}
                </div>
                <p style={{ margin: '10px 0 14px', fontSize: 13.5 }}>
                  {calc.forward
                    ? <>Buy item with <b className="exalted">Exalted</b> → sell for <b className="divine">Divine</b> → convert back to Exalted</>
                    : <>Buy item with <b className="divine">Divine</b> → sell for <b className="exalted">Exalted</b></>}
                </p>
                <KV k="Value via Exalted market"><span className="num">{fmt(calc.iE)} <span className="exalted">ex</span></span></KV>
                <KV k="Value via Divine market"><span className="num">{fmt(calc.iDx)} <span className="exalted">ex</span> <span className="muted">({fmt(calc.pItemDiv, 3)} div)</span></span></KV>
                <KV k="Profit / unit (pre-gold)"><span className={`num ${calc.perUnit > 0 ? 'profit' : 'loss'}`}>{fmt(calc.perUnit)} ex</span></KV>
                <KV k={`Gross profit · ${fmt(calc.units, 0)} units`}><span className={`num ${calc.perUnit > 0 ? 'profit' : 'loss'}`}>{fmt(calc.grossTotal)} ex ({fmt(calc.grossTotal / calc.dd, 2)} div)</span></KV>
                <KV k="Est. gold cost"><span className="num">{fmt(calc.goldTotal, 0)} gold</span></KV>
                <KV k="Profit / 1000 gold"><span className={`num ${calc.perUnit > 0 ? 'profit' : 'loss'}`}>{fmt(calc.profitPerGold * 1000)} ex</span></KV>
                {calc.marginPct < 1 && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                    ⚠ Thin margin — spread, rounding &amp; gold can erase it. Re-check both live rates.
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

// Shared expanded detail: the full number breakdown + a plain-English explainer.
// Used by both the TOP FLIPS cards and the "Best flips to hunt" table rows.
function FlipDetail({ r, d, goldPerUnit, onSend, onGuide }) {
  const pc = r.perUnit > 0 ? 'profit' : '';
  const iDx = r.div * d;
  const buyCur = r.forward ? 'Exalted' : 'Divine';
  const sellCur = r.forward ? 'Divine' : 'Exalted';
  const buyPrice = r.forward ? r.ex : iDx; // ex you pay for one unit on the cheap book
  const sellPrice = r.forward ? iDx : r.ex; // ex one unit is worth on the rich book
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  return (
    <div className="fd">
      <div className="rd-grid">
        <KV k="Value via Exalted market"><span className="num">{fmt(r.ex)} <span className="exalted">ex</span></span></KV>
        <KV k="Value via Divine market"><span className="num">{fmt(iDx)} <span className="exalted">ex</span> <span className="muted">({fmt(r.div, 3)} div)</span></span></KV>
        <KV k="Profit / unit"><span className={`num ${pc}`}>{fmt(r.perUnit)} ex</span></KV>
        <KV k={`Realistic total · clear ~${fmt(r.vol, 0)} units`}><span className={`num ${pc}`}>{fmt(r.realisticTotal, 0)} ex</span></KV>
        <KV k="Profit / 1000 gold"><span className={`num ${pc}`}>{fmt(r.ppg * 1000)} ex</span></KV>
        <KV k="Est. gold to clear book"><span className="num">{fmt(goldPerUnit * r.vol, 0)} gold</span></KV>
        <KV k="Units @ your capital"><span className="num">{fmt(r.units, 0)}</span></KV>
        <KV k="Total @ your capital"><span className={`num ${pc}`}>{fmt(r.totalProfit, 0)} ex</span></KV>
      </div>

      <div className="plain">
        <div className="plain-h">What these numbers mean</div>
        <ul>
          <li>
            <b>The play:</b> buy 1 <b>{r.name}</b> on the <b className={r.forward ? 'exalted' : 'divine'}>{buyCur}</b> market
            for ~<span className="num">{fmt(buyPrice)}</span> ex, then sell it on the <b className={r.forward ? 'divine' : 'exalted'}>{sellCur}</b>{' '}
            market for ~<span className="num">{fmt(sellPrice)}</span> ex. You keep the gap.
          </li>
          <li><b>Margin {fmt(r.marginPct)}%</b> — your pile of ex grows this much every time you complete one full loop (before gold fees).</li>
          <li><b>Profit/flip {fmt(r.perUnit)} ex</b> — what you net for pushing a single unit through the loop.</li>
          <li><b>Volume {fmt(r.vol, 0)}</b> — units recently traded on the thinner book. Higher = your buy/sell orders actually get filled; low volume = you may sit unfilled.</li>
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
            <b className="exalted">Exalted</b> and a <i>different</i> price vs <b className="divine">Divine</b>. When those two
            drift apart, you can loop between them and end with more orbs than you started — that gap is the whole game.
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
