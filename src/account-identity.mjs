// Personal (coldkey) chain identity (#4324/5.1) — one row per account, latest
// only. Distinct from subnet identity (SubtensorModule::SubnetIdentitiesV3,
// src/subnet-identity-history.mjs / src/chain-identity-history.mjs) — this is
// the identity a coldkey attaches to itself. Field mapping documented in
// scripts/fetch-account-identity.py's docstring and
// migrations/0039_account_identity.sql. Mirrors NEURON_INSERT_COLUMNS's role
// in src/metagraph-neurons.mjs — the full column set written by the staged-
// load path (loadStagedAccountIdentity, workers/request-handlers/staging.mjs).
//
// Read/format/build functions land here with the serving route (#4328/5.4).

import {
  nativeContactHandle,
  sanitizeIdentityHistoryLink,
  sanitizeIdentityHistoryText,
} from "./chain-identity-sanitize.mjs";

export const ACCOUNT_IDENTITY_INSERT_COLUMNS = [
  "account",
  "name",
  "url",
  "github",
  "image",
  "discord",
  "description",
  "additional",
  "captured_at",
];

// The 7 identity fields, excluding the account key + captured_at timestamp —
// same derivation account-identity-history.mjs's IDENTITY_FIELDS uses.
export const IDENTITY_FIELDS = ACCOUNT_IDENTITY_INSERT_COLUMNS.slice(1, -1);

function toIso(ms) {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// account_identity is operator-controlled untrusted chain data, same as
// subnet identity — sanitize at serve time with the same primitives
// src/subnet-identity-history.mjs's sanitizeIdentityHistoryFields uses
// (src/chain-identity-sanitize.mjs), mapped onto this table's field names
// (url/github/image are links; discord is a contact handle; name/description/
// additional are free text). Applied only when SERVING — the diff-tracking
// hash (#4326) is computed over the raw staged values and is unaffected.
export function sanitizeAccountIdentityFields(fields) {
  if (!fields || typeof fields !== "object") return fields;
  return {
    ...fields,
    name: sanitizeIdentityHistoryText(fields.name),
    description: sanitizeIdentityHistoryText(fields.description),
    additional: sanitizeIdentityHistoryText(fields.additional),
    url: sanitizeIdentityHistoryLink(fields.url),
    github: sanitizeIdentityHistoryLink(fields.github),
    image: sanitizeIdentityHistoryLink(fields.image),
    discord: nativeContactHandle(fields.discord),
  };
}

/**
 * Shape the latest-only account_identity row into the /identity artifact.
 * has_identity is false (and every field null) when the account has never
 * called set_identity — most accounts, so this is the common case, not an
 * error (#4324/5.4, matching the capture pipeline's own "scoped to accounts
 * that actually have an identity set" coverage note).
 */
export function buildAccountIdentity(row, account) {
  const identity =
    row && typeof row === "object" ? sanitizeAccountIdentityFields(row) : null;
  const out = { schema_version: 1, account, has_identity: Boolean(identity) };
  for (const field of IDENTITY_FIELDS) {
    out[field] = identity ? (identity[field] ?? null) : null;
  }
  out.captured_at = identity ? toIso(row.captured_at) : null;
  return out;
}

export async function loadAccountIdentity(d1, account) {
  const rows = await d1(
    `SELECT ${ACCOUNT_IDENTITY_INSERT_COLUMNS.join(", ")} FROM account_identity WHERE account = ?`,
    [account],
  );
  return buildAccountIdentity(rows?.[0] ?? null, account);
}
