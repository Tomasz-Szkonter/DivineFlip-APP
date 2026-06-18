// worker/worker.js
//
// Cloudflare Worker that fetches poe2scout server-side (no CORS there) and returns the
// SAME normalized snapshot the GitHub Action produces, but with
// `Access-Control-Allow-Origin: *` so the browser "Live now" button can read it.
//
// Shares shared/poe2scout.mjs with scripts/fetch-data.mjs so the logic never diverges.
// Deploy:  cd worker && wrangler deploy   (see README.md)

import { fetchSnapshot } from '../shared/poe2scout.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const league = url.searchParams.get('league') || undefined;

    try {
      const snapshot = await fetchSnapshot({ league, source: 'worker' });
      return new Response(JSON.stringify(snapshot), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          ...CORS,
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
      });
    }
  },
};
