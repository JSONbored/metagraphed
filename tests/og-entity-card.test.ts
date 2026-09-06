import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { mockEnv } from "./row-type.ts";
import { CARD_VERSION } from "../src/og-card-style.ts";
import {
  accountFacts,
  fetchLogoBytes,
  cardText,
  r2CardCache,
  cardKey,
  factsDigest,
  handleEntityOgImage,
  matchEntityCard,
  renderEntityMarkup,
  subnetFacts,
} from "../src/og-entity-card.ts";

const FALLBACK_PNG = readFileSync(
  new URL("../public/brand/og-fallback.png", import.meta.url),
);

const INDEX = {
  subnets: [
    {
      netuid: 64,
      name: "Chutes",
      integration_readiness: 96,
      surface_count: 76,
      coverage_level: "deep",
      logo_url: "https://metagraph.sh/logos/cache/x.png",
      symbol: "ش",
    },
    { netuid: 7, name: "Nameless" },
  ],
};

const OK_ARTIFACT = async () => ({ ok: true, data: INDEX });
/** Explicit "this subnet's logo did not load". Without it these tests reach the
 * real `fetch`, where the outbound-fetch guard refuses them -- which happens to
 * exercise the right path, but by accident and only while that guard exists. */
const NO_LOGO = async () => null;
const PNG = new Uint8Array([137, 80, 78, 71]).buffer;

describe("which paths are entity cards", () => {
  test("subnet and account paths match", () => {
    assert.deepEqual(matchEntityCard("/og/subnets/64.png"), {
      kind: "subnets",
      subject: "64",
    });
    const ss58 = "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3";
    assert.deepEqual(matchEntityCard(`/og/accounts/${ss58}.png`), {
      kind: "accounts",
      subject: ss58,
    });
  });

  test("a netuid outside the u16 range is not a subnet", () => {
    // The rest of this API enforces 0..65535. A path outside it is not a card
    // with no data, it is not a subnet -- so it must fall through to the
    // caller's dispatch rather than render a fallback under a subnet URL.
    assert.equal(matchEntityCard("/og/subnets/70000.png"), null);
  });

  test("the landing card and unrelated paths are left alone", () => {
    assert.equal(matchEntityCard("/og.png"), null);
    assert.equal(matchEntityCard("/og"), null);
    assert.equal(matchEntityCard("/api/v1/subnets/64"), null);
    assert.equal(matchEntityCard("/og/subnets/64.jpg"), null);
  });

  test("a malformed ss58 is not an account", () => {
    assert.equal(matchEntityCard("/og/accounts/not-an-address.png"), null);
    // 0, O, I and l are not in the ss58 alphabet.
    assert.equal(matchEntityCard(`/og/accounts/${"0".repeat(48)}.png`), null);
  });
});

