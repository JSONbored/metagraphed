// Staged-artifact loaders: the */3 fast-load cron path that drains HMAC-signed R2
// batches into D1 (extracted from workers/api.mjs per #1763).
//
// This module co-locates the one remaining `loadStaged*` loader (account
// identity) with the signing/validation machinery it alone uses — the staged
// R2 key, the per-tier byte/row caps, the HMAC envelope helpers, and the
// staged row/coverage validator. That loader reads an HMAC-signed envelope
// from `env.METAGRAPH_ARCHIVE`, re-derives the signature with
// `env.METAGRAPH_STAGING_SIGNING_KEY`, and only then loads bounded,
// schema-valid rows into `env.METAGRAPH_HEALTH_DB` with parameterized
// INSERTs.
//
// The neurons/events/blocks/extrinsics loaders that used to live here (their own
// D1 tables, ingest paths, and prune/rollup crons) are removed alongside those D1
// tables (#4772 D1 chain-data retirement). loadStagedSubnetHyperparams is removed
// the same way: subnet_hyperparams/subnet_hyperparams_history are fully served
// from Postgres now (METAGRAPH_SUBNET_HYPERPARAMS_SOURCE, #4832 gap-closure), so
// this D1-only staged-load path (and the R2-stage-to-D1 workflow step that fed
// it, .github/workflows/refresh-subnet-hyperparams.yml) is dead weight. The D1
// subnet_hyperparams/subnet_hyperparams_history TABLES themselves are left in
// place, not dropped, matching #4772's staged sequencing (code retirement lands
// and runs clean first; the physical DROP TABLE is a separate follow-up).
//
// Every dependency is a leaf module (config caps + the per-tier row validators and
// INSERT builders from src/*), so this file never imports api.mjs — no injected
// deps are needed (unlike analytics.mjs, which had an api.mjs-local KV reader to
// wire). api.mjs re-exports the loader so the scheduled cron and the staging tests
// keep importing it from "../workers/api.mjs".

import { ACCOUNT_IDENTITY_INSERT_COLUMNS } from "../../src/account-identity.mjs";
import { recordAccountIdentityChanges } from "../../src/account-identity-history.mjs";

// Account identity (#4324/5.1): scoped to coldkeys that actually have an
// identity SET (most never call set_identity), so this stays small — bounds
// are generous headroom over the realistic count, not a tight fit. A
// dedicated per-field string cap: the SDK's own set_identity CLI validation
// (bittensor_cli/src/bittensor/utils.py, prompt_for_identity) bounds
// image/description/additional at 1024 bytes and name/url/discord/github_repo
// at 256 — a tighter cap sized for a short hotkey/axon-style string would
// silently reject a legitimately long, on-chain-valid description/image/
// additional value.
const STAGED_ACCOUNT_IDENTITY_KEY = "metagraph/account-identity-pending.json";
const MAX_STAGED_ACCOUNT_IDENTITY_BYTES = 5_000_000;
const MAX_STAGED_ACCOUNT_IDENTITY_ROWS = 5_000;
const MAX_STAGED_ACCOUNT_IDENTITY_STRING_BYTES = 1024;

function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

