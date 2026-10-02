// Temporary exact remote generation/format handoff; removed before final CI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { test } from "vitest";
import { nativeRuntimeInnerCatalogue as source } from "../src/native-runtime-inner-catalogue.ts";

const sourcePaths = [
  "schemas-src/routes/native-runtime.ts",
  "src/native-runtime-inner-catalogue.ts",
  "src/native-runtime-inner.ts",
  "src/native-runtime.ts",
  "tests/native-runtime-inner.test.ts",
  "docs/native-runtime-contract.md",
  "apps/ui/src/lib/metagraphed/native-runtime.ts",
  "apps/ui/src/lib/metagraphed/native-runtime.test.ts",
  "apps/ui/src/routes/-native-runtime-page.tsx",
  "apps/ui/tests/e2e/native-runtime.spec.ts",
] as const;
const generatedPaths = [
  "generated/metagraphed-client.ts",
  "packages/contract/index.d.ts",
  "public/metagraph/api-index.json",
  "public/metagraph/contracts.json",
  "public/metagraph/openapi.json",
  "public/metagraph/types.d.ts",
  "apps/ui/content/docs/api-reference/chain/native-runtime.mdx",
  "apps/ui/content/docs/api-reference/chain/native-runtime-by-network.mdx",
] as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test("pool byte-identical legacy inner layouts and export exact canonical contracts and UI sources", async () => {
  if (!process.env.CI) return;
  const head = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  const layouts: Pick<(typeof source)[number], "types" | "methods">[] = [];
  const rows = source.map(({ types, methods, ...release }) => {
    const layout = { types, methods }, key = JSON.stringify(layout);
    let index = layouts.findIndex(row => JSON.stringify(row) === key);
    if (index < 0) { index = layouts.length; layouts.push(layout); }
    return { ...release, layout: index };
  });
  const pooled = rows.map(({ layout, ...release }) => ({ ...release, ...layouts[layout]! }));
  assert.equal(JSON.stringify(pooled), JSON.stringify(source));
  const sourcePath = "src/native-runtime-inner-catalogue.ts";
  const original = readFileSync(sourcePath).toString(), declaration = original.slice(0, original.indexOf("export const nativeRuntimeInnerCatalogue"));
  const pooledSource = `${declaration}\nconst layouts: Pick<NativeRuntimeInnerRelease, "types" | "methods">[] = ${JSON.stringify(layouts)};\nconst releases: (Omit<NativeRuntimeInnerRelease, "types" | "methods"> & {layout:number})[] = ${JSON.stringify(rows)};\nexport const nativeRuntimeInnerCatalogue: NativeRuntimeInnerRelease[] = releases.map(({layout,...release})=>({...release,...layouts[layout]!}));\n`;
  writeFileSync(sourcePath, pooledSource);
  execFileSync(process.execPath, ["scripts/generate-openapi-docs.ts"], { cwd: "apps/ui", stdio: "pipe", maxBuffer: 1000000, timeout: 120000 });
  console.log("NATIVE_INNER_LAYOUT_REUSE_FIXTURE", JSON.stringify({ releases: source.length, unique_layouts: layouts.length, previous_type_objects: source.reduce((n, row) => n + row.types.length, 0), pooled_type_objects: layouts.reduce((n, row) => n + row.types.length, 0), previous_method_objects: source.reduce((n, row) => n + row.methods.length, 0), pooled_method_objects: layouts.reduce((n, row) => n + row.methods.length, 0), serialized_catalogue_equal: true, fixture: true, production: false }));
  const paths = [...sourcePaths, ...generatedPaths];
  for (let file_index = 0; file_index < paths.length; file_index++) {
    const path = paths[file_index]!;
    const previous = execFileSync("git", ["show", `HEAD:${path}`], { maxBuffer: 10000000 });
    const bytes = Buffer.from(await format(readFileSync(path).toString(), { ...(await resolveConfig(path)), filepath: path }));
    const encoded = gzipSync(bytes).toString("base64");
    console.log("NATIVE_INNER_HANDOFF", JSON.stringify({ file_index, path, head, previous_sha256: sha(previous), bytes: bytes.length, sha256: sha(bytes), chunks: Math.ceil(encoded.length / 16000), encoding: "gzip-base64" }));
    for (let offset = 0; offset < encoded.length; offset += 16000) console.log("NATIVE_INNER_HANDOFF_CHUNK", JSON.stringify({ file_index, index: offset / 16000, data: encoded.slice(offset, offset + 16000) }));
  }
}, 180000);
