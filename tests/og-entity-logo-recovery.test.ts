import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";
import {
  cardKey,
  factsDigest,
  handleEntityOgImage,
  r2CardCache,
  subnetFacts,
  type EntityCardDeps,
} from "../src/og-entity-card.ts";
import { fetchLogoBytes } from "../src/og-entity-logo.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
const COMPLETE = new Uint8Array([137, 80, 78, 71, 1]).buffer;
const LONG = "public, max-age=86400, stale-while-revalidate=604800";
const SHORT = "public, max-age=60";
const LOGO_URL = "https://metagraph.sh/logos/cache/identity.png";
const INDEX = {
  subnets: [
    { netuid: 1, name: "Identity", logo_url: LOGO_URL },
    { netuid: 2, name: "Intentional monogram" },
  ],
};
const ASSETS = {
  fetch: async () =>
    new Response(
      readFileSync(new URL("../public/brand/og-fallback.png", import.meta.url)),
      {
        headers: { "content-type": "image/png" },
      },
    ),
};

function cardRequest(deps: EntityCardDeps, netuid = 1, method = "GET") {
  const url = new URL(`https://api.metagraph.sh/og/subnets/${netuid}.png`);
  return handleEntityOgImage(new Request(url, { method }), {}, url, {
    readArtifact: async () => ({ ok: true, data: INDEX }),
    assets: ASSETS,
    ...deps,
  });
}

function cacheFixture() {
  const stored = new Map<
    string,
    { bytes: ArrayBuffer; metadata?: Record<string, string> }
  >();
  let writes = 0;
  let bodyReads = 0;
  const cache = r2CardCache({
    METAGRAPH_ARCHIVE: {
      get: async (key) => {
        const object = stored.get(key);
        return object
          ? {
              customMetadata: object.metadata,
              arrayBuffer: async () => {
                bodyReads++;
                return object.bytes;
              },
            }
          : null;
      },
      put: async (key, bytes, options) => {
        writes++;
        stored.set(key, { bytes, metadata: options?.customMetadata });
      },
    },
  });
  return { stored, cache, writes: () => writes, bodyReads: () => bodyReads };
}