describe("the facts a card draws", () => {
  test("rejects invalid count and score domains without hiding other known facts", () => {
    for (const surface_count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const facts = subnetFacts(
        { subnets: [{ netuid: 19, surface_count, integration_readiness: 0 }] },
        19,
      );
      assert.deepEqual(facts?.stats, [{ label: "Readiness", value: "0/100" }]);
    }
    for (const integration_readiness of [-1, 0.5, 101]) {
      const facts = subnetFacts(
        { subnets: [{ netuid: 19, integration_readiness, surface_count: 0 }] },
        19,
      );
      assert.deepEqual(facts?.stats, [{ label: "Surfaces", value: "0" }]);
    }
    assert.deepEqual(
      subnetFacts(
        {
          subnets: [
            { netuid: 19, integration_readiness: 100, surface_count: 101 },
          ],
        },
        19,
      )?.stats,
      [
        { label: "Readiness", value: "100/100" },
        { label: "Surfaces", value: "101" },
      ],
    );
  });
  test("non-finite values remain absent while genuine zero is retained", () => {
    const facts = subnetFacts(
      {
        subnets: [
          {
            netuid: 0,
            integration_readiness: Number.NaN,
            surface_count: Number.POSITIVE_INFINITY,
          },
        ],
      },
      0,
    );
    assert.deepEqual(facts?.stats, []);
    assert.deepEqual(
      subnetFacts(
        {
          subnets: [{ netuid: 0, integration_readiness: 0, surface_count: 0 }],
        },
        0,
      )?.stats,
      [
        { label: "Readiness", value: "0/100" },
        { label: "Surfaces", value: "0" },
      ],
    );
  });
  test("the subnet's own logo and a netuid mark are carried", () => {
    const facts = subnetFacts(INDEX, 64)!;
    assert.equal(facts.logoUrl, "https://metagraph.sh/logos/cache/x.png");
    // The NETUID, not the alpha symbol: those symbols are Greek, Cyrillic and
    // Arabic and Space Grotesk is Latin-only, so subnet 1's α rendered as `?`.
    assert.equal(facts.mark, "64");
  });

  test("a subnet's published facts, and only the ones it has", () => {
    const facts = subnetFacts(INDEX, 64);
    assert.equal(facts?.title, "Chutes");
    assert.equal(facts?.kind, "Bittensor subnet 64");
    assert.equal(facts?.identifier, "Subnet 64");
    assert.deepEqual(
      facts?.stats.map((s) => s.label),
      ["Readiness", "Surfaces", "Coverage"],
    );
  });

  test("absent is ABSENT, never zero", () => {
    // Subnet 7 has a name and nothing else. `absent is null, never zero` is the
    // contract everywhere in this API and a card is not exempt: showing
    // "0/100" for an unmeasured readiness would be a claim we cannot support.
    const facts = subnetFacts(INDEX, 7);
    assert.equal(facts?.title, "Nameless");
    assert.deepEqual(facts?.stats, []);
  });

  test("a subnet not in the index has no card", () => {
    // Not a card with dashes on it -- the branded fallback, which says nothing
    // rather than saying nothing convincingly.
    assert.equal(subnetFacts(INDEX, 999), null);
    assert.equal(subnetFacts({}, 64), null);
    assert.equal(subnetFacts(null, 64), null);
  });

  test("an account card names the address it can stand behind", () => {
    const ss58 = "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3";
    const facts = accountFacts(ss58);
    assert.deepEqual(facts.stats, []);
    assert.equal(facts.subtitle, "Account activity on Bittensor");
    assert.ok(facts.title.startsWith("5F4tQy"));
    assert.ok(facts.title.endsWith("uyHbZAc3".slice(-6)));
  });
});

describe("the cache key", () => {
  test("the digest changes when a drawn value changes", () => {
    const a = subnetFacts(INDEX, 64);
    const b = subnetFacts(
      { subnets: [{ ...INDEX.subnets[0], integration_readiness: 95 }] },
      64,
    );
    assert.notEqual(factsDigest(a!), factsDigest(b!));
    assert.notEqual(
      factsDigest(a!),
      factsDigest({ ...a!, identifier: "Subnet 65" }),
    );
    assert.notEqual(
      factsDigest(a!),
      factsDigest({ ...a!, subtitle: "Context" }),
    );
  });

  test("the digest is stable when nothing drawn changed", () => {
    // A publish that changes fields the card does not draw must re-use the
    // cached PNG rather than re-render an identical image.
    const a = subnetFacts(INDEX, 64);
    const b = subnetFacts(
      { subnets: [{ ...INDEX.subnets[0], description: "different" }] },
      64,
    );
    assert.equal(factsDigest(a!), factsDigest(b!));
  });

  test("the key lives under cache/, not under the artifact prefix", () => {
    // Objects under `metagraph/` are owned by the publish, which reconciles
    // what it finds against what it built; a render this Worker wrote would
    // look like drift to it.
    const key = cardKey("subnets", "64", "abcd1234");
    assert.ok(key.startsWith(`cache/og/v${CARD_VERSION}/`));
    assert.notEqual(
      key,
      "cache/og/subnets/64-abcd1234.png",
      "unchanged facts must not reuse the old artwork",
    );
    assert.ok(!key.includes("metagraph/"));
    assert.ok(key.includes("abcd1234"), "the digest is in the key");
  });
});

