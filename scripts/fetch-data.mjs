#!/usr/bin/env node
// scripts/fetch-data.mjs
//
// Fetches the live poe2scout market server-side (no CORS in Node) and writes the
// normalized snapshot the deployed page reads same-origin. Run by the
// .github/workflows/update-data.yml cron, or locally via `npm run fetch-data`.
//
// Also derives a per-item `vph` (trades per hour) by diffing this snapshot's cumulative
// `vol` + `epoch` against the PREVIOUS committed snapshot — no sidecar needed, the
// committed file is the previous reading.
//
// Optional env override: LEAGUE="Runes of Aldur" node scripts/fetch-data.mjs

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSnapshot } from '../shared/poe2scout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../public/data/snapshot.json');

const round = (n) => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(6)));

// Read the previously committed snapshot, if any, so we can compute volume/h deltas.
async function readPrev() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    return null;
  }
}

// vph = Δ(cumulative volume) / Δhours between consecutive snapshots. Clamped: a missing
// baseline, a non-positive time delta, or a volume reset (negative delta) yields null.
function attachVph(snapshot, prev) {
  if (!prev || prev.epoch == null || snapshot.epoch == null) return;
  const dtHours = (snapshot.epoch - prev.epoch) / 3600;
  if (!(dtHours > 0)) return;
  const prevVol = new Map((prev.items || []).map((i) => [i.name, i.vol]));
  for (const item of snapshot.items) {
    const before = prevVol.get(item.name);
    if (before == null) continue;
    const delta = item.vol - before;
    item.vph = delta > 0 ? round(delta / dtHours) : null;
  }
}

async function main() {
  const prev = await readPrev();
  const snapshot = await fetchSnapshot({
    league: process.env.LEAGUE || undefined,
    source: 'github-action',
    withSpark: true,
  });
  attachVph(snapshot, prev);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  const withDiv = snapshot.items.filter((i) => i.div != null).length;
  const withCha = snapshot.items.filter((i) => i.cha != null).length;
  const withVph = snapshot.items.filter((i) => i.vph != null).length;
  console.log(`Wrote ${OUT}`);
  console.log(
    `  league=${snapshot.league}  divinePrice=${snapshot.divinePrice}  chaosPrice=${snapshot.chaosPrice}  ` +
      `items=${snapshot.items.length}  (real divine: ${withDiv}, chaos book: ${withCha}, ` +
      `vph: ${withVph})`,
  );
}

main().catch((err) => {
  console.error('fetch-data failed:', err);
  process.exit(1);
});
