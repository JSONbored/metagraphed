// metagraphed data Worker — Postgres-backed serving via Cloudflare Hyperdrive.
//
// Kept SEPARATE from the main api.mjs Worker (which is near its bundle budget): the
// postgres.js driver + the growing Postgres-backed read surface live here, and the
// main Worker routes the relevant paths in via a service binding (DATA_API). This is
// the serving half of ADR 0013 — the indexer + Rust backfill write the rich Postgres
// tiers (chain_events / deep history); this exposes them to the public API.
//
// Mostly read-only, parameterized (postgres.js tagged templates), one request one
// sql.begin("read only", ...) transaction (#4686 connection-affinity). The ONE
// exception is POST /api/v1/internal/neurons-sync (#4771): the write path into
// this SAME Postgres instance's neurons/neuron_daily tables. It does NOT get its
// own dedicated Worker the way registry-sync-api.mjs does -- that split is
// justified by registry-sync-api targeting a genuinely SEPARATE Postgres instance,
// deliberately isolated so a bug in one can't take the other down. Here, splitting
// read and write for the IDENTICAL database would buy nothing (both need the same
// postgres.js driver either way) while adding a whole extra Worker/config/binding/
// secret for zero bundle-budget benefit. handleNeuronsSync below owns its own
// auth gate + connection, kept clearly separate from the read path's shared
// per-request client and response headers (a write ack must never carry the
// read routes' `cache-control: public, max-age=10`).
import postgres from "postgres";
import { decodeCursor, encodeCursor } from "../src/cursor.mjs";
import { buildBlock, buildBlockFeed } from "../src/blocks.mjs";
import { buildExtrinsic, buildExtrinsicFeed } from "../src/extrinsics.mjs";
import {
  buildAccountEvents,
  formatAccountEvent,
} from "../src/account-events.mjs";
import { decodeChainEventArgs } from "../src/chain-event-args.mjs";
import { timingSafeEqual } from "../src/webhooks.mjs";
import {
  BLOCK_PAGINATION,
  clampLimit as clampRequestLimit,
  clampOffset as clampRequestOffset,
} from "./request-params.mjs";
import {
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildGlobalValidators,
  buildNeuronDetail,
  buildValidatorDetail,
  GLOBAL_VALIDATOR_SORTS,
  DEFAULT_GLOBAL_VALIDATOR_SORT,
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  NEURON_INSERT_COLUMNS,
} from "../src/metagraph-neurons.mjs";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const FILTER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function validEventFilter(value) {
  return value == null || value === "" || FILTER_PATTERN.test(value);
}

// --- POST /api/v1/internal/neurons-sync (#4771) -----------------------------
// The write path into this Worker's own Postgres for neurons/neuron_daily.
// Reached only via the main Worker's DATA_API service binding (no public
// routes of its own) -- see workers/api.mjs's handleNeuronsSyncProxy, which
// forwards the request here unchanged. The shared-secret check below is the
// only auth gate in the whole path, mirroring workers/registry-sync-api.mjs's
// shape (shared-secret POST, no R2/HMAC envelope needed since the secret
// header IS the transport's auth).
//
// This is the write path .github/workflows/refresh-metagraph.yml's
// sign-and-stage job POSTs scripts/fetch-metagraph-native.py's output to,
// alongside (not replacing, during the #4771 verification window) the
// existing R2-stage-to-D1 path. The payload is the SAME bare-array shape
// already produced for D1 (NEURON_INSERT_COLUMNS) -- no new fetch/shape work
// needed, only a new destination.
//
// Collapses D1's two-step architecture (loadStagedNeurons loads the latest
// snapshot; a SEPARATE daily cron, rollupNeuronDaily, later snapshots that
// table into neuron_daily via SQL) into ONE step: every row already carries
// its own captured_at, so this upserts BOTH neurons (latest-only) AND
// neuron_daily (dated) from the same payload in the same transaction. No
// Postgres-side rollup cron is needed, and therefore none of D1's
// archive-then-prune complexity (src/neuron-history.mjs, #4770) has an
// equivalent here to build.
const NEURONS_SYNC_TOKEN_HEADER = "x-neurons-sync-token";
// ~33k rows today (129 subnets x <=256 UIDs); generous headroom over that
// (matches the D1 staging path's MAX_STAGED_NEURON_ROWS/MAX_STAGED_NEURONS_BYTES,
// workers/request-handlers/staging.mjs) without inviting a pathological body.
const NEURONS_SYNC_MAX_BODY_BYTES = 32_000_000;
const NEURONS_SYNC_MAX_ROWS = 50_000;
const NEURONS_SYNC_MAX_STRING_BYTES = 512;
const NEURONS_SYNC_MAX_NETUID = 65_535;
const NEURONS_SYNC_MAX_UID = 65_535;
// Multi-row VALUES tuples per statement (postgres.js's sql(rows, ...cols)
// helper) -- bounds a single statement's size while still batching the whole
// ~33k-row snapshot in a couple dozen round-trips rather than one per row.
const NEURONS_SYNC_ROWS_PER_STATEMENT = 1_000;
const NEURONS_SYNC_BOOLEAN_COLUMNS = new Set([
  "active",
  "validator_permit",
  "is_immunity_period",
]);