describe("entity logos recover without changing facts or URLs", () => {
  for (const failure of ["miss", "throw", "empty"] as const) {
    test(`old ambiguous R2 monogram survives a ${failure}, then recovers and caches the logo`, async () => {
      const fixture = cacheFixture();
      const key = cardKey("subnets", "1", factsDigest(subnetFacts(INDEX, 1)!));
      fixture.stored.set(key, { bytes: PNG });
      let fetches = 0;
      let renders = 0;
      const deps: EntityCardDeps = {
        ...fixture.cache,
        fetchLogo: async () => {
          if (++fetches === 1) {
            if (failure === "throw") throw new Error("temporary logo failure");
            return failure === "empty" ? new ArrayBuffer(0) : null;
          }
          return PNG;
        },
        render: async (markup) => {
          renders++;
          return markup.includes("data:image/png;base64") ? COMPLETE : PNG;
        },
      };
      const degraded = (await cardRequest(deps))!;
      assert.equal(degraded.headers.get("cache-control"), SHORT);
      assert.deepEqual(await degraded.arrayBuffer(), PNG);
      assert.equal(fixture.writes(), 0);
      assert.equal(fixture.bodyReads(), 0, "old ambiguous image is not reused");
      assert.equal(
        fixture.stored.get(key)?.metadata,
        undefined,
        "no purge or mutation of old objects",
      );
      const recovered = (await cardRequest(deps))!;
      assert.equal(recovered.headers.get("cache-control"), LONG);
      assert.deepEqual(await recovered.arrayBuffer(), COMPLETE);
      assert.deepEqual(fixture.stored.get(key)?.metadata, {
        entity_logo: "included",
      });
      const reused = (await cardRequest(deps))!;
      assert.equal(reused.headers.get("cache-control"), LONG);
      assert.deepEqual(await reused.arrayBuffer(), COMPLETE);
      const head = (await cardRequest(deps, 1, "HEAD"))!;
      assert.equal(head.headers.get("cache-control"), LONG);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal(fetches, 2);
      assert.equal(renders, 2);
      assert.equal(fixture.writes(), 1);
    });
  }

  test("intentional no-logo cards retain old objects and long caching", async () => {
    const fixture = cacheFixture();
    let fetches = 0;
    let renders = 0;
    const deps = {
      ...fixture.cache,
      fetchLogo: async () => {
        fetches++;
        return PNG;
      },
      render: async () => {
        renders++;
        return PNG;
      },
    };
    for (let request = 0; request < 2; request++) {
      const response = (await cardRequest(deps, 2))!;
      assert.equal(response.headers.get("cache-control"), LONG);
    }
    assert.equal(fetches, 0);
    assert.equal(renders, 1);
    assert.equal(fixture.writes(), 1);
    const key = cardKey("subnets", "2", factsDigest(subnetFacts(INDEX, 2)!));
    fixture.stored.set(key, { bytes: PNG });
    await cardRequest(deps, 2);
    assert.equal(
      renders,
      1,
      "legacy intentionally absent identity stays compatible",
    );
  });

  test("HEAD cache miss promises only the short lifetime while an expected logo is unverified", async () => {
    const deps: EntityCardDeps = {
      fetchLogo: async () => {
        throw new Error("HEAD must not fetch a logo");
      },
      render: async () => {
        throw new Error("HEAD must not render");
      },
    };
    assert.equal(
      (await cardRequest(deps, 1, "HEAD"))!.headers.get("cache-control"),
      SHORT,
    );
    assert.equal(
      (await cardRequest(deps, 2, "HEAD"))!.headers.get("cache-control"),
      LONG,
    );
  });

  test("R2 read and write failures leave a complete response and a later retry", async () => {
    let attempts = 0;
    let writes = 0;
    const cache = r2CardCache({
      METAGRAPH_ARCHIVE: {
        get: async () => ({
          customMetadata: { entity_logo: "included" },
          arrayBuffer: async () => {
            throw new Error("body temporarily unreadable");
          },
        }),
        put: async () => {
          writes++;
          throw new Error("write temporarily unavailable");
        },
      },
    });
    for (let i = 0; i < 2; i++) {
      const response = (await cardRequest({
        ...cache,
        fetchLogo: async () => {
          attempts++;
          return PNG;
        },
        render: async () => COMPLETE,
      }))!;
      assert.equal(response.headers.get("cache-control"), LONG);
      assert.deepEqual(await response.arrayBuffer(), COMPLETE);
    }
    assert.equal(attempts, 2);
    assert.equal(writes, 2);
  });

  test("render failure stays short lived and never records logo completion", async () => {
    const fixture = cacheFixture();
    let attempts = 0;
    const deps: EntityCardDeps = {
      ...fixture.cache,
      fetchLogo: async () => PNG,
      render: async () => {
        if (++attempts === 1) throw new Error("temporary render failure");
        return COMPLETE;
      },
    };
    assert.equal(
      (await cardRequest(deps))!.headers.get("cache-control"),
      SHORT,
    );
    assert.equal(fixture.writes(), 0);
    assert.equal((await cardRequest(deps))!.headers.get("cache-control"), LONG);
    assert.equal(fixture.writes(), 1);
  });

  test("a typed JPEG logo retains its MIME through rendering", async () => {
    let markup = "";
    const response = (await cardRequest({
      fetchLogo: async () => ({ bytes: PNG, contentType: "image/jpeg" }),
      render: async (value) => {
        markup = value;
        return COMPLETE;
      },
    }))!;
    assert.ok(markup.includes("data:image/jpeg;base64,"));
    assert.equal(response.headers.get("cache-control"), LONG);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("logo reads are bounded across headers and body", () => {
  test("missing MIME and mislabeled error bodies never become completed images", async () => {
    vi.stubGlobal("fetch", async () => new Response(PNG));
    assert.equal(await fetchLogoBytes(LOGO_URL), null);
    for (const contentType of ["image/png", "image/jpeg", "image/gif"]) {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response("<html>upstream failed</html>", {
            headers: { "content-type": contentType },
          }),
      );
      assert.equal(await fetchLogoBytes(LOGO_URL), null);
    }
  });

  test("invalid URLs, credentials and nonstandard ports cannot trigger a logo request", async () => {
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches++;
      return new Response(PNG);
    });
    await assert.rejects(fetchLogoBytes("not a URL"));
    for (const url of [
      "https://metagraph.sh:8443/logos/logo.png",
      "https://fixture@metagraph.sh/logos/logo.png",
      "https://:fixture@metagraph.sh/logos/logo.png",
    ])
      assert.equal(await fetchLogoBytes(url), null);
    assert.equal(fetches, 0);
  });

  test("redirect rejection stays retryable at the entity handler", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      assert.equal(init.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://other.example/logo.png" },
      });
    });
    const fixture = cacheFixture();
    const response = (await cardRequest({
      ...fixture.cache,
      render: async () => PNG,
    }))!;
    assert.equal(response.headers.get("cache-control"), SHORT);
    assert.equal(fixture.writes(), 0);
  });

  test("keeps the actual MIME and exact bytes for supported image types", async () => {
    for (const contentType of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/svg+xml",
    ]) {
      const bytes =
        contentType === "image/svg+xml"
          ? new TextEncoder().encode(
              '<svg width="10" height="10"><path d="M0 0L10 10"/></svg>',
            )
          : contentType === "image/jpeg"
            ? new Uint8Array([255, 216, 255, 224])
            : contentType === "image/gif"
              ? new Uint8Array([71, 73, 70, 56, 57, 97])
              : new Uint8Array(PNG);
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        assert.equal(init.redirect, "manual");
        assert.ok(init.signal);
        return new Response(bytes, {
          headers: { "content-type": `${contentType}; charset=binary` },
        });
      });
      const logo = await fetchLogoBytes(LOGO_URL);
      assert.equal(logo?.contentType, contentType);
      assert.deepEqual(logo?.bytes, bytes.buffer);
    }
  });

  for (const type of [
    "text/html",
    "image/webp",
    "image/x-icon",
    "",
    "application/octet-stream",
  ]) {
    test(`rejects unsupported ${type || "missing"} MIME before reading`, async () => {
      let cancelled = false;
      const body = new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      });
      vi.stubGlobal(
        "fetch",
        async () => new Response(body, { headers: { "content-type": type } }),
      );
      assert.equal(await fetchLogoBytes(LOGO_URL), null);
      assert.ok(cancelled);
    });
  }

  test("declared and streamed size limits cancel without buffering an unbounded image", async () => {
    for (const declared of [true, false]) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) =>
          controller.enqueue(new Uint8Array(512 * 1024 + 1)),
        cancel: () => {
          cancelled = true;
        },
      });
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(body, {
            headers: {
              "content-type": "image/png",
              "content-length": declared ? String(512 * 1024 + 1) : "1",
            },
          }),
      );
      assert.equal(await fetchLogoBytes(LOGO_URL), null);
      assert.ok(cancelled);
    }
  });

  test("accepts the exact byte limit, accumulated across chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const chunk = new Uint8Array(256 * 1024);
        chunk.set(new Uint8Array(PNG));
        controller.enqueue(chunk);
        controller.enqueue(new Uint8Array(256 * 1024));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(body, { headers: { "content-type": "image/png" } }),
    );
    assert.equal(
      (await fetchLogoBytes(LOGO_URL))?.bytes.byteLength,
      512 * 1024,
    );
  });

  test("empty and absent bodies cannot become a completed logo", async () => {
    for (const body of [null, new Uint8Array(0)]) {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(body, { headers: { "content-type": "image/png" } }),
      );
      assert.equal(await fetchLogoBytes(LOGO_URL), null);
    }
  });

  test("a timed out request aborts and a later request can succeed", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      if (++attempts > 1)
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      return new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    });
    const pending = fetchLogoBytes(LOGO_URL);
    const rejected = assert.rejects(pending, /aborted/);
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    assert.ok(await fetchLogoBytes(LOGO_URL));
    assert.equal(vi.getTimerCount(), 0);
  });

  test("a body stalled after successful headers is cancelled at the same deadline", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "image/png" } },
        ),
    );
    const pending = fetchLogoBytes(LOGO_URL);
    await vi.advanceTimersByTimeAsync(3000);
    assert.equal(await pending, null);
    assert.ok(cancelled);
    assert.equal(vi.getTimerCount(), 0);
  });

  test("body read failures propagate to the handler's retryable degradation", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start: (controller) =>
              controller.error(new Error("interrupted stream")),
          }),
          { headers: { "content-type": "image/png" } },
        ),
    );
    const response = (await cardRequest({ render: async () => PNG }))!;
    assert.equal(response.headers.get("cache-control"), SHORT);
  });

  for (const svg of [
    "not an svg",
    '<svg><image href="data:image/png;base64,AA=="/></svg>',
    "<svg><script/></svg>",
    "<svg><foreignObject/></svg>",
    '<!DOCTYPE svg><svg width="10" height="10"></svg>',
    '<!ENTITY test "x"><svg width="10" height="10"></svg>',
    '<?xml-stylesheet href="https://other.example/style.css"?><svg width="10" height="10"></svg>',
    '<svg><use href="https://other.example/logo.svg#mark"/></svg>',
    '<svg><style>@import "https://other.example/style.css";</style></svg>',
    '<svg><path fill="url(https://other.example/logo.svg)"/></svg>',
  ]) {
    test(`declines unsupported SVG resources: ${svg.slice(0, 45)}`, async () => {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(svg, { headers: { "content-type": "image/svg+xml" } }),
      );
      assert.equal(await fetchLogoBytes(LOGO_URL), null);
    });
  }

  test("local SVG gradients and fragment references remain usable", async () => {
    const svg =
      '<svg width="10" height="10"><defs><linearGradient id="g"/></defs><path fill="url(#g)"/><use href="#mark"/></svg>';
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(svg, {
          headers: { "content-type": " IMAGE/SVG+XML ; charset=utf-8" },
        }),
    );
    assert.equal(
      (await fetchLogoBytes(LOGO_URL))?.contentType,
      "image/svg+xml",
    );
  });
});
