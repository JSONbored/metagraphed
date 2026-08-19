import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { mockEnv } from "./row-type.ts";
import {
  accountFacts,
  r2CardCache,
  cardKey,
  factsDigest,
  handleEntityOgImage,
  matchEntityCard,
  renderEntityMarkup,
  subnetFacts,
} from "../src/og-entity-card.ts";

const INDEX = {
  subnets: [
    {
      netuid: 64,
      name: "Chutes",
      integration_readiness: 96,
      surface_count: 76,
      coverage_level: "deep",
    },
    { netuid: 7, name: "Nameless" },
  ],
};

const OK_ARTIFACT = async () => ({ ok: true, data: INDEX });
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
  test("a subnet's published facts, and only the ones it has", () => {
    const facts = subnetFacts(INDEX, 64);
    assert.equal(facts?.title, "Chutes");
    assert.equal(facts?.kind, "Bittensor subnet 64");
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
    assert.ok(key.startsWith("cache/og/"));
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
    assert.ok(markup.includes("&lt;script&gt;"));
    assert.ok(markup.includes("&amp;"));
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
    fetch: async () => new Response("png", { status: 200 }),
  };

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
        render: async () => PNG,
        writeCard: async (key) => {
          written.push(key);
        },
      },
    );
    assert.equal(written.length, 1);
    assert.ok(written[0].startsWith("cache/og/subnets/64-"));
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
          new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }),
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