// Separate from the read path's json() -- a write ack must never carry the
// GET routes' `cache-control: public, max-age=10` (or the CORS wildcard,
// meaningless for a service-binding-only route).
function writeJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

// Bounds-check one incoming row against NEURON_INSERT_COLUMNS -- the exact
// same trust posture as workers/request-handlers/staging.mjs's
// validStagedNeuronRow (this payload arrives over a different transport, but
// it's the same untrusted-until-checked shape from the same producer script).
function validNeuronSyncRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (
    !Number.isInteger(row.netuid) ||
    row.netuid < 0 ||
    row.netuid > NEURONS_SYNC_MAX_NETUID
  )
    return false;
  if (
    !Number.isInteger(row.uid) ||
    row.uid < 0 ||
    row.uid > NEURONS_SYNC_MAX_UID
  )
    return false;
  if (!Number.isInteger(row.captured_at) || row.captured_at <= 0) return false;
  for (const [key, value] of Object.entries(row)) {
    if (!NEURON_INSERT_COLUMNS.includes(key)) return false;
    if (
      typeof value === "string" &&
      utf8Bytes(value).length > NEURONS_SYNC_MAX_STRING_BYTES
    )
      return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    // Every column here is a TEXT/INTEGER/NUMERIC/BOOLEAN scalar (never
    // JSONB) -- a nested object or array slipping through would only be
    // caught later as an opaque Postgres bind error (a 502), so reject it
    // here as a clean 400 instead. (bigint/symbol/function are NOT checked:
    // JSON.parse, this row's only real source, can never produce them.)
    if (value !== null && typeof value === "object") return false;
  }
  return true;
}

// captured_at is epoch ms; snapshot_date is the UTC day, matching D1's
// rollupNeuronDaily (`date(captured_at / 1000, 'unixepoch')`).
function neuronSyncSnapshotDate(capturedAtMs) {
  return new Date(capturedAtMs).toISOString().slice(0, 10);
}

// Coerce one validated row into the exact JS types each Postgres column
// expects: 0/1 -> boolean for the BOOLEAN columns (the fetch script emits
// 0/1 integers, same convention D1's INTEGER columns use), everything else
// passes through (postgres.js binds numbers/strings/nulls as-is).
function coerceNeuronSyncRow(row) {
  const out = {};
  for (const col of NEURON_INSERT_COLUMNS) {
    const value = row[col] ?? null;
    out[col] = NEURONS_SYNC_BOOLEAN_COLUMNS.has(col)
      ? Boolean(Number(value))
      : value;
  }
  return out;
}

