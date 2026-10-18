import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  cardKey,
  edgeCardCache,
  factsDigest,
  handleEntityOgImage,
  subnetFacts,
  type EntityCardDeps,
} from "../src/og-entity-card.ts";
import { resolveOgLogo } from "../src/og-logo-manifest.ts";
import { logoManifestFixture } from "./helpers/og-logo-fixture.ts";

const PNG_A = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]).buffer;
const PNG_B = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 2]).buffer;
const CARD_A = new Uint8Array([1, 1]).buffer;
const CARD_B = new Uint8Array([2, 2]).buffer;
const MONOGRAM = new Uint8Array([3, 3]).buffer;
const LONG = "public, max-age=86400, stale-while-revalidate=604800";
const SHORT = "public, max-age=60";
const INDEX = {
  subnets: [
    {
      netuid: 19,
      name: "Curated",
      logo_url: "https://metagraph.sh/logos/curated.webp",
    },
    { netuid: 20, name: "No declared logo" },
  ],
};
const manifest = (bytes: ArrayBuffer, source = "a".repeat(64)) =>
  logoManifestFixture(bytes, "curated.webp", source);

function fixture() {
  const stored = new Map<string, Response>();
  let logo: ArrayBuffer | null = PNG_A;
  let fetches = 0;
  let renders = 0;
  let reads = 0;
  let writes = 0;
  const fetched: string[] = [];
  const rendered: string[] = [];
  const cache = edgeCardCache({
    match: async (url) => {
      reads++;
      return stored.get(String(url))?.clone();
    },
    put: async (url, response) => {
      writes++;
      stored.set(String(url), response.clone());
    },
  });
  return {
    stored,
    fetched,
    rendered,
    counts: () => ({ fetches, renders, reads, writes }),
    setLogo: (value: ArrayBuffer | null) => {
      logo = value;
    },
    async request(
      data: unknown,
      method = "GET",
      overrides: EntityCardDeps = {},
      netuid = 19,
    ) {
      const url = new URL(`https://api.metagraph.sh/og/subnets/${netuid}.png`);
      const response = await handleEntityOgImage(
        new Request(url, { method }),
        {},
        url,
        {
          ...cache,
          logoManifest: data,
          readArtifact: async () => ({ ok: true, data: INDEX }),
          fetchLogo: async (path) => {
            fetches++;
            fetched.push(path);
            return logo;
          },
          render: async (markup) => {
            renders++;
            rendered.push(markup);
            if (markup.includes(Buffer.from(PNG_A).toString("base64")))
              return CARD_A;
            if (markup.includes(Buffer.from(PNG_B).toString("base64")))
              return CARD_B;
            return MONOGRAM;
          },
          ...overrides,
        },
      );
      assert.ok(response);
      return response;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a completed A card cannot survive a same-original-URL replacement with B", async () => {
  const f = fixture();
  const a = manifest(PNG_A);
  const b = manifest(PNG_B, "b".repeat(64));
  assert.deepEqual(await (await f.request(a)).arrayBuffer(), CARD_A);
  assert.deepEqual(await (await f.request(a)).arrayBuffer(), CARD_A);
  assert.deepEqual(f.counts(), { fetches: 1, renders: 1, reads: 2, writes: 1 });
  f.setLogo(PNG_B);
  const changed = await f.request(b);
  assert.equal(changed.headers.get("cache-control"), LONG);
  assert.deepEqual(await changed.arrayBuffer(), CARD_B);
  assert.deepEqual(await (await f.request(b)).arrayBuffer(), CARD_B);
  assert.equal(f.stored.size, 2, "the old complete card is retained unchanged");
  const keys = [...f.stored.keys()];
  for (const data of [a, b]) {
    const entry = data.entries[0];
    assert.ok(keys.some((key) => key.includes(entry.sharing_path)));
    assert.ok(keys.some((key) => key.includes(entry.source_sha256)));
    assert.ok(keys.some((key) => key.includes(entry.sharing_sha256)));
  }
  assert.deepEqual(f.counts(), { fetches: 2, renders: 2, reads: 4, writes: 2 });
  const head = await f.request(b, "HEAD");
  assert.equal(head.headers.get("cache-control"), LONG);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const newer = manifest(PNG_B, "c".repeat(64));
  const pendingHead = await f.request(newer, "HEAD");
  assert.equal(pendingHead.headers.get("cache-control"), SHORT);
  assert.deepEqual(f.counts(), { fetches: 2, renders: 2, reads: 6, writes: 2 });
});

test("missing and wrong-hash derivatives stay incomplete, then recover at the same identity", async () => {
  const f = fixture();
  const b = manifest(PNG_B);
  for (const logo of [null, PNG_A]) {
    f.setLogo(logo);
    const response = await f.request(b);
    assert.equal(response.headers.get("cache-control"), SHORT);
    assert.deepEqual(await response.arrayBuffer(), MONOGRAM);
    assert.equal(f.counts().writes, 0);
  }
  f.setLogo(PNG_B);
  const recovered = await f.request(b);
  assert.equal(recovered.headers.get("cache-control"), LONG);
  assert.deepEqual(await recovered.arrayBuffer(), CARD_B);
  assert.equal(f.counts().writes, 1);
  assert.deepEqual(await (await f.request(b)).arrayBuffer(), CARD_B);
  assert.equal(f.counts().fetches, 3);
  assert.equal(f.counts().renders, 3);
  assert.ok(!f.rendered[0].includes("data:image/png"));
  assert.ok(!f.rendered[1].includes("data:image/png"));
  assert.ok(f.rendered[2].includes("data:image/png"));
});

test("old or unmapped manifests cannot reuse a completed logo or lose expected intent", async () => {
  for (const data of [
    { ...manifest(PNG_A), version: 1 },
    { ...manifest(PNG_A), entries: [] },
    null,
  ]) {
    const f = fixture();
    const facts = subnetFacts(INDEX, 19)!;
    const legacy = cardKey("subnets", "19", factsDigest(facts));
    f.stored.set(
      `https://metagraph.sh/.internal/${legacy}`,
      new Response(CARD_A, { headers: { entity_logo: "included" } }),
    );
    const response = await f.request(data);
    assert.equal(response.headers.get("cache-control"), SHORT);
    assert.deepEqual(await response.arrayBuffer(), MONOGRAM);
    const head = await f.request(data, "HEAD");
    assert.equal(head.headers.get("cache-control"), SHORT);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.deepEqual(f.counts(), {
      fetches: 0,
      renders: 1,
      reads: 0,
      writes: 0,
    });
    assert.equal(f.stored.size, 1);
  }
});

test("an expected derivative uses the bounded first-party fetcher and exact bytes", async () => {
  const f = fixture();
  const a = manifest(PNG_A);
  const resolution = resolveOgLogo(INDEX.subnets[0].logo_url, a);
  assert.ok(resolution.intent === "expected" && resolution.qualified);
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(PNG_A, { headers: { "content-type": "image/png" } });
  });
  const response = await f.request(a, "GET", { fetchLogo: undefined });
  assert.deepEqual(await response.arrayBuffer(), CARD_A);
  assert.deepEqual(fetched, [resolution.url]);
  assert.equal(f.counts().writes, 1);
});

test("intentional absence still reuses a long-lived card without manifest qualification", async () => {
  const f = fixture();
  for (let request = 0; request < 2; request++) {
    const response = await f.request(null, "GET", {}, 20);
    assert.equal(response.headers.get("cache-control"), LONG);
  }
  assert.deepEqual(f.counts(), { fetches: 0, renders: 1, reads: 2, writes: 1 });
});
