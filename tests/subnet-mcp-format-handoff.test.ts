import { test } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";

test("emit remote published-catalog formatting", async () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const files = [];
  for (const path of [
    "src/subnet-mcp-client.ts",
    "tests/subnet-mcp-client.test.ts",
    "tests/subnet-mcp-published-contract.test.ts",
  ]) {
    const previous = await readFile(path, "utf8");
    const text = await format(previous, {
      ...(await resolveConfig(path)),
      filepath: path,
    });
    files.push({
      path,
      previous_sha256: sha(previous),
      sha256: sha(text),
      size: Buffer.byteLength(text),
      text,
    });
  }
  const payload = gzipSync(JSON.stringify({ head: process.env.GITHUB_SHA, files }))
    .toString("base64");
  for (let offset = 0; offset < payload.length; offset += 4096)
    console.log("MCP_CATALOG_FORMAT", JSON.stringify({
      offset,
      total: payload.length,
      data: payload.slice(offset, offset + 4096),
    }));
});
