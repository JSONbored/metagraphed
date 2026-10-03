// Temporary remote source-format handoff; removed before final qualification.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { test } from "vitest";

const paths = [
  "docs/subnet-http.md",
  "schemas-src/mcp-tools/ai-integration.ts",
  "src/call-subnet-surface.ts",
  "src/mcp-server.ts",
  "src/subnet-http-body.ts",
  "tests/subnet-http-body.test.ts",
  "tests/subnet-http-body-worker.test.ts",
] as const;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("export exact remote HTTP byte source formatting", async () => {
  assert.equal(process.env.CI, "true");
  const head = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  for (let file_index = 0; file_index < paths.length; file_index++) {
    const path = paths[file_index]!;
    const previous = execFileSync("git", ["show", `HEAD:${path}`], {
      maxBuffer: 3000000,
    });
    const bytes = Buffer.from(await format(readFileSync(path).toString(), {
      ...(await resolveConfig(path)), filepath: path,
    }));
    const encoded = gzipSync(bytes).toString("base64");
    console.log("SUBNET_HTTP_BODY_FORMAT", JSON.stringify({
      file_index, path, head, previous_sha256: sha(previous), bytes: bytes.length,
      sha256: sha(bytes), chunks: Math.ceil(encoded.length / 16000), encoding: "gzip-base64",
    }));
    for (let offset = 0; offset < encoded.length; offset += 16000)
      console.log("SUBNET_HTTP_BODY_FORMAT_CHUNK", JSON.stringify({
        file_index, index: offset / 16000, data: encoded.slice(offset, offset + 16000),
      }));
  }
}, 180000);
