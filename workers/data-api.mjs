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
const FILTER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function validEventFilter(value) {
  return value == null || value === "" || FILTER_PATTERN.test(value);
}

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
  // Floor to a minimum of 1 (mirrors clampStatsBlocks): a fractional 0<n<1 floors
  // to 0 otherwise, binding LIMIT 0 and then dereferencing rows[-1] for the cursor.
  return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);
}

function clampStatsBlocks(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1000;
  return Math.min(Math.max(Math.floor(n), 1), 5000);
}

// postgres.js returns BIGINT columns as strings; the D1-backed routes return them
// as numbers. block_number and observed_at are both < 2^53, so Number(...) is
// lossless — coerce them per event row for a consistent numeric API shape.
function numberOrNull(v) {
  return v == null ? null : Number(v);
}
function coerceEvent(row) {
  return {
    ...row,
    ...(row.block_number !== undefined
      ? { block_number: numberOrNull(row.block_number) }
      : {}),
    observed_at: numberOrNull(row.observed_at),
  };
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
      await sql`SET statement_timeout = '3000ms'`;
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
        return json({
          block_number: bn,
          count: rows.length,
          events: rows.map(coerceEvent),
        });
      }

      // GET /api/v1/chain-events?pallet=&method=&block=&extrinsic=&before=&limit=
      // recent all-events feed. block= scopes to one block; block=+extrinsic= scopes to
      // a single extrinsic's emitted events (explorer extrinsic-detail view). Ignore
      // extrinsic without block to avoid an unindexed global extrinsic_index scan.
      if (url.pathname === "/api/v1/chain-events") {
        const limit = clampLimit(url.searchParams.get("limit"));
        const pallet = url.searchParams.get("pallet");
        const method = url.searchParams.get("method");
        if (!validEventFilter(pallet) || !validEventFilter(method)) {
          return json(
            {
              error:
                "pallet and method must be 1-64 ASCII letters, digits, or underscores, starting with a letter",
            },
            400,
          );
        }
        const numParam = (k) => {
          const v = url.searchParams.get(k);
          if (v == null || v === "") return null;
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };
        const blockN = numParam("block");
        const extrN = blockN != null ? numParam("extrinsic") : null;
        const beforeBn = numParam("before"); // block_number cursor (exclusive)
        if (method && !pallet && blockN == null) {
          return json(
            {
              error: "method filter requires pallet unless block is specified",
            },
            400,
          );
        }
        const rows = await sql`
          SELECT block_number, event_index, pallet, method, args, phase, extrinsic_index, observed_at
          FROM chain_events
          WHERE TRUE
            ${blockN != null ? sql`AND block_number = ${blockN}` : sql``}
            ${extrN != null ? sql`AND extrinsic_index = ${extrN}` : sql``}
            ${beforeBn != null ? sql`AND block_number < ${beforeBn}` : sql``}
            ${pallet ? sql`AND pallet = ${pallet}` : sql``}
            ${method ? sql`AND method = ${method}` : sql``}
          ORDER BY block_number DESC, event_index DESC
          LIMIT ${limit}`;
        const next =
          rows.length === limit
            ? numberOrNull(rows[rows.length - 1].block_number)
            : null;
        return json({
          count: rows.length,
          next_before: next,
          events: rows.map(coerceEvent),
        });
      }

      // GET /api/v1/chain-events/stats?blocks=N — chain-activity aggregate: the
      // pallet.method event distribution over the most recent N blocks (default
      // 1000, capped 5000). Bounded window + capped output keep it index-cheap.
      if (url.pathname === "/api/v1/chain-events/stats") {
        const blocks = clampStatsBlocks(url.searchParams.get("blocks"));
        const rows = await sql`
          SELECT pallet, method, count(*)::int AS count
          FROM chain_events
          WHERE block_number > (SELECT max(block_number) FROM chain_events) - ${blocks}
          GROUP BY pallet, method
          ORDER BY count DESC
          LIMIT 100`;
        return json({
          window_blocks: blocks,
          groups: rows.length,
          activity: rows,
        });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      // Log internally (Wrangler observability) but NEVER leak DB error details
      // (schema, table, or connection info) to API clients.
      console.error("data-api query failed:", err);
      return json({ error: "data query failed" }, 502);
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }).catch(() => {}));
    }
  },
};
