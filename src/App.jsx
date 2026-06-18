import React, { useEffect, useMemo, useState } from 'react';
import { analyze, buildOpportunities, rankOpportunities } from './lib/arb.js';

const LS = 'divineflip.react.v1';
const ENV_LIVE_URL = import.meta.env.VITE_LIVE_URL || '';
const SNAPSHOT_URL = `${import.meta.env.BASE_URL}data/snapshot.json`;
// Seed options for the Live-Worker league query (the page itself can't hit /Leagues — CORS).
const KNOWN_LEAGUES = ['Runes of Aldur', 'HC Runes of Aldur', 'Fate of the Vaal', 'Standard', 'Hardcore'];

const DEFAULTS = {
  minMargin: '1.5', minVol: '0',
  capDiv: '30', capEx: '0', goldPerUnit: '350',
  cDiv: '198', cIE: '1380', cID: '7.2', cUnits: '30',
  sortKey: 'ppg', league: '', cats: null, liveUrl: ENV_LIVE_URL,
};

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const fmt = (n, d = 2) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const r6 = (n) => (Number.isFinite(Number(n)) ? Number(Number(n).toPrecision(6)) : 0);

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS));
    if (s && typeof s === 'object') return { ...DEFAULTS, ...s };
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

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [snapshot, setSnapshot] = useState(null);
  const [status, setStatus] = useState({ msg: 'Loading live market…', kind: 'warn' });
  const [busy, setBusy] = useState(null); // 'refresh' | 'live' | null
  const [calUnits, setCalUnits] = useState('');
  const [calGold, setCalGold] = useState('');
  const [rawJson, setRawJson] = useState('');

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

  const view = useMemo(() => {
    const filtered = opps.filter((o) => catActive(o.cat));
    return rankOpportunities(filtered, settings.sortKey, { minMargin: num(settings.minMargin), limit: 40 });
  }, [opps, settings.cats, settings.sortKey, settings.minMargin]); // eslint-disable-line

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
  const realArb = view.some((r) => r.hasRealDiv && r.marginPct > 0.01);
  const maxHunt = Math.max(...view.map((r) => r.hunt), 1);

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

        {/* HERO: best flips */}
        <div className="card hero">
          <div className="ch">
            <h2>Best flips to hunt</h2>
            <span className="live">live</span>
            {snapshot && <span className="src">source: {snapshot.source}</span>}
          </div>
          <p className="sub">
            Ranked from the latest snapshot. Rows with a real per-pair Divine quote show a genuine edge; rows marked{' '}
            <span className="pill">implied</span> have no independent Divine book (≈0%). Pick a target, then confirm its
            live in-game rate in the calculator before you trade.
          </p>
          <div className="tabs">
            {[['ppg', 'Profit / gold'], ['margin', '% margin'], ['total', 'Total profit @ capital'], ['liq', 'Liquidity / safety']].map(([k, label]) => (
              <div key={k} className={`tab${settings.sortKey === k ? ' on' : ''}`} data-k={k} onClick={() => setField('sortKey', k)}>
                <span className="ic" />{label}
              </div>
            ))}
          </div>
          <div className="scrollx">
            {!snapshot ? (
              <table><tbody><tr><td className="empty">Pulling snapshot…</td></tr></tbody></table>
            ) : view.length === 0 ? (
              <table><tbody><tr><td className="empty">
                {settings.sortKey !== 'liq'
                  ? <>No gaps above your min margin. Switch to <b style={{ color: 'var(--purple)' }}>Liquidity / safety</b> to find high-volume targets, then verify their live Divine rate in the calculator.</>
                  : 'No items match your filters.'}
              </td></tr></tbody></table>
            ) : settings.sortKey === 'liq' ? (
              <table>
                <thead><tr><th>#</th><th>Item</th><th>Volume</th><th>Price</th><th>Hunt score</th></tr></thead>
                <tbody>
                  {view.map((r, i) => (
                    <tr key={r.name + i} onClick={() => pickRow(r)}>
                      <td className="rank">{i + 1}</td>
                      <td><span className="iname">{r.name}</span><span className="cat">{r.cat || '—'}</span></td>
                      <td className="num">{fmt(r.vol, 0)}</td>
                      <td className="num exalted">{fmt(r.ex)}</td>
                      <td><div className="bar"><i style={{ width: `${Math.max(4, (r.hunt / maxHunt) * 100)}%`, background: 'var(--purple)' }} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table>
                <thead><tr>
                  <th>#</th><th>Item</th><th>Direction</th><th>% margin</th><th>Profit/unit</th>
                  <th>Units @cap</th><th>Total profit</th><th>Profit/1k gold</th><th>Vol</th>
                </tr></thead>
                <tbody>
                  {view.map((r, i) => {
                    const pc = r.perUnit > 0 ? 'profit' : '';
                    return (
                      <tr key={r.name + i} onClick={() => pickRow(r)}>
                        <td className="rank">{i + 1}</td>
                        <td><span className="iname">{r.name}</span>{!r.hasRealDiv && <span className="pill">implied</span>}</td>
                        <td>{r.forward
                          ? <span className="dir fwd">Ex→I→Div</span>
                          : <span className="dir rev">Div→I→Ex</span>}</td>
                        <td className={`num ${pc}`}>{fmt(r.marginPct)}%</td>
                        <td className={`num ${pc}`}>{fmt(r.perUnit)}</td>
                        <td className="num">{fmt(r.units, 0)}</td>
                        <td className={`num ${pc}`}>{fmt(r.totalProfit, 0)} <span className="exalted">ex</span></td>
                        <td className={`num ${pc}`}>{fmt(r.ppg * 1000)}</td>
                        <td className="num muted">{fmt(r.vol, 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {snapshot && view.length > 0 && !realArb && settings.sortKey !== 'liq' && (
            <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
              ℹ These margins are <b>implied</b> from normalized prices — the items shown have no independent Divine book.
              Switch to <b style={{ color: 'var(--purple)' }}>Liquidity / safety</b> to pick targets, then confirm live.
            </p>
          )}
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
              <p className="sub" style={{ margin: '10px 0 0' }}>Drives the “Total profit @ capital” ranking.</p>
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
              <label>Categories</label>
              <div className="chips">
                {allCats.length === 0
                  ? <span className="muted" style={{ fontSize: 12 }}>—</span>
                  : allCats.map((c) => (
                    <span key={c} className={`chip${catActive(c) ? ' on' : ''}`} onClick={() => toggleCat(c)}>{c}</span>
                  ))}
              </div>
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
