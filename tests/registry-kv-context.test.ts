import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { readPublishedRegistryJson } from "../scripts/registry-kv-context.ts";
import { registryDigest } from "../scripts/registry-kv-store.ts";
import { registryManifestKey, registryObjectKey } from "../src/registry-kv.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("offline builds do not perform remote baseline reads", async () => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  assert.equal(await readPublishedRegistryJson("surfaces.json"), null);
  assert.equal(fetcher.mock.calls.length, 0);
});

test("publication baseline preserves the exact selected JSON without R2 access", async () => {
  // Baseline integrity does not depend on provider pacing. Advance the request
  // clock deterministically so this fixture never waits on real CI timers.
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 500));
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
  vi.stubEnv("METAGRAPH_KV_NAMESPACE_ID", "test-namespace");
  const raw = Buffer.from('{"aliases":[{"from":"old","to":"current"}]}');
  const digest = registryDigest(raw);
  const manifest = Buffer.from(
    JSON.stringify({
      version: 1,
      artifacts: [
        {
          path: "/metagraph/surface-aliases.json",
          sha256: digest,
          size_bytes: raw.byteLength,
        },
      ],
    }),
  );
  const manifestDigest = registryDigest(manifest);
  const values = new Map([
    [
      "metagraph:latest",
      Buffer.from(JSON.stringify({ registry_manifest_sha256: manifestDigest })),
    ],
    [registryManifestKey(manifestDigest), manifest],
    [registryObjectKey(digest), raw],
  ]);
  const fetcher = vi.fn(async (url: string) => {
    assert.ok(url.includes("/storage/kv/namespaces/test-namespace/values/"));
    const key = decodeURIComponent(url.split("/values/")[1]!);
    const value = values.get(key);
    return value ? new Response(value) : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  assert.deepEqual(await readPublishedRegistryJson("surface-aliases.json"), {
    aliases: [{ from: "old", to: "current" }],
  });
  values.set(registryObjectKey(digest), Buffer.from("{}"));
  await assert.rejects(
    readPublishedRegistryJson("surface-aliases.json"),
    /failed integrity/,
  );
});

test("a configured publisher propagates API failures instead of erasing its baseline", async () => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
  vi.stubEnv("METAGRAPH_KV_NAMESPACE_ID", "test-namespace");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  await assert.rejects(readPublishedRegistryJson("surfaces.json"), /HTTP 503/);
});
