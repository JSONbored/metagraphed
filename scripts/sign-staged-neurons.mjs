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

const rows = JSON.parse(readFileSync(inputPath, "utf8"));
if (!Array.isArray(rows))
  throw new Error("staged neurons payload must be an array");
const payload = JSON.stringify(rows);
const hmac_sha256 = createHmac("sha256", key).update(payload).digest("hex");
writeFileSync(
  outputPath,
  `${JSON.stringify({ schema_version: 1, hmac_sha256, rows })}\n`,
);