async function handleNeuronsSync(request, env) {
  if (!env.NEURONS_SYNC_SECRET) {
    return writeJson(
      { error: "neurons sync is not provisioned on this deployment" },
      503,
    );
  }
  const provided = request.headers.get(NEURONS_SYNC_TOKEN_HEADER) || "";
  if (!provided || !timingSafeEqual(provided, env.NEURONS_SYNC_SECRET)) {
    return writeJson(
      { error: `provide a valid ${NEURONS_SYNC_TOKEN_HEADER} header` },
      401,
    );
  }
  if (!env.HYPERDRIVE?.connectionString) {
    return writeJson({ error: "hyperdrive binding unavailable" }, 503);
  }

  const raw = await request.text();
  if (utf8Bytes(raw).length > NEURONS_SYNC_MAX_BODY_BYTES) {
    return writeJson(
      { error: `body exceeds ${NEURONS_SYNC_MAX_BODY_BYTES} bytes` },
      413,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return writeJson({ error: "body must be JSON" }, 400);
  }
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : null;
  if (!incoming) {
    return writeJson(
      { error: "body must be a JSON array of neuron rows (or {rows:[...]})" },
      400,
    );
  }
  if (incoming.length > NEURONS_SYNC_MAX_ROWS) {
    return writeJson(
      { error: `at most ${NEURONS_SYNC_MAX_ROWS} rows per request` },
      413,
    );
  }
  if (!incoming.length || !incoming.every(validNeuronSyncRow)) {
    return writeJson({ error: "rows must match the neuron row shape" }, 400);
  }

  const rows = incoming.map(coerceNeuronSyncRow);
  const netuids = [...new Set(rows.map((r) => r.netuid))];
  let snapshotCapturedAt = 0;
  for (const row of rows) {
    if (row.captured_at > snapshotCapturedAt) {
      snapshotCapturedAt = row.captured_at;
    }
  }

  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: false,
    fetch_types: false,
  });

  try {
    // sql.begin() reserves ONE physical connection for the whole batch, same
    // connection-affinity reasoning as the read path above (#4686) -- and
    // makes the whole snapshot atomic: a mid-batch failure must never leave
    // `neurons` upserted with stale UIDs left un-pruned, or `neuron_daily`
    // partially written for the day.
    return await sql.begin(async (sql) => {
      await sql`SET statement_timeout = '20000ms'`;

      const dailyRows = rows.map((row) => ({
        ...row,
        snapshot_date: neuronSyncSnapshotDate(row.captured_at),
        updated_at: Date.now(),
      }));

      for (let i = 0; i < rows.length; i += NEURONS_SYNC_ROWS_PER_STATEMENT) {
        const chunk = rows.slice(i, i + NEURONS_SYNC_ROWS_PER_STATEMENT);
        await sql`
          INSERT INTO neurons ${sql(chunk, ...NEURON_INSERT_COLUMNS)}
          ON CONFLICT (netuid, uid) DO UPDATE SET
            hotkey = EXCLUDED.hotkey,
            coldkey = EXCLUDED.coldkey,
            active = EXCLUDED.active,
            validator_permit = EXCLUDED.validator_permit,
            rank = EXCLUDED.rank,
            trust = EXCLUDED.trust,
            validator_trust = EXCLUDED.validator_trust,
            consensus = EXCLUDED.consensus,
            incentive = EXCLUDED.incentive,
            dividends = EXCLUDED.dividends,
            emission_tao = EXCLUDED.emission_tao,
            stake_tao = EXCLUDED.stake_tao,
            registered_at_block = EXCLUDED.registered_at_block,
            is_immunity_period = EXCLUDED.is_immunity_period,
            axon = EXCLUDED.axon,
            block_number = EXCLUDED.block_number,
            captured_at = EXCLUDED.captured_at
          WHERE neurons.captured_at <= EXCLUDED.captured_at`;
      }

      for (
        let i = 0;
        i < dailyRows.length;
        i += NEURONS_SYNC_ROWS_PER_STATEMENT
      ) {
        const chunk = dailyRows.slice(i, i + NEURONS_SYNC_ROWS_PER_STATEMENT);
        await sql`
          INSERT INTO neuron_daily ${sql(chunk, ...NEURON_INSERT_COLUMNS, "snapshot_date", "updated_at")}
          ON CONFLICT (netuid, uid, snapshot_date) DO UPDATE SET
            hotkey = EXCLUDED.hotkey,
            coldkey = EXCLUDED.coldkey,
            active = EXCLUDED.active,
            validator_permit = EXCLUDED.validator_permit,
            rank = EXCLUDED.rank,
            trust = EXCLUDED.trust,
            validator_trust = EXCLUDED.validator_trust,
            consensus = EXCLUDED.consensus,
            incentive = EXCLUDED.incentive,
            dividends = EXCLUDED.dividends,
            emission_tao = EXCLUDED.emission_tao,
            stake_tao = EXCLUDED.stake_tao,
            registered_at_block = EXCLUDED.registered_at_block,
            is_immunity_period = EXCLUDED.is_immunity_period,
            axon = EXCLUDED.axon,
            block_number = EXCLUDED.block_number,
            captured_at = EXCLUDED.captured_at,
            updated_at = EXCLUDED.updated_at
          WHERE neuron_daily.captured_at <= EXCLUDED.captured_at`;
      }

      // Prune UIDs that no longer appear in the snapshot for a netuid this
      // batch actually covers (deregistered/replaced UIDs) -- scoped to ONLY
      // the netuids present in this payload, so a partial-coverage batch can
      // never wipe an unrelated subnet's rows. Mirrors D1's loadStagedNeurons
      // prune, minus its "legacy" whole-table branch: every batch here
      // declares its own coverage implicitly via which netuids its rows
      // belong to. `netuids` is never empty here -- the earlier
      // `!incoming.length` check guarantees at least one row, and every row
      // has a netuid.
      const pruned = await sql`
          DELETE FROM neurons
          WHERE netuid = ANY(${netuids})
            AND captured_at < ${snapshotCapturedAt}
          RETURNING netuid`;

      return writeJson({
        ok: true,
        neurons_written: rows.length,
        neuron_daily_written: dailyRows.length,
        netuids_covered: netuids.length,
        deregistered_pruned: pruned.length,
      });
    });
  } catch (err) {
    console.error("data-api neurons-sync write failed:", err);
    return writeJson({ error: "write failed" }, 502);
  }
  // No sql.end() here: Hyperdrive automatically cleans up the connection when
  // the request/invocation ends (Cloudflare's documented pattern).
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

