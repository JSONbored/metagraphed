// Staged-artifact loaders: the */3 fast-load cron path that drains HMAC-signed R2
// batches into D1 (extracted from workers/api.mjs per #1763).
//
// This module co-locates the two remaining `loadStaged*` loaders (subnet
// hyperparameters, account identity) with the signing/validation machinery they
// alone use — the staged R2 keys, the per-tier byte/row caps, the HMAC envelope
// helpers, and the staged row/coverage validators. They form one trust contract:
// every loader reads an HMAC-signed envelope from `env.METAGRAPH_ARCHIVE`,
// re-derives the signature with `env.METAGRAPH_STAGING_SIGNING_KEY`, and only
// then loads bounded, schema-valid rows into `env.METAGRAPH_HEALTH_DB` with
// parameterized INSERTs. Keeping the signers and their callers in one file makes
// the "verify before load, delete after success" invariant reviewable in a
// single place.
//
// The neurons/events/blocks/extrinsics loaders that used to live here (their own
// D1 tables, ingest paths, and prune/rollup crons) are removed alongside those D1
// tables (#4772 D1 chain-data retirement).
//
// Every dependency is a leaf module (config caps + the per-tier row validators and
// INSERT builders from src/*), so this file never imports api.mjs — no injected
// deps are needed (unlike analytics.mjs, which had an api.mjs-local KV reader to
// wire). api.mjs re-exports the loaders so the scheduled cron and the staging tests
// keep importing them from "../workers/api.mjs".

import { SUBNET_HYPERPARAMS_INSERT_COLUMNS } from "../../src/subnet-hyperparams.mjs";
import { recordSubnetHyperparamsChanges } from "../../src/subnet-hyperparams-history.mjs";
import { ACCOUNT_IDENTITY_INSERT_COLUMNS } from "../../src/account-identity.mjs";
import { recordAccountIdentityChanges } from "../../src/account-identity-history.mjs";

// Sanity bounds for an authenticated, HMAC-signed staged neuron batch (the data
// is already trusted; these are defense-in-depth caps so a malformed signed file
// can't blow up the D1 load). The byte cap intentionally allows the
// expected all-subnet signed JSON envelope (~33k rows) while still bounding
// memory use before parsing. netuid and uid are both u16 on-chain, so each is
// capped at the u16 max (65535) — matching the existing netuid guard in
// src/webhooks.mjs and avoiding rejection of legitimately high subnet ids.
const MAX_STAGED_NETUID = 65_535;

// Subnet hyperparameters (#4303/1.3): a much smaller, much-less-frequent staged
// snapshot (~129 rows today, one per active subnet) than the per-UID neuron
// snapshot above — bounds are correspondingly tighter.
const STAGED_SUBNET_HYPERPARAMS_KEY =
  "metagraph/subnet-hyperparams-pending.json";
const MAX_STAGED_SUBNET_HYPERPARAMS_BYTES = 2_000_000;
const MAX_STAGED_SUBNET_HYPERPARAMS_ROWS = 1_000;

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

function subnetHyperparamsStagingSignPayload(rows) {
  return JSON.stringify(rows);
}

function validStagedSubnetHyperparamsRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (
    !Number.isInteger(row.netuid) ||
    row.netuid < 0 ||
    row.netuid > MAX_STAGED_NETUID
  )
    return false;
  for (const [key, value] of Object.entries(row)) {
    if (!SUBNET_HYPERPARAMS_INSERT_COLUMNS.includes(key)) return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    if (value !== null && typeof value !== "number") return false;
  }
  return true;
}

