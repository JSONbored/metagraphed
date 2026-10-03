import { test } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";

test("emit remote published-catalog formatting", async () => {
  const path = "tests/subnet-mcp-published-contract.test.ts";
  const previous = await readFile(path, "utf8");
  const formatted = await format(previous, {
    ...(await resolveConfig(path)),
    filepath: path,
  });
  const sha = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const payload = gzipSync(JSON.stringify({
    head: process.env.GITHUB_SHA,
    path,
    previous_sha256: sha(previous),
    sha256: sha(formatted),
    size: Buffer.byteLength(formatted),
    text: formatted,
  })).toString("base64");
  for (let offset = 0; offset < payload.length; offset += 4096)
    console.log("MCP_PUBLISHED_FORMAT", JSON.stringify({
      offset,
      total: payload.length,
      data: payload.slice(offset, offset + 4096),
    }));
});
