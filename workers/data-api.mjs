// metagraphed data Worker — Postgres-backed serving via Cloudflare Hyperdrive.
//
// Kept SEPARATE from the main api.mjs Worker (which is near its bundle budget): the
// postgres.js driver + the growing Postgres-backed read surface live here, and the
// main Worker routes the relevant paths in via a service binding (DATA_API). This is
// the serving half of ADR 0013 — the indexer + Rust backfill write the rich Postgres
// tiers (chain_events / deep history); this exposes them to the public API.
//
// READ-ONLY. Every query is parameterized (postgres.js tagged templates). The
// client is created fresh per request through Hyperdrive (Cloudflare's
// documented pattern -- Hyperdrive itself is the warm connection pool, so
// this is cheap) and every request's queries run inside a single read-only
// sql.begin() transaction for connection affinity (#4686). Hyperdrive cleans
// up the connection automatically when the request ends -- no sql.end().
import postgres from "postgres";
import { decodeCursor, encodeCursor } from "../src/cursor.mjs";
import { buildBlock, buildBlockFeed } from "../src/blocks.mjs";
import { buildExtrinsic, buildExtrinsicFeed } from "../src/extrinsics.mjs";
import {
  buildAccountEvents,
  formatAccountEvent,
} from "../src/account-events.mjs";
import { decodeChainEventArgs } from "../src/chain-event-args.mjs";

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
  if (v == null) return null;
  // Blank Hyperdrive/Postgres cells coerce via Number("") → 0; trim rejects "" /
  // whitespace-only so absent indices/timestamps stay null (mirrors toBlockNumber
  // in src/account-events.mjs and src/blocks.mjs).
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nonNegativeIntegerParam(params, key) {
  const value = params.get(key);
  if (value == null || value === "") return null;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function clampOffset(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const COMPOSITE_REF_RE = /^(\d+)-(\d+)$/;
const MAX_EMBEDDED_EVENTS = 50;

// The blocks/extrinsics SELECT column lists below must match src/blocks.mjs's
// BLOCK_READ_COLUMNS / src/extrinsics.mjs's EXTRINSIC_READ_COLUMNS so
// formatBlock/formatExtrinsic (reused unchanged, imported above) see the exact
// same row shape from either sink. Written literally per query (not factored
// into a shared string) because postgres.js tagged templates bind a `${...}`
// interpolation as a query PARAMETER, not raw SQL -- a column list can't be
// injected that way. extrinsics' call_args is cast to text: Postgres' JSONB
// auto-parses to a JS object via the driver, but formatExtrinsic expects a
// JSON-encoded STRING to JSON.parse, matching D1's TEXT column -- casting here
// keeps that shared formatter untouched rather than teaching it two shapes.

// args (#4685): decode AccountId32 byte arrays to SS58 (or hex for
// non-account/untagged values) before this ever reaches a consumer -- REST
// and the three MCP tools that select `args` (list_chain_events,
// get_block_chain_events, get_extrinsic_chain_events) all route through this
// one function, so there's a single decode point rather than three.
// Unconditional (unlike the block_number guard below): both call sites
// always select `args` in their SQL (chain-events/stats, which doesn't,
// never calls coerceEvent at all) -- and decodeChainEventArgs(undefined)
// resolves to `args: undefined`, which JSON.stringify drops from the
// response the same as an absent key, so there's no schema-shape risk in
// leaving this unconditional.
function coerceEvent(row) {
  return {
    ...row,
    ...(row.block_number !== undefined
      ? { block_number: numberOrNull(row.block_number) }
      : {}),
    args: decodeChainEventArgs(row.args),
    observed_at: numberOrNull(row.observed_at),
  };
}

export default {
  async fetch(request, env, _ctx) {
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
      // sql.begin() reserves ONE physical connection for every query below,
      // including the SET -- Hyperdrive resets session state when a
      // connection is returned to its pool, and a single Worker invocation
      // can be handed different pooled connections across sequential
      // queries, so a bare SET (no transaction) has no guarantee it applies
      // to the query that follows it (Hyperdrive's connection-lifecycle
      // docs; #4686's root cause). "read only" matches this Worker's own
      // READ-ONLY invariant (top of file) at the database level too.
      return await sql.begin("read only", async (sql) => {
        await sql`SET statement_timeout = '3000ms'`;

        // GET /api/v1/blocks (D1 serving-cutover, #4656 followup): the recent-block
        // feed, mirroring src/blocks.mjs's loadBlocks filter set exactly (author,
        // spec_version, block_start/block_end, from/to, min_extrinsics/min_events,
        // cursor). The main Worker only calls this when its per-tier serving flag
        // is on and forwards the SAME request it already validated -- this route
        // trusts well-formed params rather than re-deriving 400s.
        if (url.pathname === "/api/v1/blocks") {
          const limit = clampLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          const cursor = decodeCursor(url.searchParams.get("cursor"), 1);
          const author = url.searchParams.get("author") || null;
          const specVersion = nonNegativeIntegerParam(
            url.searchParams,
            "spec_version",
          );
          const blockStart = nonNegativeIntegerParam(
            url.searchParams,
            "block_start",
          );
          const blockEnd = nonNegativeIntegerParam(
            url.searchParams,
            "block_end",
          );
          const from = nonNegativeIntegerParam(url.searchParams, "from");
          const to = nonNegativeIntegerParam(url.searchParams, "to");
          const minExtrinsics = nonNegativeIntegerParam(
            url.searchParams,
            "min_extrinsics",
          );
          const minEvents = nonNegativeIntegerParam(
            url.searchParams,
            "min_events",
          );
          const rows = await sql`
          SELECT block_number, block_hash, parent_hash, author, extrinsic_count, event_count, spec_version, observed_at
          FROM blocks
          WHERE TRUE
            ${author ? sql`AND author = ${author}` : sql``}
            ${specVersion != null ? sql`AND spec_version = ${specVersion}` : sql``}
            ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
            ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
            ${from != null ? sql`AND observed_at >= ${from}` : sql``}
            ${to != null ? sql`AND observed_at <= ${to}` : sql``}
            ${minExtrinsics != null ? sql`AND extrinsic_count >= ${minExtrinsics}` : sql``}
            ${minEvents != null ? sql`AND event_count >= ${minEvents}` : sql``}
            ${cursor ? sql`AND block_number < ${cursor[0]}` : sql``}
          ORDER BY block_number DESC
          LIMIT ${limit}
          ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([numberOrNull(last.block_number)])
            : null;
          return json(buildBlockFeed(rows, { limit, offset, nextCursor }));
        }

        // GET /api/v1/blocks/:ref — per-block detail + nearest stored neighbors,
        // mirroring src/blocks.mjs's loadBlock. ref is a numeric block_number or a
        // 0x block_hash (lowercased before binding, matching the D1 path's
        // case-insensitivity workaround).
        const blockRef = url.pathname.match(/^\/api\/v1\/blocks\/([^/]+)$/);
        if (blockRef) {
          const ref = decodeURIComponent(blockRef[1]);
          const isHash = HASH_RE.test(ref);
          const blockNumber =
            !isHash && /^\d+$/.test(ref) && Number.isSafeInteger(Number(ref))
              ? Number(ref)
              : null;
          if (!isHash && blockNumber === null) {
            return json(buildBlock(undefined, ref));
          }
          const rows = isHash
            ? await sql`
              SELECT block_number, block_hash, parent_hash, author, extrinsic_count, event_count, spec_version, observed_at
              FROM blocks WHERE block_hash = ${ref.toLowerCase()} LIMIT 1`
            : await sql`
              SELECT block_number, block_hash, parent_hash, author, extrinsic_count, event_count, spec_version, observed_at
              FROM blocks WHERE block_number = ${blockNumber} LIMIT 1`;
          let prev = null;
          let next = null;
          const resolvedNumber = numberOrNull(rows[0]?.block_number);
          if (resolvedNumber != null) {
            const nbr = await sql`
            SELECT
              (SELECT MAX(block_number) FROM blocks WHERE block_number < ${resolvedNumber}) AS prev,
              (SELECT MIN(block_number) FROM blocks WHERE block_number > ${resolvedNumber}) AS next`;
            prev = nbr[0]?.prev ?? null;
            next = nbr[0]?.next ?? null;
          }
          return json(buildBlock(rows[0], ref, { prev, next }));
        }

        // GET /api/v1/extrinsics — the recent-extrinsic feed, mirroring
        // src/extrinsics.mjs's loadExtrinsics filter set exactly (signer,
        // call_module, call_function, call_hash, success, block, block_start/
        // block_end, from/to, cursor). Index selection is left to Postgres'
        // planner (schema.sql's idx_extrinsics_signer_block / idx_extrinsics_call
        // cover the same access patterns D1's INDEXED BY hints targeted) --
        // Postgres has no INDEXED BY equivalent.
        if (url.pathname === "/api/v1/extrinsics") {
          const limit = clampLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          const cursor = decodeCursor(url.searchParams.get("cursor"), 2);
          const block = nonNegativeIntegerParam(url.searchParams, "block");
          const signer = url.searchParams.get("signer") || null;
          const callModule = url.searchParams.get("call_module") || null;
          const callFunction = url.searchParams.get("call_function") || null;
          const callHashRaw = url.searchParams.get("call_hash");
          const callHash =
            callHashRaw && HASH_RE.test(callHashRaw) ? callHashRaw : null;
          const successRaw = url.searchParams.get("success");
          const success =
            successRaw === "true"
              ? true
              : successRaw === "false"
                ? false
                : null;
          const blockStart = nonNegativeIntegerParam(
            url.searchParams,
            "block_start",
          );
          const blockEnd = nonNegativeIntegerParam(
            url.searchParams,
            "block_end",
          );
          const from = nonNegativeIntegerParam(url.searchParams, "from");
          const to = nonNegativeIntegerParam(url.searchParams, "to");
          const rows = await sql`
          SELECT block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args::text AS call_args, success, fee_tao, tip_tao, observed_at
          FROM extrinsics
          WHERE TRUE
            ${block != null ? sql`AND block_number = ${block}` : sql``}
            ${signer ? sql`AND signer = ${signer}` : sql``}
            ${callModule ? sql`AND call_module = ${callModule}` : sql``}
            ${callFunction ? sql`AND call_function = ${callFunction}` : sql``}
            ${callHash ? sql`AND call_args::text LIKE ${'%"' + callHash + '"%'}` : sql``}
            ${success != null ? sql`AND success = ${success}` : sql``}
            ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
            ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
            ${from != null ? sql`AND observed_at >= ${from}` : sql``}
            ${to != null ? sql`AND observed_at <= ${to}` : sql``}
            ${cursor ? sql`AND (block_number, extrinsic_index) < (${cursor[0]}, ${cursor[1]})` : sql``}
          ORDER BY block_number DESC, extrinsic_index DESC
          LIMIT ${limit}
          ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.block_number),
                numberOrNull(last.extrinsic_index),
              ])
            : null;
          return json(buildExtrinsicFeed(rows, { limit, offset, nextCursor }));
        }

        // GET /api/v1/extrinsics/:ref — per-extrinsic detail + embedded
        // account_events (up to MAX_EMBEDDED_EVENTS), mirroring
        // src/extrinsic-detail.mjs's loadExtrinsicDetail. ref is a 0x hash or a
        // composite "block_number-extrinsic_index".
        const extrinsicRef = url.pathname.match(
          /^\/api\/v1\/extrinsics\/([^/]+)$/,
        );
        if (extrinsicRef) {
          const ref = decodeURIComponent(extrinsicRef[1]);
          const isHash = HASH_RE.test(ref);
          let rows;
          if (isHash) {
            rows = await sql`
            SELECT block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args::text AS call_args, success, fee_tao, tip_tao, observed_at
            FROM extrinsics WHERE extrinsic_hash = ${ref.toLowerCase()}
            ORDER BY block_number DESC, extrinsic_index DESC LIMIT 1`;
          } else {
            const composite = COMPOSITE_REF_RE.exec(ref);
            const blockNumber = composite ? Number(composite[1]) : NaN;
            const extrinsicIndex = composite ? Number(composite[2]) : NaN;
            rows =
              composite &&
              Number.isSafeInteger(blockNumber) &&
              Number.isSafeInteger(extrinsicIndex)
                ? await sql`
                  SELECT block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args::text AS call_args, success, fee_tao, tip_tao, observed_at
                  FROM extrinsics WHERE block_number = ${blockNumber} AND extrinsic_index = ${extrinsicIndex} LIMIT 1`
                : [];
          }
          const resolved = rows[0];
          let events = [];
          const resolvedBlock = numberOrNull(resolved?.block_number);
          const resolvedIndex = numberOrNull(resolved?.extrinsic_index);
          if (resolvedBlock != null && resolvedIndex != null) {
            const eventRows = await sql`
            SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
            FROM account_events
            WHERE block_number = ${resolvedBlock} AND extrinsic_index = ${resolvedIndex}
            ORDER BY event_index ASC LIMIT ${MAX_EMBEDDED_EVENTS}`;
            events = eventRows.map(formatAccountEvent).filter(Boolean);
          }
          return json(buildExtrinsic(resolved, ref, events));
        }

        // GET /api/v1/accounts/:ss58/events — the per-account signed-event feed
        // (#4696), mirroring src/account-events.mjs's loadAccountEvents filter
        // set (kind, netuid, block_start/block_end, cursor). account_events has
        // no shape-parity risk (11 scalar columns, its own dedicated writer,
        // never a generic call_args/chain_events-style SCALE dump) -- unlike
        // extrinsics/blocks, this tier only needed the query layer built, not a
        // decode-shape reconciliation.
        //
        // D1's hotkey/coldkey union is two INDEXED BY branches combined with
        // UNION ALL (each SQLite index can only ever seek ONE column), with a
        // second-branch guard to stop UNION ALL from double-counting a row
        // where both columns equal the same ss58. Postgres has no INDEXED BY
        // equivalent and evaluates a flat `WHERE (hotkey = $1 OR coldkey = $1)`
        // as one plan, so a matching row is naturally visited exactly once --
        // the double-count guard has nothing to do here and is deliberately
        // omitted, not an oversight.
        const acctEvents = url.pathname.match(
          /^\/api\/v1\/accounts\/([^/]+)\/events$/,
        );
        if (acctEvents) {
          const ss58 = decodeURIComponent(acctEvents[1]);
          const limit = clampLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          const cursor = decodeCursor(url.searchParams.get("cursor"), 2);
          const kind = url.searchParams.get("kind") || null;
          const netuid = nonNegativeIntegerParam(url.searchParams, "netuid");
          const blockStart = nonNegativeIntegerParam(
            url.searchParams,
            "block_start",
          );
          const blockEnd = nonNegativeIntegerParam(
            url.searchParams,
            "block_end",
          );
          const rows = await sql`
          SELECT block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at
          FROM account_events
          WHERE (hotkey = ${ss58} OR coldkey = ${ss58})
            ${kind ? sql`AND event_kind = ${kind}` : sql``}
            ${netuid != null ? sql`AND netuid = ${netuid}` : sql``}
            ${blockStart != null ? sql`AND block_number >= ${blockStart}` : sql``}
            ${blockEnd != null ? sql`AND block_number <= ${blockEnd}` : sql``}
            ${cursor ? sql`AND (block_number, event_index) < (${cursor[0]}, ${cursor[1]})` : sql``}
          ORDER BY block_number DESC, event_index DESC
          LIMIT ${limit}
          ${!cursor ? sql`OFFSET ${offset}` : sql``}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextCursor = last
            ? encodeCursor([
                numberOrNull(last.block_number),
                numberOrNull(last.event_index),
              ])
            : null;
          return json(
            buildAccountEvents(rows, ss58, { limit, offset, nextCursor }),
          );
        }

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

        // GET /api/v1/chain-events?pallet=&method=&block=&extrinsic=&cursor=&before=&limit=
        // recent all-events feed. block= scopes to one block; block=+extrinsic= scopes to
        // a single extrinsic's emitted events (explorer extrinsic-detail view). Ignore
        // extrinsic without block to avoid an unindexed global extrinsic_index scan.
        // cursor is the lossless keyset over (block_number,event_index); before is
        // retained as the legacy block_number-only cursor for existing callers.
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
          const blockN = nonNegativeIntegerParam(url.searchParams, "block");
          const extrN =
            blockN != null
              ? nonNegativeIntegerParam(url.searchParams, "extrinsic")
              : null;
          const cursor = decodeCursor(url.searchParams.get("cursor"), 2);
          const beforeBn = cursor
            ? null
            : nonNegativeIntegerParam(url.searchParams, "before"); // legacy block_number cursor
          if (method && !pallet && blockN == null) {
            return json(
              {
                error:
                  "method filter requires pallet unless block is specified",
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
            ${
              cursor
                ? sql`AND (block_number, event_index) < (${cursor[0]}, ${cursor[1]})`
                : beforeBn != null
                  ? sql`AND block_number < ${beforeBn}`
                  : sql``
            }
            ${pallet ? sql`AND pallet = ${pallet}` : sql``}
            ${method ? sql`AND method = ${method}` : sql``}
          ORDER BY block_number DESC, event_index DESC
          LIMIT ${limit}`;
          const last = rows.length === limit ? rows[rows.length - 1] : null;
          const nextBlock = last ? numberOrNull(last.block_number) : null;
          const nextCursor = last
            ? encodeCursor([nextBlock, numberOrNull(last.event_index)])
            : null;
          return json({
            count: rows.length,
            next_before: nextBlock,
            next_cursor: nextCursor,
            events: rows.map(coerceEvent),
          });
        }

        // GET /api/v1/chain-events/stats?blocks=N — chain-activity aggregate: the
        // pallet.method event distribution over the most recent N blocks (default
        // 1000, capped 5000). Bounded window + capped output keep it index-cheap.
        if (url.pathname === "/api/v1/chain-events/stats") {
          const blocks = clampStatsBlocks(url.searchParams.get("blocks"));
          // count is a non-unique sort key, so ORDER BY count alone leaves ties
          // unordered — and over Hyperdrive's pooled connections (prepare:false)
          // Postgres can plan/scan identical requests differently, reshuffling
          // equal-count groups and flipping which groups survive LIMIT 100 at the
          // boundary. Tie-break on the GROUP BY key (unique per row) for a total,
          // stable order, matching the keyset orders on the sibling queries above.
          const rows = await sql`
          SELECT pallet, method, count(*)::int AS count
          FROM chain_events
          WHERE block_number > (SELECT max(block_number) FROM chain_events) - ${blocks}
          GROUP BY pallet, method
          ORDER BY count DESC, pallet ASC, method ASC
          LIMIT 100`;
          return json({
            window_blocks: blocks,
            groups: rows.length,
            activity: rows,
          });
        }

        return json({ error: "not found" }, 404);
      });
    } catch (err) {
      // Log internally (Wrangler observability) but NEVER leak DB error details
      // (schema, table, or connection info) to API clients.
      console.error("data-api query failed:", err);
      return json({ error: "data query failed" }, 502);
    }
    // No sql.end() here: Hyperdrive automatically cleans up the connection
    // when the request/invocation ends (Cloudflare's documented pattern) --
    // the previous ctx.waitUntil(sql.end(...)) was undocumented, unnecessary
    // background work racing the response, right where #4686's subrequest-
    // cancellation flakiness was observed.
  },
};