// Load a staged subnet-hyperparameters snapshot from R2 into D1 (#4303/1.3). The
// refresh-subnet-hyperparams CI job fetches every active subnet's hyperparameter
// set first-party (#4305), signs the bare-array snapshot with
// scripts/sign-staged-neurons.mjs (reused unchanged — same bare-array envelope
// shape as a legacy neuron snapshot), and writes it to R2
// (metagraph/subnet-hyperparams-pending.json). We load only authenticated,
// bounded, schema-valid rows through the METAGRAPH_HEALTH_DB binding (no
// API-token D1 permission needed) with PARAMETERIZED inserts.
//
// Every successful fetch covers ALL active subnets in one run
// (get_subnet_hyperparameters has no bulk variant, but the fetch script loops
// every netuid every time and exits nonzero on any missing netuid — no
// partial-coverage concept needed here). ~129 rows today is a small snapshot,
// so no backup/rollback complexity: each upsert batch is independently an
// atomic D1 transaction and idempotent (INSERT OR REPLACE), so a failed batch
// leaves only correctly-upserted rows behind —
// safe to leave as-is, since the staged object is preserved (not deleted) on
// failure and the next cron retries the same full snapshot. The prune (deleting
// a deregistered subnet's stale row) runs only after every upsert batch succeeds,
// so it never fires against a partial loader run.
export async function loadStagedSubnetHyperparams(env) {
  const bucket = env.METAGRAPH_ARCHIVE;
  const db = env.METAGRAPH_HEALTH_DB;
  const signingKey = env.METAGRAPH_STAGING_SIGNING_KEY;
  if (!bucket?.get || !db?.prepare || !signingKey) {
    return { ok: false, reason: "unavailable" };
  }
  const object = await bucket.get(STAGED_SUBNET_HYPERPARAMS_KEY);
  if (!object) return { ok: false, reason: "none" };
  if (Number(object.size || 0) > MAX_STAGED_SUBNET_HYPERPARAMS_BYTES) {
    console.warn(
      `loadStagedSubnetHyperparams: staged file ${object.size} bytes exceeds ${MAX_STAGED_SUBNET_HYPERPARAMS_BYTES}; skipping (next cron self-heals)`,
    );
    return { ok: false, reason: "too_large", size: Number(object.size) };
  }
  let envelope;
  try {
    envelope = await object.json();
  } catch {
    await bucket.delete(STAGED_SUBNET_HYPERPARAMS_KEY);
    return { ok: false, reason: "parse_failed" };
  }
  const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
  if (
    envelope?.schema_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(envelope?.hmac_sha256 || ""))
  ) {
    await bucket.delete(STAGED_SUBNET_HYPERPARAMS_KEY);
    return { ok: false, reason: "unauthenticated" };
  }
  if (rows.length > MAX_STAGED_SUBNET_HYPERPARAMS_ROWS) {
    await bucket.delete(STAGED_SUBNET_HYPERPARAMS_KEY);
    return { ok: false, reason: "too_many_rows" };
  }
  if (
    !rows.length ||
    rows.some((row) => !validStagedSubnetHyperparamsRow(row))
  ) {
    await bucket.delete(STAGED_SUBNET_HYPERPARAMS_KEY);
    return { ok: false, reason: "invalid" };
  }
  const expected = await hmacHex(
    signingKey,
    subnetHyperparamsStagingSignPayload(rows),
  );
  if (!timingSafeStringEqual(expected, envelope.hmac_sha256)) {
    await bucket.delete(STAGED_SUBNET_HYPERPARAMS_KEY);
    return { ok: false, reason: "unauthenticated" };
  }
  const cols = SUBNET_HYPERPARAMS_INSERT_COLUMNS;
  const colList = cols.join(",");
  // Proven-in-production per-statement/per-batch sizing (90 bound params/
  // statement, 50 statements/batch), scaled for this table's column count
  // (36): 2 rows x 36 columns = 72 bound params/statement, same batch size.
  const ROWS_PER_STMT = 2;
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
          `INSERT OR REPLACE INTO subnet_hyperparams (${colList}) VALUES ${tuples}`,
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
  const netuidsInSnapshot = rows.map((row) => row.netuid);
  let purged;
  try {
    const result = await db
      .prepare(
        `DELETE FROM subnet_hyperparams WHERE netuid NOT IN (${netuidsInSnapshot
          .map(() => "?")
          .join(",")})`,
      )
      .bind(...netuidsInSnapshot)
      .run();
    purged = result?.meta?.changes ?? 0;
  } catch {
    // Upserts already committed; only the stale-subnet prune failed. Keep the
    // staged object so the next cron retries (a redundant but harmless
    // re-upsert either way).
    return { ok: false, reason: "purge_failed" };
  }
  // Diff-and-append into the history tier (#4309/1.6) once the latest-only
  // table is confirmed updated. A failure here never fails the load — the
  // latest table (the primary contract) already landed; the next cron's
  // idempotent hash comparison self-heals a missed diff.
  await recordSubnetHyperparamsChanges(env, { rows, db });
  await bucket.delete(STAGED_SUBNET_HYPERPARAMS_KEY);
  return { ok: true, rows: rows.length, purged };
}

function accountIdentityStagingSignPayload(rows) {
  return JSON.stringify(rows);
}

function validStagedAccountIdentityRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (typeof row.account !== "string" || row.account.length === 0) return false;
  if (!Number.isFinite(row.captured_at)) return false;
  // Every other column (name/url/github/image/discord/description/additional)
  // is TEXT-only — unlike validStagedSubnetHyperparamsRow, which allows
  // numbers because many of its columns are numeric, a bare
  // `typeof value !== "number"` check here must actively REJECT a number
  // (or any non-string, non-null value), not just skip a non-finite one.
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
// Deliberately NO purge step (unlike loadStagedSubnetHyperparams, which
// removes a deregistered subnet's stale row): an identity is a property of
// the owning account, not of currently having an active neuron — an account
// missing from THIS particular snapshot pass (a transient RPC gap, or its
// only neuron deregistering) hasn't necessarily lost its identity, and
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
  // convention the other staged loaders in this file target.
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
