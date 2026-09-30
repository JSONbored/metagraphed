import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { readArtifact } from "../workers/storage.ts";
import { registryManifestKey, registryObjectKey } from "../src/registry-kv.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { mockEnv, type Row } from "./row-type.ts";

afterEach(resetModuleState);

test("real MCP resource discovery coalesces pointer reads and preserves every profile and page", async () => {
  const digest = "a".repeat(64);
  const subnets = Array.from({ length: 120 }, (_, netuid) => ({
    netuid,
    name: `Subnet ${netuid}`,
  }));
  const providers = Array.from({ length: 20 }, (_, i) => ({
    slug: `provider-${i}`,
    name: `Provider ${i}`,
  }));
  const schemas = Array.from({ length: 10 }, (_, i) => ({
    surface_id: `schema-${i}`,
    content_type: "application/json",
  }));
  const records = [
    {
      path: "/metagraph/subnets.json",
      sha256: "b".repeat(64),
      bytes: new TextEncoder().encode(JSON.stringify({ subnets })).buffer,
    },
    {
      path: "/metagraph/providers.json",
      sha256: "c".repeat(64),
      bytes: new TextEncoder().encode(JSON.stringify({ providers })).buffer,
    },
  ];
  let pointerReads = 0;
  let objectReads = 0;
  let assetReads = 0;
  let releasePointer!: (pointer: { registry_manifest_sha256: string }) => void;
  let announceLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    announceLookup = resolve;
  });
  const pointer = new Promise<{ registry_manifest_sha256: string }>(
    (resolve) => {
      releasePointer = resolve;
    },
  );
  const env = mockEnv({
    METAGRAPH_CONTROL: {
      async get(key: string) {
        if (key === "metagraph:latest") {
          pointerReads++;
          announceLookup();
          return pointer;
        }
        if (key === registryManifestKey(digest)) {
          return {
            version: 1,
            artifacts: records.map(({ path, sha256, bytes }) => ({
              path,
              sha256,
              size_bytes: bytes.byteLength,
            })),
          };
        }
        objectReads++;
        return (
          records.find((r) => registryObjectKey(r.sha256) === key)?.bytes ??
          null
        );
      },
    },
    ASSETS: {
      async fetch(request: Request) {
        assert.equal(
          new URL(request.url).pathname,
          "/metagraph/schemas/index.json",
        );
        assetReads++;
        return Response.json({ schemas });
      },
    },
  });
  async function page(path: string, cursor?: string) {
    const response = await handleMcpRequest(
      new Request(`https://mcp.invalid${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/list",
          params: cursor ? { cursor } : {},
        }),
      }),
      env,
      { readArtifact },
    );
    assert.equal(response.status, 200);
    const bytes = await response.text();
    return { bytes, result: (JSON.parse(bytes) as Row).result as Row };
  }
  const first = page("/mcp");
  await lookupStarted;
  assert.equal(
    pointerReads,
    1,
    "two parallel registry artifacts share one cold lookup",
  );
  releasePointer({ registry_manifest_sha256: digest });
  const initial = await first;
  assert.equal(objectReads, 2, "both immutable artifacts are still read");
  assert.equal(assetReads, 0, "the first page does not need schema entries");
  for (const path of ["/mcp/core", "/mcp?catalog=full"]) {
    assert.equal(
      (await page(path)).bytes,
      initial.bytes,
      "profiles retain identical resource response bytes",
    );
  }
  const resources: Row[] = [];
  const pageBytes: number[] = [];
  const schemaReadsByPage: number[] = [];
  let priorAssetReads = 0;
  let current = initial;
  for (;;) {
    assert.ok(current.result.resources.length <= 100);
    resources.push(...current.result.resources);
    pageBytes.push(Buffer.byteLength(current.bytes));
    schemaReadsByPage.push(assetReads - priorAssetReads);
    priorAssetReads = assetReads;
    if (!current.result.nextCursor) break;
    current = await page("/mcp", current.result.nextCursor);
  }
  const uris = new Set(resources.map((r) => r.uri));
  assert.equal(
    uris.size,
    resources.length,
    "no duplicated resource across pages",
  );
  for (const { netuid } of subnets) {
    assert.ok(uris.has(`metagraph://subnet/${netuid}`));
    assert.ok(uris.has(`metagraph://subnet/${netuid}/status`));
  }
  for (const { slug } of providers)
    assert.ok(uris.has(`metagraph://provider/${slug}`));
  for (const { surface_id } of schemas)
    assert.ok(uris.has(`metagraph://schema/${surface_id}`));
  assert.ok(uris.has("metagraph://registry/schemas"));
  assert.equal(pointerReads, 1);
  assert.deepEqual(schemaReadsByPage, [0, 0, 1]);
  assert.deepEqual(pageBytes, [20628, 20468, 15503]);
  console.log(
    "MCP_RESOURCE_POINTER_FIXTURE",
    JSON.stringify({
      runtime: process.version,
      coldDiscoveryPointerReadsBefore: 2,
      coldDiscoveryPointerReadsAfter: 1,
      baseline:
        "two parallel published artifact reads in prior source and native traces",
      immutableArtifactReadsPerPage: 2,
      schemaAssetReadsByPageBefore: [1, 1, 1],
      schemaAssetReadsByPageAfter: schemaReadsByPage,
      schemaIndexResponseBytes: Buffer.byteLength(JSON.stringify({ schemas })),
      resources: resources.length,
      pages: pageBytes.length,
      pageBytes,
      profileResponseBytesIdentical: true,
    }),
  );
});
