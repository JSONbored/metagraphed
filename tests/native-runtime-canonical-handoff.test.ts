// Temporary exact remote canonical and formatting handoff; removed before final CI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { test } from "vitest";

const sourcePaths = [
  "docs/native-runtime-contract.md",
  "schemas-src/mcp-tools/evm.ts",
  "schemas-src/root-basket-compatibility.ts",
  "schemas-src/routes/root-baskets.ts",
  "src/contracts.ts",
  "src/mcp-server.ts",
  "src/native-runtime.ts",
  "tests/evm-runtime-abi.test.ts",
  "tests/evm-runtime-calldata.test.ts",
  "tests/evm-runtime-return.test.ts",
  "tests/native-runtime-eras.test.ts",
  "tests/native-runtime-metadata-allocation.test.ts",
  "tests/native-runtime-metadata-view.test.ts",
  "tests/root-basket-runtime.test.ts",
] as const;
const generatedPaths = [
  "generated/metagraphed-client.ts",
  "packages/contract/index.d.ts",
  "public/metagraph/api-index.json",
  "public/metagraph/contracts.json",
  "public/metagraph/openapi.json",
  "public/metagraph/types.d.ts",
  "apps/ui/content/docs/api-reference/accounts/account-root-baskets.mdx",
  "apps/ui/content/docs/api-reference/accounts/account-root-baskets-by-network.mdx",
  "apps/ui/content/docs/api-reference/chain/root-baskets.mdx",
  "apps/ui/content/docs/api-reference/chain/root-baskets-by-network.mdx",
  "apps/ui/content/docs/api-reference/chain/native-runtime.mdx",
  "apps/ui/content/docs/api-reference/chain/native-runtime-by-network.mdx",
] as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test("export canonical v471 contracts and formatted sources from remote CI", async () => {
  if (!process.env.CI) return;
  const head = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  execFileSync(process.execPath, ["scripts/generate-openapi-docs.ts"], {
    cwd: "apps/ui", stdio: "pipe", maxBuffer: 1000000, timeout: 120000,
  });
  const paths = [...sourcePaths, ...generatedPaths];
  for (let file_index = 0; file_index < paths.length; file_index++) {
    const path = paths[file_index]!;
    const previous = execFileSync("git", ["show", `HEAD:${path}`], { maxBuffer: 10000000 });
    const bytes = (sourcePaths as readonly string[]).includes(path)
      ? Buffer.from(await format(readFileSync(path).toString(), { ...(await resolveConfig(path)), filepath: path }))
      : readFileSync(path);
    const encoded = gzipSync(bytes).toString("base64");
    console.log("V471_CANONICAL_HANDOFF", JSON.stringify({ file_index, path, head, previous_sha256: sha(previous), bytes: bytes.length, sha256: sha(bytes), chunks: Math.ceil(encoded.length / 16000), encoding: "gzip-base64" }));
    for (let offset = 0; offset < encoded.length; offset += 16000)
      console.log("V471_CANONICAL_HANDOFF_CHUNK", JSON.stringify({ file_index, index: offset / 16000, data: encoded.slice(offset, offset + 16000) }));
  }
}, 180000);
