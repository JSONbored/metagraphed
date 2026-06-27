// metagraphed data Worker — Postgres-backed serving via Cloudflare Hyperdrive.
//
// Kept SEPARATE from the main api.mjs Worker (which is near its bundle budget): the
// postgres.js driver + the growing Postgres-backed read surface live here, and the
// main Worker routes the relevant paths in via a service binding (DATA_API). This is
// the serving half of ADR 0013 — the indexer + Rust backfill write the rich Postgres
// tiers (chain_events / deep history); this exposes them to the public API.
//
// READ-ONLY. Every query is parameterized (postgres.js tagged templates). The
// connection is opened per request through Hyperdrive (pooled + edge-cached) and
// closed via ctx.waitUntil so it never blocks the response.
import postgres from "postgres";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=10",
    },
  });
}

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET")
      return json({ error: "method not allowed" }, 405);
    if (!env.HYPERDRIVE?.connectionString) {
      return json({ error: "hyperdrive binding unavailable" }, 503);
    }

    // `prepare: false` + `fetch_types: false` are the Hyperdrive-recommended settings:
    // they avoid per-connection type-introspection round-trips and prepared-statement
    // state that don't survive the pooler. max:5 keeps us within the origin limit.
    const sql = postgres(env.HYPERDRIVE.connectionString, {
      max: 5,
      prepare: false,
      fetch_types: false,
      idle_timeout: 10,
    });

    try {
      // GET /api/v1/blocks/:n/chain-events — EVERY event in a block (the all-events
      // tier). Distinct from the existing /blocks/:ref/events (curated, D1, #1852).
      const block = url.pathname.match(
        /^\/api\/v1\/blocks\/(\d+)\/chain-events$/,
      );
      if (block) {
        const bn = Number(block[1]);
        const rows = await sql`
          SELECT event_index, pallet, method, args, phase, extrinsic_index, observed_at
          FROM chain_events
          WHERE block_number = ${bn}
          ORDER BY event_index ASC`;
        return json({ block_number: bn, count: rows.length, events: rows });
      }

      // GET /api/v1/chain-events?pallet=&method=&before=&limit= — recent all-events feed.
      if (url.pathname === "/api/v1/chain-events") {
        const limit = clampLimit(url.searchParams.get("limit"));
        const pallet = url.searchParams.get("pallet");
        const method = url.searchParams.get("method");
        const before = url.searchParams.get("before"); // block_number cursor (exclusive)
        const beforeBn =
          before != null && before !== "" ? Number(before) : null;
        const rows = await sql`
          SELECT block_number, event_index, pallet, method, args, phase, extrinsic_index, observed_at
          FROM chain_events
          WHERE TRUE
            ${beforeBn != null && Number.isFinite(beforeBn) ? sql`AND block_number < ${beforeBn}` : sql``}
            ${pallet ? sql`AND pallet = ${pallet}` : sql``}
            ${method ? sql`AND method = ${method}` : sql``}
          ORDER BY block_number DESC, event_index DESC
          LIMIT ${limit}`;
        const next =
          rows.length === limit ? rows[rows.length - 1].block_number : null;
        return json({ count: rows.length, next_before: next, events: rows });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json(
        { error: "data query failed", detail: String(err).slice(0, 200) },
        502,
      );
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }).catch(() => {}));
    }
  },
};