function clampBlockLimit(raw) {
  return clampRequestLimit(raw, BLOCK_PAGINATION);
}

function clampOffset(raw) {
  return clampRequestOffset(raw);
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
    // The one write route (#4771) -- checked before the GET-only gate below,
    // same as how the main Worker's own POST-accepting routes (webhooks, MCP,
    // ingest) run ahead of its read-only method gate.
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/internal/neurons-sync"
    ) {
      return handleNeuronsSync(request, env);
    }
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
          const limit = clampBlockLimit(url.searchParams.get("limit"));
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

        // GET /api/v1/subnets/:netuid/metagraph?validator_permit=true (#4771):
        // the per-UID metagraph tier, mirroring src/metagraph-neurons.mjs's
        // loadSubnetMetagraph. Same column list as the neuron detail/validators
        // routes below (NEURON_COLUMNS) -- written literally per this file's
        // own convention (a `${...}` interpolation binds a PARAMETER, not raw
        // SQL, so a shared column-list string can't be spliced in).
        const subnetMetagraph = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/metagraph$/,
        );
        if (subnetMetagraph) {
          const netuid = Number(subnetMetagraph[1]);
          const validatorsOnly =
            url.searchParams.get("validator_permit") === "true";
          const rows = validatorsOnly
            ? await sql`
              SELECT uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at
              FROM neurons WHERE netuid = ${netuid} AND validator_permit = TRUE ORDER BY uid`
            : await sql`
              SELECT uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at
              FROM neurons WHERE netuid = ${netuid} ORDER BY uid`;
          return json(buildSubnetMetagraph(rows, netuid));
        }

        // GET /api/v1/subnets/:netuid/neurons/:uid (#4771): per-UID detail,
        // mirroring loadNeuron. A miss returns neuron:null (schema-stable,
        // never 404 -- matches the D1 path's own contract).
        const neuronDetail = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)$/,
        );
        if (neuronDetail) {
          const netuid = Number(neuronDetail[1]);
          const uid = Number(neuronDetail[2]);
          const rows = await sql`
          SELECT uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at
          FROM neurons WHERE netuid = ${netuid} AND uid = ${uid} LIMIT 1`;
          return json(buildNeuronDetail(rows[0] ?? null, netuid));
        }

        // GET /api/v1/subnets/:netuid/validators (#4771): validator_permit=1
        // rows for one subnet, ranked by stake. Mirrors loadSubnetValidators.
        const subnetValidators = url.pathname.match(
          /^\/api\/v1\/subnets\/(\d+)\/validators$/,
        );
        if (subnetValidators) {
          const netuid = Number(subnetValidators[1]);
          const rows = await sql`
          SELECT uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at
          FROM neurons WHERE netuid = ${netuid} AND validator_permit = TRUE
          ORDER BY stake_tao DESC, uid ASC`;
          return json(buildSubnetValidators(rows, netuid));
        }

        // GET /api/v1/validators?sort=&limit= (#4771): network-wide validator
        // leaderboard, mirroring loadGlobalValidators. Trusts already-validated
        // sort/limit params (the caller, workers/request-handlers/entities.mjs's
        // handleGlobalValidators, validates them before forwarding here).
        if (url.pathname === "/api/v1/validators") {
          const sortParam = url.searchParams.get("sort");
          const sort = GLOBAL_VALIDATOR_SORTS.includes(sortParam)
            ? sortParam
            : DEFAULT_GLOBAL_VALIDATOR_SORT;
          const limitParam = Number(url.searchParams.get("limit"));
          const limit =
            Number.isInteger(limitParam) &&
            limitParam >= 1 &&
            limitParam <= GLOBAL_VALIDATOR_LIMIT_MAX
              ? limitParam
              : GLOBAL_VALIDATOR_LIMIT_DEFAULT;
          const rows = await sql`
          SELECT netuid, uid, hotkey, coldkey, validator_trust, emission_tao, stake_tao, block_number, captured_at
          FROM neurons WHERE validator_permit = TRUE AND hotkey IS NOT NULL
          ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC`;
          return json(buildGlobalValidators(rows, { sort, limit }));
        }

        // GET /api/v1/validators/:hotkey (#4771): cross-subnet validator detail,
        // mirroring loadValidatorDetail.
        const validatorDetail = url.pathname.match(
          /^\/api\/v1\/validators\/([^/]+)$/,
        );
        if (validatorDetail) {
          const hotkey = decodeURIComponent(validatorDetail[1]);
          const rows = await sql`
          SELECT uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, is_immunity_period, axon, block_number, captured_at, netuid
          FROM neurons WHERE hotkey = ${hotkey} AND validator_permit = TRUE
          ORDER BY netuid ASC, uid ASC`;
          return json(buildValidatorDetail(rows, hotkey));
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
