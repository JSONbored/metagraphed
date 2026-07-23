#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Row = Record<string, unknown>;

// Build the signed staged-neurons envelope from a parsed staging payload.
// Accepts either a bare array of rows (signs `JSON.stringify(rows)` directly) or
// a staging object `{ rows, refreshed_netuids, captured_at }` (signs the full
// object). Returns `{ schema_version, hmac_sha256, rows, ... }`. Pure +
// side-effect-free so the CLI stays a thin wrapper and the branching/signing is
// unit-tested directly (mirrors shouldPublishEconomics in economics-floor.ts).
export function buildSignedEnvelope(parsed: unknown, key: string): Row {
  let rows: unknown;
  let refreshed_netuids: unknown;
  let captured_at: unknown;
  let payload: string;
  if (Array.isArray(parsed)) {
    rows = parsed;
    payload = JSON.stringify(rows);
  } else if (parsed && typeof parsed === "object") {
    const parsedRow = parsed as Row;
    rows = parsedRow.rows;
    refreshed_netuids = parsedRow.refreshed_netuids;
    captured_at = parsedRow.captured_at;
    if (!Array.isArray(rows)) {
      throw new Error("staged payload rows must be a JSON array");
    }
    payload = JSON.stringify({ rows, refreshed_netuids, captured_at });
  } else {
    throw new Error("staged payload must be a JSON array or staging object");
  }

  const hmac_sha256 = createHmac("sha256", key).update(payload).digest("hex");
  const envelope: Row = { schema_version: 1, hmac_sha256, rows };
  if (refreshed_netuids !== undefined)
    envelope.refreshed_netuids = refreshed_netuids;
  if (captured_at !== undefined) envelope.captured_at = captured_at;
  return envelope;
}

function main(): void {
  const [inputPath, outputPath = inputPath] = process.argv.slice(2);
  const key = process.env.METAGRAPH_STAGING_SIGNING_KEY;
  if (!inputPath || !key) {
    throw new Error(
      "usage: METAGRAPH_STAGING_SIGNING_KEY=... node scripts/sign-staged-neurons.ts <input> [output]",
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
