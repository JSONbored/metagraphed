// metagraphed neurons-sync Worker — the write path into the chain-indexer's
// Postgres `neurons` (latest per-UID snapshot) and `neuron_daily` (daily
// history) tables (#4771). Same Postgres instance/Hyperdrive origin as
// workers/data-api.mjs reads from; kept as its own dedicated Worker for the
// same bundle-budget reason wrangler.data.jsonc/wrangler.registry.jsonc
// already are split out (the postgres.js driver shouldn't grow every Worker
// that merely proxies to it), and because this is a WRITE path -- isolating
// it keeps the blast radius of a bug here to "the metagraph sync stalls",
// never "a read route's bundle also carries write credentials."
//
// Reached only via the main Worker's NEURONS_SYNC_API service binding (no
// public routes of its own) -- see workers/api.mjs's handleNeuronsSyncProxy,
// which forwards the request here unchanged. This Worker's shared-secret
// check below is the only auth gate in the whole path, mirroring
// workers/registry-sync-api.mjs's shape exactly (shared-secret POST, no
// R2/HMAC envelope needed since the secret header IS the transport's auth).
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
import postgres from "postgres";
import { timingSafeEqual } from "../src/webhooks.mjs";
import { NEURON_INSERT_COLUMNS } from "../src/metagraph-neurons.mjs";

const TOKEN_HEADER = "x-neurons-sync-token";
// ~33k rows today (129 subnets x <=256 UIDs); generous headroom over that
// (matches the D1 staging path's MAX_STAGED_NEURON_ROWS/MAX_STAGED_NEURONS_BYTES,
// workers/request-handlers/staging.mjs) without inviting a pathological body.
const MAX_BODY_BYTES = 32_000_000;
const MAX_ROWS = 50_000;
const MAX_STRING_BYTES = 512;
const MAX_NETUID = 65_535;
const MAX_UID = 65_535;
// Multi-row VALUES tuples per statement (postgres.js's sql(rows, ...cols)
// helper) -- bounds a single statement's size while still batching the whole
// ~33k-row snapshot in a couple dozen round-trips rather than one per row.
const ROWS_PER_STATEMENT = 1_000;

const BOOLEAN_COLUMNS = new Set([
  "active",
  "validator_permit",
  "is_immunity_period",
]);

function json(data, status = 200) {
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
function validRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (
    !Number.isInteger(row.netuid) ||
    row.netuid < 0 ||
    row.netuid > MAX_NETUID
  )
    return false;
  if (!Number.isInteger(row.uid) || row.uid < 0 || row.uid > MAX_UID)
    return false;
  if (!Number.isInteger(row.captured_at) || row.captured_at <= 0) return false;
  for (const [key, value] of Object.entries(row)) {
    if (!NEURON_INSERT_COLUMNS.includes(key)) return false;
    if (typeof value === "string" && utf8Bytes(value).length > MAX_STRING_BYTES)
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
function snapshotDate(capturedAtMs) {
  return new Date(capturedAtMs).toISOString().slice(0, 10);
}

// Coerce one validated row into the exact JS types each Postgres column
// expects: 0/1 -> boolean for the BOOLEAN columns (the fetch script emits
// 0/1 integers, same convention D1's INTEGER columns use), everything else
// passes through (postgres.js binds numbers/strings/nulls as-is).
function coerceRow(row) {
  const out = {};
  for (const col of NEURON_INSERT_COLUMNS) {
    const value = row[col] ?? null;
    out[col] = BOOLEAN_COLUMNS.has(col) ? Boolean(Number(value)) : value;
  }
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    if (!env.NEURONS_SYNC_SECRET) {
      return json(
        { error: "neurons sync is not provisioned on this deployment" },
        503,
      );
    }
    const provided = request.headers.get(TOKEN_HEADER) || "";
    if (!provided || !timingSafeEqual(provided, env.NEURONS_SYNC_SECRET)) {
      return json({ error: `provide a valid ${TOKEN_HEADER} header` }, 401);
    }
    if (!env.HYPERDRIVE?.connectionString) {
      return json({ error: "hyperdrive binding unavailable" }, 503);
    }

    const raw = await request.text();
    if (utf8Bytes(raw).length > MAX_BODY_BYTES) {
      return json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const incoming = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.rows)
        ? parsed.rows
        : null;
    if (!incoming) {
      return json(
        { error: "body must be a JSON array of neuron rows (or {rows:[...]})" },
        400,
      );
    }
    if (incoming.length > MAX_ROWS) {
      return json({ error: `at most ${MAX_ROWS} rows per request` }, 413);
    }
    if (!incoming.length || !incoming.every(validRow)) {
      return json({ error: "rows must match the neuron row shape" }, 400);
    }

    const rows = incoming.map(coerceRow);
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
      // sql.begin() reserves ONE physical connection for the whole batch,
      // same connection-affinity reasoning as registry-sync-api.mjs/#4686 --
      // and makes the whole snapshot atomic: a mid-batch failure must never
      // leave `neurons` upserted with stale UIDs left un-pruned, or
      // `neuron_daily` partially written for the day.
      return await sql.begin(async (sql) => {
        await sql`SET statement_timeout = '20000ms'`;

        const dailyRows = rows.map((row) => ({
          ...row,
          snapshot_date: snapshotDate(row.captured_at),
          updated_at: Date.now(),
        }));

        for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
          const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
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

        for (let i = 0; i < dailyRows.length; i += ROWS_PER_STATEMENT) {
          const chunk = dailyRows.slice(i, i + ROWS_PER_STATEMENT);
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
        // batch actually covers (deregistered/replaced UIDs) -- scoped to
        // ONLY the netuids present in this payload, so a partial-coverage
        // batch can never wipe an unrelated subnet's rows. Mirrors D1's
        // loadStagedNeurons prune, minus its "legacy" whole-table branch:
        // every batch here declares its own coverage implicitly via which
        // netuids its rows belong to. `netuids` is never empty here -- the
        // earlier `!incoming.length` check guarantees at least one row, and
        // every row has a netuid.
        const pruned = await sql`
          DELETE FROM neurons
          WHERE netuid = ANY(${netuids})
            AND captured_at < ${snapshotCapturedAt}
          RETURNING netuid`;

        return json({
          ok: true,
          neurons_written: rows.length,
          neuron_daily_written: dailyRows.length,
          netuids_covered: netuids.length,
          deregistered_pruned: pruned.length,
        });
      });
    } catch (err) {
      console.error("neurons-sync-api write failed:", err);
      return json({ error: "write failed" }, 502);
    }
    // No sql.end() here: Hyperdrive automatically cleans up the connection
    // when the request/invocation ends (Cloudflare's documented pattern,
    // same as data-api.mjs/registry-sync-api.mjs).
  },
};
