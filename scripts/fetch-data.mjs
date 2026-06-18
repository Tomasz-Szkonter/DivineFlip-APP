#!/usr/bin/env node
// scripts/fetch-data.mjs
//
// Fetches the live poe2scout market server-side (no CORS in Node) and writes the
// normalized snapshot the deployed page reads same-origin. Run by the
// .github/workflows/update-data.yml cron, or locally via `npm run fetch-data`.
//
// Optional env override: LEAGUE="Runes of Aldur" node scripts/fetch-data.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSnapshot } from '../shared/poe2scout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../public/data/snapshot.json');

async function main() {
  const snapshot = await fetchSnapshot({
    league: process.env.LEAGUE || undefined,
    source: 'github-action',
  });
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  const withDiv = snapshot.items.filter((i) => i.div != null).length;
  console.log(`Wrote ${OUT}`);
  console.log(
    `  league=${snapshot.league}  divinePrice=${snapshot.divinePrice}  ` +
      `items=${snapshot.items.length}  (real divine quote: ${withDiv}, implied: ${
        snapshot.items.length - withDiv
      })`,
  );
}

main().catch((err) => {
  console.error('fetch-data failed:', err);
  process.exit(1);
});