describe("the markup", () => {
  test("a third-party subnet name is escaped", () => {
    // Subnet names are registry data a third party controls, and satori parses
    // this as markup.
    const markup = renderEntityMarkup({
      kind: "Bittensor subnet 1",
      title: '<script>alert("x")</script>',
      stats: [{ label: "<b>", value: "&" }],
    });
    assert.ok(!markup.includes("<script>"));
    assert.ok(markup.includes("scriptalert"));
    assert.ok(markup.includes(">&</p>"));
  });

  test("at most three stats are drawn", () => {
    const markup = renderEntityMarkup({
      kind: "k",
      title: "t",
      stats: [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}`, value: `${n}` })),
    });
    assert.ok(markup.includes("L3"));
    assert.ok(!markup.includes("L4"), "a fourth stat would overflow the card");
  });
});

describe("the handler never fails a crawler", () => {
  const url = (p: string) => new URL(`https://api.metagraph.sh${p}`);
  const assets = {
    fetch: async () =>
      new Response(FALLBACK_PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  };

  test("unchanged facts skip legacy artwork and then reuse the versioned render", async () => {
    const facts = subnetFacts(INDEX, 64)!;
    const oldKey = `cache/og/subnets/64-${factsDigest(facts)}.png`;
    const cache = new Map([[oldKey, new Uint8Array([1]).buffer]]);
    let renders = 0;
    for (let request = 0; request < 2; request++) {
      const response = await handleEntityOgImage(
        new Request(url("/og/subnets/64.png")),
        {},
        url("/og/subnets/64.png"),
        {
          assets,
          readArtifact: OK_ARTIFACT,
          fetchLogo: async () => PNG,
          readCard: async (key) => cache.get(key) ?? null,
          writeCard: async (key, bytes) => {
            cache.set(key, bytes);
          },
          render: async () => {
            renders++;
            return PNG;
          },
        },
      );
      assert.deepEqual(await response!.arrayBuffer(), PNG);
    }
    assert.equal(renders, 1);
    assert.equal(cache.size, 2, "legacy cache objects need no purge");
  });

  test("a path that is not a card returns null so dispatch continues", async () => {
    const res = await handleEntityOgImage(
      new Request("https://api.metagraph.sh/og.png"),
      {},
      url("/og.png"),
      { assets },
    );
    assert.equal(res, null);
  });

  test("a render failure falls back, and does NOT 5xx", async () => {
    // A social crawler does not retry and caches what it gets, so a 5xx is a
    // link that unfurls blank for as long as the crawler holds it.
    const res = await handleEntityOgImage(
      new Request("https://api.metagraph.sh/og/subnets/64.png"),
      {},
      url("/og/subnets/64.png"),
      {
        assets,
        readArtifact: OK_ARTIFACT,
        fetchLogo: NO_LOGO,
        render: async () => {
          throw new Error("wasm exploded");
        },
      },
    );
    assert.equal(res?.status, 200);
  });

  test("an artifact read failure falls back", async () => {
    const res = await handleEntityOgImage(
      new Request("https://api.metagraph.sh/og/subnets/64.png"),
      {},
      url("/og/subnets/64.png"),
      {
        assets,
        readArtifact: async () => {
          throw new Error("r2 down");
        },
      },
    );
    assert.equal(res?.status, 200);
  });

  test("a cache-read failure still renders rather than failing", async () => {
    let rendered = false;
    const res = await handleEntityOgImage(
      new Request("https://api.metagraph.sh/og/subnets/64.png"),
      {},
      url("/og/subnets/64.png"),
      {
        assets,
        readArtifact: OK_ARTIFACT,
        fetchLogo: NO_LOGO,
        readCard: async () => {
          throw new Error("cache unreadable");
        },
        render: async () => {
          rendered = true;
          return PNG;
        },
      },
    );
    assert.equal(res?.status, 200);
    assert.ok(rendered, "an unreadable cache must not stop the render");
  });

  test("a cache-WRITE failure does not fail the response the caller already has", async () => {
    const res = await handleEntityOgImage(
      new Request("https://api.metagraph.sh/og/subnets/64.png"),
      {},
      url("/og/subnets/64.png"),
      {
        assets,
        readArtifact: OK_ARTIFACT,
        fetchLogo: async () => PNG,
        render: async () => PNG,
        writeCard: async () => {
          throw new Error("bucket full");
        },
      },
    );
    assert.equal(res?.status, 200);
  });

  test("a cached card is served without rendering", async () => {
    let rendered = 0;
    const res = await handleEntityOgImage(
      new Request("https://api.metagraph.sh/og/subnets/64.png"),
      {},
      url("/og/subnets/64.png"),
      {
        assets,
        readArtifact: OK_ARTIFACT,
        fetchLogo: NO_LOGO,
        readCard: async () => PNG,
        render: async () => {
          rendered += 1;
          return PNG;
        },
      },
    );
    assert.equal(res?.status, 200);
    assert.equal(rendered, 0, "cached per entity, not rendered per request");
  });

  test("the render result is written under the digest key", async () => {
    const written: string[] = [];
    await handleEntityOgImage(
      new Request("https://api.metagraph.sh/og/subnets/64.png"),
      {},
      url("/og/subnets/64.png"),
      {
        assets,
        readArtifact: OK_ARTIFACT,
        fetchLogo: async () => PNG,
        render: async () => PNG,
        writeCard: async (key) => {
          written.push(key);
        },
      },
    );
    assert.equal(written.length, 1);
    assert.ok(written[0].startsWith(`cache/og/v${CARD_VERSION}/subnets/64-`));
  });

  test("a non-GET method is rejected before any work", async () => {
    const res = await handleEntityOgImage(
      new Request("https://api.metagraph.sh/og/subnets/64.png", {
        method: "POST",
      }),
      {},
      url("/og/subnets/64.png"),
      { assets },
    );
    assert.equal(res?.status, 405);
  });
});

describe("the R2 cache accessors", () => {
  test("no binding is a MISS, not an error", async () => {
    // A throw here would take an unfurl down over a cache that was never
    // configured -- the card should simply render uncached.
    const { readCard } = r2CardCache({});
    assert.equal(await readCard!("cache/og/subnets/64-abc.png"), null);
  });

  test("an absent object is a miss", async () => {
    const { readCard } = r2CardCache({
      METAGRAPH_ARCHIVE: { get: async () => null },
    });
    assert.equal(await readCard!("cache/og/subnets/64-abc.png"), null);
  });

  test("a present object is read to completion", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const { readCard } = r2CardCache({
      METAGRAPH_ARCHIVE: {
        get: async () => ({ arrayBuffer: async () => bytes }),
      },
    });
    assert.equal(await readCard!("cache/og/subnets/64-abc.png"), bytes);
  });

  test("the write carries the content type, so R2 serves it as an image", async () => {
    const seen: { key?: string; type?: string } = {};
    const { writeCard } = r2CardCache({
      METAGRAPH_ARCHIVE: {
        put: async (key, _body, options) => {
          seen.key = key;
          seen.type = options?.httpMetadata?.contentType;
        },
      },
    });
    await writeCard!("cache/og/subnets/64-abc.png", new Uint8Array([1]).buffer);
    assert.equal(seen.key, "cache/og/subnets/64-abc.png");
    assert.equal(seen.type, "image/png");
  });

  test("writing with no binding is a no-op rather than a throw", async () => {
    const { writeCard } = r2CardCache({});
    await writeCard!("k", new Uint8Array([1]).buffer);
  });
});

describe("the route, through the worker's own dispatch", () => {
  test("an entity-card path is served rather than falling through to 404", async () => {
    // The dispatch branch itself: a card path must return the card's response
    // and stop, not continue into the artifact/404 handling below it. Driven
    // down the FALLBACK path (no archive binding, no registry artifact) so this
    // asserts the routing without instantiating the wasm renderer.
    const env = mockEnv({
      ASSETS: {
        fetch: async () =>
          new Response(FALLBACK_PNG, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      },
    });
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/og/subnets/64.png"),
      env as never,
      { waitUntil: () => {} } as never,
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
  });

  test("a path that only looks like one falls through to normal routing", async () => {
    const env = mockEnv({});
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/og/subnets/notanumber.png"),
      env as never,
      { waitUntil: () => {} } as never,
    );
    assert.notEqual(res.headers.get("content-type"), "image/png");
  });
});

describe("the font subset", () => {
  test("covers every glyph the card draws", () => {
    // loadGoogleFont subsets to `text`. A glyph missing from it renders as a
    // blank box, so the subset has to be derived from the card rather than
    // guessed at -- the title is a third-party subnet name and can contain
    // anything.
    const facts = {
      kind: "Bittensor subnet 64",
      title: "Chutes",
      stats: [{ label: "Readiness", value: "96/100" }],
    };
    const text = cardText(facts);
    for (const glyph of "Chutes96/100") {
      assert.ok(text.includes(glyph), `missing glyph: ${glyph}`);
    }
    // The subset must carry sentence-case labels exactly as painted.
    assert.ok(text.includes("Readiness"));
    assert.ok(text.includes("api.metagraph.sh"));
  });
});

describe("the logo is inlined, and only from our own cache", () => {
  const url = (p: string) => new URL(`https://api.metagraph.sh${p}`);
  const assets = {
    fetch: async () =>
      new Response(FALLBACK_PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  };
  const artifact = async () => ({ ok: true, data: INDEX });

  test("a logo on our cache is fetched and inlined", async () => {
    let asked: string | null = null;
    let markup = "";
    await handleEntityOgImage(
      new Request("https://api.metagraph.sh/og/subnets/64.png"),
      {},
      url("/og/subnets/64.png"),
      {
        assets,
        readArtifact: artifact,
        fetchLogo: async (u) => {
          asked = u;
          return new Uint8Array([1, 2, 3]).buffer;
        },
        render: async (m) => {
          markup = m;
          return new Uint8Array([137]).buffer;
        },
      },
    );
    assert.equal(asked, "https://metagraph.sh/logos/cache/x.png");
    assert.ok(markup.includes("data:image/png;base64,"));
  });

  test("a logo that will not load falls back to the mark, not to failure", async () => {
    // The subnet still has a name and a number. A dead logo host must not cost
    // the unfurl.
    let markup = "";
    const res = await handleEntityOgImage(
      new Request("https://api.metagraph.sh/og/subnets/64.png"),
      {},
      url("/og/subnets/64.png"),
      {
        assets,
        readArtifact: artifact,
        fetchLogo: async () => {
          throw new Error("logo host down");
        },
        render: async (m) => {
          markup = m;
          return new Uint8Array([137]).buffer;
        },
      },
    );
    assert.equal(res?.status, 200);
    assert.ok(!markup.includes("data:image/png"));
    assert.ok(markup.includes(">64<"), "the netuid badge is drawn instead");
  });

  test("the digest keys on the logo URL, not on its bytes", async () => {
    // The URL is already content-addressed by the logo cache, so a new logo is
    // a new URL. Hashing megabytes of PNG per request to learn the same thing
    // would be absurd.
    const a = subnetFacts(INDEX, 64)!;
    const b = { ...a, logo: "data:image/png;base64,DIFFERENT" };
    assert.equal(factsDigest(a), factsDigest(b));
    const c = { ...a, logoUrl: "https://metagraph.sh/logos/cache/y.png" };
    assert.notEqual(factsDigest(a), factsDigest(c));
  });
});

describe("the font subset", () => {
  test("covers the mark, or the subnets without logos render a blank box", () => {
    const facts = subnetFacts(INDEX, 7)!;
    assert.ok(cardText(facts).includes("7"), "the netuid badge glyph");
  });

  test("covers the identifier and sentence-case labels the card draws", () => {
    // The explicit identifier stays beside the subject after the generic
    // category badge is removed.
    const facts = subnetFacts(INDEX, 64)!;
    const text = cardText(facts);
    assert.ok(text.includes("Subnet 64"));
    assert.ok(text.includes("Readiness"));
  });
});

describe("the logo fetch is allowlisted", () => {
  // `logo_url` is a registry row a contributor can edit. Without this, that row
  // points the Worker at any host it likes and the render inlines whatever
  // comes back -- an SSRF with an image on the end of it.
  const withFetch = async (fn: () => Promise<unknown>) => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(FALLBACK_PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;
    try {
      const result = await fn();
      return { result, seen };
    } finally {
      globalThis.fetch = original;
    }
  };

  test("our own logo cache over https is fetched", async () => {
    const { result, seen } = await withFetch(() =>
      fetchLogoBytes("https://metagraph.sh/logos/cache/x.png"),
    );
    assert.ok(
      result &&
        typeof result === "object" &&
        "bytes" in result &&
        result.bytes instanceof ArrayBuffer,
    );
    assert.deepEqual(seen, ["https://metagraph.sh/logos/cache/x.png"]);
  });

  test("another host is refused WITHOUT being fetched", async () => {
    const { result, seen } = await withFetch(() =>
      fetchLogoBytes("https://evil.example/x.png"),
    );
    assert.equal(result, null);
    assert.deepEqual(seen, [], "the request must never leave");
  });

  test("http is refused even on our own host", async () => {
    const { result, seen } = await withFetch(() =>
      fetchLogoBytes("http://metagraph.sh/logos/cache/x.png"),
    );
    assert.equal(result, null);
    assert.deepEqual(seen, []);
  });

  test("a subdomain is not our host", async () => {
    const { result, seen } = await withFetch(() =>
      fetchLogoBytes("https://metagraph.sh.evil.example/x.png"),
    );
    assert.equal(result, null);
    assert.deepEqual(seen, []);
  });

  test("a non-200 is a miss, not a broken card", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("gone", { status: 404 })) as typeof fetch;
    try {
      assert.equal(
        await fetchLogoBytes("https://metagraph.sh/logos/cache/x.png"),
        null,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the badge", () => {
  test("a wide netuid gets the smaller face so it fits the identity area", () => {
    const wide = renderEntityMarkup({
      kind: "k",
      title: "t",
      stats: [],
      mark: "65535",
    });
    const one = renderEntityMarkup({
      kind: "k",
      title: "t",
      stats: [],
      mark: "1",
    });
    assert.ok(wide.includes("font-size:58px"));
    assert.ok(one.includes("font-size:108px"));
  });

  test("no logo and no mark draws no badge rather than an empty square", () => {
    const markup = renderEntityMarkup({ kind: "k", title: "t", stats: [] });
    assert.ok(!markup.includes("width:88px;height:88px"));
  });
});

describe("the remaining defaults", () => {
  test("the digest handles facts with no logo and no mark", () => {
    // accountFacts carries neither; the digest must still be stable rather
    // than keying on `undefined`.
    const a = { kind: "k", title: "t", stats: [] };
    const b = { kind: "k", title: "t", stats: [], logoUrl: null, mark: null };
    assert.equal(factsDigest(a), factsDigest(b));
  });

  test("without an injected fetcher the handler uses the allowlisted one", async () => {
    // The default path: no `fetchLogo` dep, so the real fetchLogoBytes runs and
    // its allowlist applies. Proven by pointing the row off-host -- the render
    // still happens and no request leaves.
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch;
    let markup = "";
    try {
      const res = await handleEntityOgImage(
        new Request("https://api.metagraph.sh/og/subnets/64.png"),
        {},
        new URL("https://api.metagraph.sh/og/subnets/64.png"),
        {
          assets: {
            fetch: async () =>
              new Response(FALLBACK_PNG, {
                status: 200,
                headers: { "content-type": "image/png" },
              }),
          },
          readArtifact: async () => ({
            ok: true,
            data: {
              subnets: [
                {
                  netuid: 64,
                  name: "Chutes",
                  logo_url: "https://evil.example/x.png",
                },
              ],
            },
          }),
          render: async (m) => {
            markup = m;
            return new Uint8Array([137]).buffer;
          },
        },
      );
      assert.equal(res?.status, 200);
      assert.deepEqual(seen, [], "an off-host logo is never requested");
      assert.ok(!markup.includes("data:image/png"), "and is not inlined");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("account cards", () => {
  test("an account renders without any logo lookup at all", async () => {
    // An account has no logo_url, so the fetch branch must be skipped rather
    // than entered with an empty URL.
    let markup = "";
    let logoAsked = false;
    const ss58 = "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3";
    const res = await handleEntityOgImage(
      new Request(`https://api.metagraph.sh/og/accounts/${ss58}.png`),
      {},
      new URL(`https://api.metagraph.sh/og/accounts/${ss58}.png`),
      {
        assets: {
          fetch: async () =>
            new Response(FALLBACK_PNG, {
              status: 200,
              headers: { "content-type": "image/png" },
            }),
        },
        fetchLogo: async () => {
          logoAsked = true;
          return null;
        },
        render: async (m) => {
          markup = m;
          return new Uint8Array([137]).buffer;
        },
      },
    );
    assert.equal(res?.status, 200);
    assert.equal(logoAsked, false, "no logo lookup for an account");
    assert.ok(markup.includes("5F4tQy"), "the address is drawn");
    assert.ok(!markup.includes("border-radius:30px"), "and no badge");
  });
});
