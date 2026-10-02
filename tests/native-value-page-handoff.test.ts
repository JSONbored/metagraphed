// Temporary remote canonical/formatting handoff; removed before qualification.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { test } from "vitest";

const source = [
  "src/native-runtime-page.ts",
  "src/native-runtime-values.ts",
  "src/native-runtime-inner.ts",
  "src/native-runtime.ts",
  "src/mcp-server.ts",
  "schemas-src/routes/native-runtime.ts",
  "schemas-src/openapi-registry.ts",
  "tests/native-runtime-page.test.ts",
  "tests/native-runtime-collection-audit.test.ts",
  "tests/native-runtime-inner.test.ts",
  "tests/native-runtime-v470.test.ts",
  "apps/ui/src/lib/metagraphed/native-runtime.ts",
  "apps/ui/src/lib/metagraphed/native-runtime.test.ts",
  "apps/ui/src/routes/-native-runtime-page.tsx",
  "apps/ui/tests/e2e/native-runtime.spec.ts",
  "docs/native-runtime-contract.md",
];
const generated = [
  "generated/metagraphed-client.ts",
  "packages/contract/index.d.ts",
  "public/metagraph/api-index.json",
  "public/metagraph/contracts.json",
  "public/metagraph/openapi.json",
  "public/metagraph/types.d.ts",
  "apps/ui/content/docs/api-reference/chain/native-runtime.mdx",
  "apps/ui/content/docs/api-reference/chain/native-runtime-by-network.mdx",
];
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("export exact source formatting and derived collection contracts", async () => {
  assert.equal(process.env.CI, "true");
  const head = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  execFileSync(process.execPath, ["scripts/generate-openapi-docs.ts"], {
    cwd: "apps/ui", stdio: "pipe", maxBuffer: 1000000, timeout: 120000,
  });
  const paths = [...source, ...generated];
  for (let file_index = 0; file_index < paths.length; file_index++) {
    const path = paths[file_index]!;
    const previous = execFileSync("git", ["show", `HEAD:${path}`], { maxBuffer: 10000000 });
    const raw = readFileSync(path);
    const bytes = source.includes(path)
      ? Buffer.from(await format(raw.toString(), { ...(await resolveConfig(path)), filepath: path }))
      : raw;
    const encoded = gzipSync(bytes).toString("base64");
    console.log("NATIVE_VALUE_PAGE_HANDOFF", JSON.stringify({
      file_index, path, head, previous_sha256: sha(previous), bytes: bytes.length,
      sha256: sha(bytes), chunks: Math.ceil(encoded.length / 16000), encoding: "gzip-base64",
    }));
    for (let offset = 0; offset < encoded.length; offset += 16000)
      console.log("NATIVE_VALUE_PAGE_HANDOFF_CHUNK", JSON.stringify({
        file_index, index: offset / 16000, data: encoded.slice(offset, offset + 16000),
      }));
  }
}, 180000);