function timingSafeStringEqual(a, b) {
  const left = utf8Bytes(String(a || ""));
  const right = utf8Bytes(String(b || ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function hmacHex(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, utf8Bytes(value));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function accountIdentityStagingSignPayload(rows) {
  return JSON.stringify(rows);
}

function validStagedAccountIdentityRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (typeof row.account !== "string" || row.account.length === 0) return false;
  if (!Number.isFinite(row.captured_at)) return false;
  // Every other column (name/url/github/image/discord/description/additional)
  // is TEXT-only — unlike a numeric hyperparameter/neuron row, whose columns
  // are mostly numeric, a bare `typeof value !== "number"` check here must
  // actively REJECT a number (or any non-string, non-null value), not just
  // skip a non-finite one.
  for (const [key, value] of Object.entries(row)) {
    if (!ACCOUNT_IDENTITY_INSERT_COLUMNS.includes(key)) return false;
    if (key === "account" || key === "captured_at") continue; // validated above
    if (value === null) continue;
    if (typeof value !== "string") return false;
    if (utf8Bytes(value).length > MAX_STAGED_ACCOUNT_IDENTITY_STRING_BYTES)
      return false;
  }
  return true;
}

// Load a staged account-identity snapshot from R2 into D1 (#4324/5.1). The
// refresh-account-identity CI job fetches every account with a set on-chain
// identity first-party (scripts/fetch-account-identity.py), signs the
// bare-array snapshot with scripts/sign-staged-neurons.mjs (reused unchanged),
// and writes it to R2 (metagraph/account-identity-pending.json). We load only
// authenticated, bounded, schema-valid rows through the METAGRAPH_HEALTH_DB
// binding (no API-token D1 permission needed) with PARAMETERIZED inserts.
//
// Deliberately NO purge step (unlike a full-snapshot loader that removes a
// deregistered subnet's/UID's stale row on every load): an identity is a
// property of the owning account, not of currently having an active neuron —
// an account missing from THIS particular snapshot pass (a transient RPC gap,
// or its only neuron deregistering) hasn't necessarily lost its identity, and
// purging on absence would fight #4326/5.2's future diff-history tracking by
// making a scan gap look like a real removal. UPSERT-only; rows only ever
// accumulate or get refreshed in place. Believed safe from unbounded growth
// (unlike account_events/neuron_daily, which have both hit real D1 capacity
// limits before): setting an identity is gated behind owning at least one
// currently-registered hotkey, an economically real barrier, not a passively-
// logged event — live-verified 2026-07-09 at 460 rows across ~30k active
// neurons (~1.5%). No measured growth tripwire is defined; revisit retention
// if row count ever approaches neuron_daily's pre-outage scale.
export async function loadStagedAccountIdentity(env) {
  const bucket = env.METAGRAPH_ARCHIVE;
  const db = env.METAGRAPH_HEALTH_DB;
  const signingKey = env.METAGRAPH_STAGING_SIGNING_KEY;
  if (!bucket?.get || !db?.prepare || !signingKey) {
    return { ok: false, reason: "unavailable" };
  }
  const object = await bucket.get(STAGED_ACCOUNT_IDENTITY_KEY);
  if (!object) return { ok: false, reason: "none" };
  if (Number(object.size || 0) > MAX_STAGED_ACCOUNT_IDENTITY_BYTES) {
    console.warn(
      `loadStagedAccountIdentity: staged file ${object.size} bytes exceeds ${MAX_STAGED_ACCOUNT_IDENTITY_BYTES}; skipping (next cron self-heals)`,
    );
    return { ok: false, reason: "too_large", size: Number(object.size) };
  }
  let envelope;
  try {
    envelope = await object.json();
  } catch {
    await bucket.delete(STAGED_ACCOUNT_IDENTITY_KEY);
    return { ok: false, reason: "parse_failed" };
  }
  const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
  if (
    envelope?.schema_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(envelope?.hmac_sha256 || ""))
  ) {
    await bucket.delete(STAGED_ACCOUNT_IDENTITY_KEY);
    return { ok: false, reason: "unauthenticated" };
  }
  if (rows.length > MAX_STAGED_ACCOUNT_IDENTITY_ROWS) {
    await bucket.delete(STAGED_ACCOUNT_IDENTITY_KEY);
    return { ok: false, reason: "too_many_rows" };
  }
  if (!rows.length || rows.some((row) => !validStagedAccountIdentityRow(row))) {
    await bucket.delete(STAGED_ACCOUNT_IDENTITY_KEY);
    return { ok: false, reason: "invalid" };
  }
  const expected = await hmacHex(
    signingKey,
    accountIdentityStagingSignPayload(rows),
  );
  if (!timingSafeStringEqual(expected, envelope.hmac_sha256)) {
    await bucket.delete(STAGED_ACCOUNT_IDENTITY_KEY);
    return { ok: false, reason: "unauthenticated" };
  }
  const cols = ACCOUNT_IDENTITY_INSERT_COLUMNS;
  const colList = cols.join(",");
  // 9 columns x 10 rows = 90 bound params/statement, matching the ~90-param
  // convention this loader's now-removed siblings targeted.
  const ROWS_PER_STMT = 10;
  const STMTS_PER_BATCH = 50;
  const statements = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT);
    const tuples = chunk
      .map(() => `(${cols.map(() => "?").join(",")})`)
      .join(",");
    const values = chunk.flatMap((row) => cols.map((c) => row[c] ?? null));
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO account_identity (${colList}) VALUES ${tuples}`,
        )
        .bind(...values),
    );
  }
  try {
    for (let i = 0; i < statements.length; i += STMTS_PER_BATCH) {
      await db.batch(statements.slice(i, i + STMTS_PER_BATCH));
    }
  } catch {
    // Staged object intentionally preserved: the next cron retries the full
    // (idempotent) snapshot rather than leaving a partial load unrecovered.
    return { ok: false, reason: "load_failed" };
  }
  // Diff-and-append into the history tier (#4326/5.2) once the latest-only
  // table is confirmed updated. A failure here never fails the load — the
  // latest table (the primary contract) already landed; the next cron's
  // idempotent hash comparison self-heals a missed diff.
  await recordAccountIdentityChanges(env, { rows, db });
  await bucket.delete(STAGED_ACCOUNT_IDENTITY_KEY);
  return { ok: true, rows: rows.length };
}
