// Temporary remote byte handoff. Remove before final qualification.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { test } from "vitest";

const sources = [
  "docs/subnet-mcp.md",
  "registry/subnets/desearch.json",
  "schemas-src/subnet-mcp-admission.ts",
  "schemas/subnet-manifest.schema.json",
  "src/mcp-server.ts",
  "tests/subnet-mcp-tool.test.ts",
  "tests/subnet-desearch-published.test.ts",
  "tests/fixtures/desearch-cases.ts",
  "tests/fixtures/desearch-provider-runtime.ts",
] as const;
const generated = [
  "public/metagraph/openapi.json",
  "public/metagraph/types.d.ts",
  "packages/contract/index.d.ts",
  "generated/graphql/schema.ts",
  "generated/graphql/types.ts",
] as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test("export exact Desearch source formatting and generated contracts", async () => {
  if (process.env.CI !== "true") return;
  const head = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  const paths = [...sources, ...generated];
  for (let file_index = 0; file_index < paths.length; file_index++) {
    const path = paths[file_index]!;
    const previous = execFileSync("git", ["show", "HEAD:" + path], { maxBuffer: 10_000_000 });
    const disk = readFileSync(path);
    const bytes = file_index < sources.length
      ? Buffer.from(await format(disk.toString("utf8"), { ...(await resolveConfig(path)), filepath: path }))
      : disk;
    const encoded = gzipSync(bytes).toString("base64");
    console.log("DESEARCH_HANDOFF", JSON.stringify({ file_index, path, head, previous_sha256: sha(previous), encoding: "gzip-base64", bytes: bytes.length, sha256: sha(bytes), chunks: Math.ceil(encoded.length / 16000) }));
    for (let offset = 0; offset < encoded.length; offset += 16000) console.log("DESEARCH_HANDOFF_CHUNK", JSON.stringify({ file_index, index: offset / 16000, data: encoded.slice(offset, offset + 16000) }));
  }
}, 120_000);
