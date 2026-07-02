#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [inputPath, outputPath = inputPath] = process.argv.slice(2);
const key = process.env.METAGRAPH_STAGING_SIGNING_KEY;
if (!inputPath || !key) {
  throw new Error(
    "usage: METAGRAPH_STAGING_SIGNING_KEY=... node scripts/sign-staged-neurons.mjs <input> [output]",
  );
}

const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
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
writeFileSync(outputPath, `${JSON.stringify(envelope)}\n`);
