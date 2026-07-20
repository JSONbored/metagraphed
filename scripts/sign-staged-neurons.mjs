#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Build the signed staged-neurons envelope from a parsed staging payload.
// Accepts either a bare array of rows (signs `JSON.stringify(rows)` directly) or
// a staging object `{ rows, refreshed_netuids, captured_at }` (signs the full
// object). Returns `{ schema_version, hmac_sha256, rows, ... }`. Pure +
// side-effect-free so the CLI stays a thin wrapper and the branching/signing is
// unit-tested directly (mirrors shouldPublishEconomics in economics-floor.mjs).
export function buildSignedEnvelope(parsed, key) {
  let rows;
  let refreshed_netuids;
  let captured_at;
  let payload;
  if (Array.isArray(parsed)) {
    rows = parsed;
    payload = JSON.stringify(rows);
  } else if (parsed && typeof parsed === "object") {
    rows = parsed.rows;
    refreshed_netuids = parsed.refreshed_netuids;
    captured_at = parsed.captured_at;
    if (!Array.isArray(rows)) {
      throw new Error("staged payload rows must be a JSON array");
    }
    payload = JSON.stringify({ rows, refreshed_netuids, captured_at });
  } else {
    throw new Error("staged payload must be a JSON array or staging object");
  }

  const hmac_sha256 = createHmac("sha256", key).update(payload).digest("hex");
  const envelope = { schema_version: 1, hmac_sha256, rows };
  if (refreshed_netuids !== undefined)
    envelope.refreshed_netuids = refreshed_netuids;
  if (captured_at !== undefined) envelope.captured_at = captured_at;
  return envelope;
}

function main() {
  const [inputPath, outputPath = inputPath] = process.argv.slice(2);
  const key = process.env.METAGRAPH_STAGING_SIGNING_KEY;
  if (!inputPath || !key) {
    throw new Error(
      "usage: METAGRAPH_STAGING_SIGNING_KEY=... node scripts/sign-staged-neurons.mjs <input> [output]",
    );
  }

  const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
  const envelope = buildSignedEnvelope(parsed, key);
  writeFileSync(outputPath, `${JSON.stringify(envelope)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
