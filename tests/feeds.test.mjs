import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  handleFeedRequest,
  parseFeedPath,
  resolveFeedFormat,
  feedLinkHeader,
  __test,
} from "../src/feeds.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

let originalCaches;
beforeEach(() => {
  originalCaches = globalThis.caches;
});

afterEach(() => {
  if (originalCaches === undefined) {
    delete globalThis.caches;
  } else {
    globalThis.caches = originalCaches;
  }
});

function installMockCache() {
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(request) {
        const cached = store.get(request.url);
        return cached ? cached.clone() : undefined;
      },
      async put(request, response) {
        store.set(request.url, response.clone());
      },
    },
  };
}

const {
  registryItems,
  incidentItems,
  jsonFeed,
  rssFeed,
  atomFeed,
  escapeXml,
  filterByTag,
  filterSince,
  parseSinceParam,
} = __test;

const CHANGELOG = {
  generated_at: "2026-06-15T00:00:00.000Z",
  subnets: {
    added: [{ netuid: 7, name: "Allways" }],
    removed: [],
    renamed: [
      { netuid: 12 }, // no name → title fallback
      { name: "no-netuid" }, // skipped (no numeric netuid)
    ],
  },
  artifacts: {
    added: [],
    modified: [{ path: "subnets.json" }, {}], // 2nd skipped (no path)
    removed: [{ path: "/metagraph/coverage.json" }],
  },
  summary: {
    coverage_delta: {
      surface_count: { before: 100, after: 103, delta: 3 },
      candidate_count: { before: 50, after: 49, delta: -1 },
    },
  },
};

const INCIDENTS = {
  observed_at: "2026-06-15T00:00:00.000Z",
  surfaces: [
    {
      netuid: 7,
      surface_id: "allways-api",
      incidents: [
        {
          started_at: 1781266255266,
          ended_at: 1781499480737,
          duration_ms: 233225471,
          failed_samples: 1945,
        },
      ],
    },
    {
      netuid: 12,
      surface_id: "compute-rpc",
      incidents: [{ started_at: 1781499480000 }], // ongoing, no failed_samples
    },
    { netuid: 3, surface_id: "no-incidents" }, // no incidents[]
  ],
};

function makeReadArtifact(fixtures) {
  return (_env, path) =>
    Promise.resolve(
      Object.prototype.hasOwnProperty.call(fixtures, path)
        ? { ok: true, data: fixtures[path] }
        : { ok: false, code: "artifact_not_found" },
    );
}

async function feed(
  pathname,
  { accept, deps, method = "GET", ifNoneMatch } = {},
) {
  const url = new URL(`https://api.metagraph.sh${pathname}`);
  const headers = {};
  if (accept) headers.accept = accept;
  if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;
  const request = new Request(url, { method, headers });
  const defaultReadArtifact = makeReadArtifact({
    "/metagraph/changelog.json": CHANGELOG,
    "/metagraph/incidents.json": INCIDENTS,
    "/metagraph/health/incidents/7.json": INCIDENTS,
  });
  let handlerDeps;
  if (typeof deps === "function") {
    handlerDeps = {
      readArtifact: deps,
      loadLiveIncidents: async (env) => {
        const result = await deps(env, "/metagraph/incidents.json");
        return result?.ok ? result.data : null;
      },
    };
  } else {
    handlerDeps = {
      readArtifact: deps?.readArtifact ?? defaultReadArtifact,
      loadLiveIncidents: deps?.loadLiveIncidents ?? (async () => INCIDENTS),
    };
  }
  const res = await handleFeedRequest(request, {}, url, handlerDeps);
  return { res, text: await res.text() };
}

describe("feeds — path + format parsing", () => {
  test("parseFeedPath resolves the three feed kinds + rejects unknown", () => {
    assert.deepEqual(parseFeedPath("/api/v1/feeds/registry"), {
      kind: "registry",
    });
    assert.deepEqual(parseFeedPath("/api/v1/feeds/incidents.rss"), {
      kind: "incidents",
    });
    assert.deepEqual(parseFeedPath("/api/v1/feeds/subnets/7.atom"), {
      kind: "subnet",
      netuid: 7,
    });
    assert.equal(parseFeedPath("/api/v1/feeds/bogus"), null);
    assert.equal(parseFeedPath("/api/v1/feeds/subnets/abc"), null);
  });

  test("resolveFeedFormat: suffix > Accept > json default", () => {
    assert.equal(resolveFeedFormat("/x.rss", "application/json"), "rss");
    assert.equal(resolveFeedFormat("/x.atom", ""), "atom");
    assert.equal(resolveFeedFormat("/x.json", ""), "json");
    assert.equal(resolveFeedFormat("/x", "application/rss+xml"), "rss");
    assert.equal(resolveFeedFormat("/x", "application/atom+xml"), "atom");
    assert.equal(resolveFeedFormat("/x", "text/html"), "json");
  });

  test("feedLinkHeader advertises all three formats, global + per-subnet", () => {
    const global = feedLinkHeader("https://api.metagraph.sh");
    assert.match(global, /feeds\/registry\.json>.*application\/feed\+json/);
    assert.match(global, /feeds\/registry\.rss>.*application\/rss\+xml/);
    assert.match(global, /feeds\/registry\.atom>.*application\/atom\+xml/);
    const subnet = feedLinkHeader("https://api.metagraph.sh", 7);
    assert.match(subnet, /feeds\/subnets\/7\.rss>/);
  });
});

describe("feeds — item builders", () => {
  test("registryItems builds subnet, artifact, and coverage items", () => {
    const items = registryItems(CHANGELOG);
    const titles = items.map((i) => i.title);
    assert.ok(titles.some((t) => t === "Subnet 7 added — Allways"));
    assert.ok(titles.some((t) => t === "Subnet 12 renamed")); // no-name fallback
    assert.ok(!titles.some((t) => t.includes("no-netuid"))); // skipped
    assert.ok(titles.some((t) => t === "Updated subnets.json"));
    assert.ok(titles.some((t) => t === "Removed /metagraph/coverage.json"));
    assert.ok(
      titles.some((t) => t.startsWith("Coverage updated: +3 surfaces, -1")),
    );
    for (const it of items) {
      assert.ok(it.id && it.url && it.title && it.timestamp);
      assert.ok(Array.isArray(it.tags));
    }
  });

  test("registryItems filtered by netuid omits artifacts + coverage", () => {
    const items = registryItems(CHANGELOG, 7);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Subnet 7 added — Allways");
  });

  test("registryItems tolerates empty/missing changelog", () => {
    assert.deepEqual(registryItems(null), []);
    assert.deepEqual(registryItems({}), []);
  });

  test("registryItems clamp does not split a surrogate pair in a title", () => {
    // Emoji placed so its surrogate pair straddles the 80-char title clamp.
    const path = "a".repeat(78) + "😀" + "z".repeat(20);
    const items = registryItems({ artifacts: { modified: [{ path }] } });
    assert.equal(items.length, 1);
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    assert.ok(
      !loneSurrogate.test(items[0].title),
      "feed title must not contain a lone surrogate",
    );
    assert.ok(!loneSurrogate.test(items[0].summary));
  });

  test("registryItems clamp keeps a title that fits in code points but not code units", () => {
    // 60 ASCII + 3 emoji = 63 code points (well under the 80 cap) but 66 UTF-16
    // code units. The guard must measure code points, or this gets truncated.
    const path = "a".repeat(60) + "😀😀😀";
    assert.equal([...path].length <= 80, true);
    assert.equal(path.length > 80, false); // sanity: still <= 80 code units here
    const longer = "a".repeat(75) + "😀😀😀"; // 78 code points, 81 code units
    assert.equal([...longer].length <= 80, true);
    assert.equal(longer.length > 80, true); // > 80 code units → old guard truncates
    const items = registryItems({
      artifacts: { modified: [{ path: longer }] },
    });
    assert.equal(items.length, 1);
    // The full path survives in the title (not truncated to an ellipsis).
    assert.ok(
      items[0].title.includes(longer),
      "a title within the code-point cap must not be truncated",
    );
  });

  test("registryItems coverage delta describes only the present side", () => {
    // Partial coverage_delta (candidate_count only) must not emit "+0 surfaces"
    // or "Surfaces undefined→undefined" for the absent surface side.
    const items = registryItems({
      summary: {
        coverage_delta: {
          candidate_count: { before: 50, after: 49, delta: -1 },
        },
      },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Coverage updated: -1 candidates");
    assert.equal(items[0].summary, "candidates 50→49.");
    assert.ok(!items[0].summary.includes("undefined"));
    assert.ok(!items[0].title.includes("surfaces"));
  });

  test("incidentItems marks ongoing vs resolved + filters by netuid", () => {
    const all = incidentItems(INCIDENTS);
    assert.equal(all.length, 2); // the no-incidents surface contributes none
    const resolved = all.find((i) => i.tags.includes("resolved"));
    const ongoing = all.find((i) => i.tags.includes("ongoing"));
    assert.match(resolved.title, /^Resolved incident/);
    assert.match(resolved.summary, /was down for ~\d+m, 1945 failed probes/);
    assert.match(ongoing.title, /^Ongoing incident/);
    assert.match(ongoing.summary, /is currently down\.$/);
    const onlySn7 = incidentItems(INCIDENTS, 7);
    assert.equal(onlySn7.length, 1);
    assert.equal(incidentItems(null).length, 0);
  });
});

describe("feeds — filterByTag", () => {
  const items = [
    { id: "a", tags: ["registry", "subnet", "added"] },
    { id: "b", tags: ["registry", "coverage"] },
    { id: "c", tags: ["incident", "sn7", "ongoing"] },
  ];

  test("a null/empty tag is a no-op (returns the input)", () => {
    assert.equal(filterByTag(items, null), items);
    assert.equal(filterByTag(items, ""), items);
    assert.equal(filterByTag(items, undefined), items);
  });

  test("keeps only items carrying the tag", () => {
    assert.deepEqual(
      filterByTag(items, "incident").map((i) => i.id),
      ["c"],
    );
    assert.deepEqual(
      filterByTag(items, "registry").map((i) => i.id),
      ["a", "b"],
    );
  });

  test("an unknown tag yields an empty list", () => {
    assert.deepEqual(filterByTag(items, "nope"), []);
  });

  test("an item with no tags array is safely skipped", () => {
    assert.deepEqual(filterByTag([{ id: "x" }], "incident"), []);
  });
});

describe("feeds — parseSinceParam", () => {
  test("accepts strict ISO dates and date-times", () => {
    assert.equal(
      new Date(parseSinceParam("2026-06-01")).toISOString(),
      "2026-06-01T00:00:00.000Z",
    );
    assert.equal(
      new Date(parseSinceParam("2026-06-01T01:02:03Z")).toISOString(),
      "2026-06-01T01:02:03.000Z",
    );
    assert.equal(
      new Date(parseSinceParam("2026-06-01T01:02:03.123+02:30")).toISOString(),
      "2026-05-31T22:32:03.123Z",
    );
    assert.equal(
      new Date(parseSinceParam("2026-06-01T01:02:03-02:30")).toISOString(),
      "2026-06-01T03:32:03.000Z",
    );
  });

  test("rejects Date.parse-permissive malformed or non-ISO values", () => {
    for (const value of [
      "1",
      "2026-02-31",
      "2026-06-01T24:00:00Z",
      "2026-06-01T00:60:00Z",
      "2026-06-01T00:00:60Z",
      "2026-06-01T00:00:00+24:00",
      "2026-06-01T00:00:00+02:60",
      "Tue, 01 Jun 2026 00:00:00 GMT",
      "2026-06-01T00:00:00",
    ]) {
      assert.ok(Number.isNaN(parseSinceParam(value)), value);
    }
  });
});

describe("feeds — filterSince", () => {
  const items = [
    { id: "old", timestamp: "2026-06-10T00:00:00.000Z" },
    { id: "new", timestamp: "2026-06-20T00:00:00.000Z" },
    { id: "bad", timestamp: "not-a-date" },
  ];

  test("a null bound is a no-op (returns the input)", () => {
    assert.equal(filterSince(items, null), items);
  });

  test("keeps items at or after the bound; drops unparseable timestamps", () => {
    const kept = filterSince(items, Date.parse("2026-06-15T00:00:00.000Z"));
    assert.deepEqual(
      kept.map((i) => i.id),
      ["new"],
    );
  });

  test("is inclusive of the exact bound", () => {
    const kept = filterSince(items, Date.parse("2026-06-20T00:00:00.000Z"));
    assert.deepEqual(
      kept.map((i) => i.id),
      ["new"],
    );
  });
});

describe("feeds — ?since= filter", () => {
  test("a future since yields an empty but valid feed (200)", async () => {
    const { res, text } = await feed(
      "/api/v1/feeds/registry.json?since=2030-01-01",
    );
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(text).items, []);
  });

  test("a past since keeps items and composes with ?tag=", async () => {
    const { res, text } = await feed(
      "/api/v1/feeds/registry.json?since=2000-01-01&tag=registry",
    );
    assert.equal(res.status, 200);
    const items = JSON.parse(text).items;
    assert.ok(items.length > 0);
    assert.ok(items.every((it) => (it.tags || []).includes("registry")));
  });

  test("a malformed since is rejected with 400", async () => {
    for (const value of [
      "notadate",
      "1",
      "2026-02-31",
      "Tue, 01 Jun 2026 00:00:00 GMT",
    ]) {
      const { res } = await feed(
        `/api/v1/feeds/registry.json?since=${encodeURIComponent(value)}`,
      );
      assert.equal(res.status, 400, value);
    }
  });
});

describe("feeds — serializers", () => {
  const meta = {
    title: "t",
    description: "d",
    homeUrl: "https://metagraph.sh",
    feedUrl: "https://api.metagraph.sh/api/v1/feeds/registry",
    updated: "2026-06-15T00:00:00.000Z",
  };
  const items = registryItems(CHANGELOG);

  test("jsonFeed is valid JSON Feed 1.1", () => {
    const parsed = JSON.parse(jsonFeed(meta, items));
    assert.equal(parsed.version, "https://jsonfeed.org/version/1.1");
    assert.equal(parsed.title, "t");
    assert.ok(Array.isArray(parsed.items) && parsed.items.length > 0);
    for (const it of parsed.items) {
      assert.ok(it.id && it.title && it.date_published);
    }
  });

  test("rssFeed has the required channel + item structure", () => {
    const xml = rssFeed(meta, items);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<rss version="2\.0"/);
    assert.match(xml, /<channel>[\s\S]*<\/channel>/);
    assert.ok((xml.match(/<item>/g) || []).length === items.length);
    assert.match(xml, /<pubDate>.*GMT<\/pubDate>/);
  });

  test("atomFeed has the required feed + entry structure", () => {
    const xml = atomFeed(meta, items);
    assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
    assert.match(xml, /<id>https:\/\/api\.metagraph\.sh/);
    assert.ok((xml.match(/<entry>/g) || []).length === items.length);
  });

  test("escapeXml neutralizes markup + strips control chars", () => {
    assert.equal(
      escapeXml(`<a href="x">&'</a>`),
      "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;",
    );
    assert.equal(escapeXml("a\u0000b\u0007c"), "abc"); // control stripped
    assert.equal(escapeXml("keep\ttab\nnewline"), "keep\ttab\nnewline");
    // a script payload in a feed title can't break out of the element
    const xml = rssFeed(meta, [
      {
        id: "x",
        url: "https://x",
        title: "<script>alert(1)</script>",
        summary: "s",
        timestamp: "2026-06-15T00:00:00.000Z",
        tags: [],
      },
    ]);
    assert.ok(!xml.includes("<script>"));
    assert.match(xml, /&lt;script&gt;/);
  });
});

describe("feeds — handleFeedRequest", () => {
  test("registry feed defaults to JSON Feed", async () => {
    const { res, text } = await feed("/api/v1/feeds/registry");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/feed\+json/);
    assert.match(res.headers.get("cache-control"), /max-age=600/);
    const parsed = JSON.parse(text);
    assert.equal(parsed.version, "https://jsonfeed.org/version/1.1");
    assert.equal(
      parsed.feed_url,
      "https://api.metagraph.sh/api/v1/feeds/registry",
    );
  });

  test("explicit .rss + .atom suffixes win over Accept", async () => {
    const rss = await feed("/api/v1/feeds/registry.rss", {
      accept: "application/feed+json",
    });
    assert.match(rss.res.headers.get("content-type"), /application\/rss\+xml/);
    assert.match(rss.text, /<rss version="2\.0"/);
    const atom = await feed("/api/v1/feeds/incidents.atom");
    assert.match(
      atom.res.headers.get("content-type"),
      /application\/atom\+xml/,
    );
    assert.match(atom.text, /<feed xmlns/);
  });

  test("Accept header negotiates rss/atom without a suffix", async () => {
    const { res } = await feed("/api/v1/feeds/registry", {
      accept: "text/html, application/rss+xml",
    });
    assert.match(res.headers.get("content-type"), /application\/rss\+xml/);
    assert.equal(res.headers.get("vary"), "Accept");
  });

  test("per-subnet feed merges registry + incident items for that netuid", async () => {
    const { res, text } = await feed("/api/v1/feeds/subnets/7");
    assert.equal(res.status, 200);
    const parsed = JSON.parse(text);
    assert.ok(parsed.items.some((i) => i.id.startsWith("registry:subnet:7")));
    assert.ok(parsed.items.some((i) => i.id.startsWith("incident:")));
    assert.equal(parsed.home_page_url, "https://metagraph.sh/subnets/7");
  });

  test("unknown feed → 404, missing readArtifact → 404", async () => {
    const { res } = await feed("/api/v1/feeds/nope");
    assert.equal(res.status, 404);
    const url = new URL("https://api.metagraph.sh/api/v1/feeds/registry");
    const bad = await handleFeedRequest(new Request(url), {}, url, {});
    assert.equal(bad.status, 404);
  });

  test("HEAD returns headers with no body", async () => {
    const { res, text } = await feed("/api/v1/feeds/registry", {
      method: "HEAD",
    });
    assert.equal(res.status, 200);
    assert.equal(text, "");
  });

  test("a feed with no underlying data still serializes validly (empty)", async () => {
    const { res, text } = await feed("/api/v1/feeds/incidents", {
      deps: {
        readArtifact: makeReadArtifact({}),
        loadLiveIncidents: async () => null,
      },
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(text);
    assert.equal(parsed.items.length, 0);
    assert.ok(parsed.title && parsed.feed_url);
  });

  test("incidents feed reads the live D1 ledger, not a static artifact", async () => {
    let liveCalled = false;
    const { res, text } = await feed("/api/v1/feeds/incidents", {
      deps: {
        readArtifact: makeReadArtifact({
          "/metagraph/changelog.json": CHANGELOG,
        }),
        loadLiveIncidents: async () => {
          liveCalled = true;
          return INCIDENTS;
        },
      },
    });
    assert.ok(liveCalled);
    assert.equal(res.status, 200);
    const parsed = JSON.parse(text);
    assert.equal(parsed.items.length, 2);
  });

  test("incidents feed returns empty when loadLiveIncidents throws", async () => {
    const { res, text } = await feed("/api/v1/feeds/incidents", {
      deps: {
        readArtifact: makeReadArtifact({}),
        loadLiveIncidents: async () => {
          throw new Error("D1 unavailable");
        },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(text).items.length, 0);
  });

  test("incidents feed falls back to static artifact when loadLiveIncidents is absent", async () => {
    const url = new URL("https://api.metagraph.sh/api/v1/feeds/incidents");
    const res = await handleFeedRequest(new Request(url), {}, url, {
      readArtifact: makeReadArtifact({
        "/metagraph/incidents.json": INCIDENTS,
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(await res.text()).items.length, 2);
  });

  test("?tag= narrows the registry feed to matching items", async () => {
    const { res, text } = await feed("/api/v1/feeds/registry?tag=coverage");
    assert.equal(res.status, 200);
    const parsed = JSON.parse(text);
    assert.ok(parsed.items.length > 0);
    assert.ok(parsed.items.every((i) => i.id.startsWith("registry:coverage")));
  });

  test("?tag= on a per-subnet feed keeps only that tag across both sources", async () => {
    const { text } = await feed("/api/v1/feeds/subnets/7?tag=incident");
    const parsed = JSON.parse(text);
    assert.ok(parsed.items.length > 0);
    assert.ok(parsed.items.every((i) => i.id.startsWith("incident:")));
  });

  test("an unknown ?tag= yields a valid but empty feed", async () => {
    const { res, text } = await feed(
      "/api/v1/feeds/registry?tag=does-not-exist",
    );
    assert.equal(res.status, 200);
    const parsed = JSON.parse(text);
    assert.equal(parsed.items.length, 0);
    assert.ok(parsed.title && parsed.feed_url);
  });

  test("no ?tag= returns the full feed (filter is a no-op)", async () => {
    const all = await feed("/api/v1/feeds/registry");
    const tagged = await feed("/api/v1/feeds/registry?tag=registry");
    const allItems = JSON.parse(all.text).items.length;
    const taggedItems = JSON.parse(tagged.text).items.length;
    // Every registry item carries the "registry" tag, so the two match.
    assert.equal(taggedItems, allItems);
  });
});

describe("feeds — ETag + conditional requests", () => {
  // Every feed kind × format emits a weak ETag and honors a matching
  // If-None-Match with a bodyless 304 carrying the same validators.
  for (const kind of ["registry", "incidents", "subnets/7"]) {
    for (const ext of ["", ".rss", ".atom", ".json"]) {
      test(`${kind}${ext} emits an ETag and 304s on a matching If-None-Match`, async () => {
        const path = `/api/v1/feeds/${kind}${ext}`;
        const first = await feed(path);
        assert.equal(first.res.status, 200);
        const etag = first.res.headers.get("etag");
        assert.match(etag, /^W\/"[0-9a-f]+"$/, "a weak ETag is emitted");

        const second = await feed(path, { ifNoneMatch: etag });
        assert.equal(second.res.status, 304);
        assert.equal(second.text, "", "a 304 carries no body");
        assert.equal(
          second.res.headers.get("etag"),
          etag,
          "the 304 echoes the validator",
        );
        assert.match(
          second.res.headers.get("cache-control"),
          /max-age=600/,
          "the 304 carries the same cache-control",
        );
      });
    }
  }

  test("the ETag is stable across identical requests", async () => {
    const a = await feed("/api/v1/feeds/registry");
    const b = await feed("/api/v1/feeds/registry");
    assert.equal(a.res.headers.get("etag"), b.res.headers.get("etag"));
  });

  test("the ETag differs across formats and feed kinds", async () => {
    const rss = await feed("/api/v1/feeds/registry.rss");
    const atom = await feed("/api/v1/feeds/registry.atom");
    const incidents = await feed("/api/v1/feeds/incidents.rss");
    assert.notEqual(
      rss.res.headers.get("etag"),
      atom.res.headers.get("etag"),
      "rss and atom render differently → different ETag",
    );
    assert.notEqual(
      rss.res.headers.get("etag"),
      incidents.res.headers.get("etag"),
      "different feed kinds → different ETag",
    );
  });

  test("a stale If-None-Match still gets a full 200 body", async () => {
    const { res, text } = await feed("/api/v1/feeds/registry", {
      ifNoneMatch: 'W/"stale"',
    });
    assert.equal(res.status, 200);
    assert.ok(text.length > 0);
    assert.ok(res.headers.get("etag"));
  });

  test("a tag-filtered feed has its own ETag and 304s on a match", async () => {
    const path = "/api/v1/feeds/registry?tag=coverage";
    const unfiltered = await feed("/api/v1/feeds/registry");
    const filtered = await feed(path);
    assert.notEqual(
      filtered.res.headers.get("etag"),
      unfiltered.res.headers.get("etag"),
      "the tag filter changes the body → a distinct ETag",
    );
    const revalidate = await feed(path, {
      ifNoneMatch: filtered.res.headers.get("etag"),
    });
    assert.equal(revalidate.res.status, 304);
  });

  test("HEAD emits the ETag and honors a conditional 304", async () => {
    const head = await feed("/api/v1/feeds/registry", { method: "HEAD" });
    assert.equal(head.res.status, 200);
    const etag = head.res.headers.get("etag");
    assert.ok(etag);
    const revalidate = await feed("/api/v1/feeds/registry", {
      method: "HEAD",
      ifNoneMatch: etag,
    });
    assert.equal(revalidate.res.status, 304);
    assert.equal(revalidate.text, "");
  });

  test("If-None-Match: * always 304s a present feed", async () => {
    const { res } = await feed("/api/v1/feeds/registry", { ifNoneMatch: "*" });
    assert.equal(res.status, 304);
  });

  test("weak/strong validators compare equal (RFC 7232 weak comparison)", async () => {
    const { res } = await feed("/api/v1/feeds/registry");
    const weak = res.headers.get("etag"); // W/"…"
    const strong = weak.replace(/^W\//, ""); // "…"
    const revalidate = await feed("/api/v1/feeds/registry", {
      ifNoneMatch: strong,
    });
    assert.equal(revalidate.res.status, 304);
  });
});

describe("feeds — Worker dispatch integration", () => {
  test("handleRequest routes /api/v1/feeds/* to the feed handler", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/feeds/registry.rss"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/rss\+xml/);
    assert.match(await res.text(), /<rss version="2\.0"/);
  });

  test("handleRequest caches live incidents feed aggregations at the edge", async () => {
    installMockCache();
    let recentChecksQueries = 0;
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                all: () => {
                  if (sql.includes("recent_checks")) {
                    recentChecksQueries += 1;
                    return Promise.resolve({
                      results: [
                        {
                          netuid: 7,
                          surface_id: "allways-api",
                          surface_key: "allways-api",
                          started_at: 1781266255266,
                          ended_at: 1781499480737,
                          failed_samples: 1945,
                        },
                      ],
                    });
                  }
                  return Promise.resolve({ results: [] });
                },
              };
            },
          };
        },
      },
      METAGRAPH_CONTROL: {
        async get(key) {
          if (key === "health:meta") {
            return { last_run_at: "2026-06-15T00:00:00.000Z" };
          }
          return null;
        },
      },
    };
    const ctx = { waitUntil: (promise) => promise };
    const first = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/feeds/incidents.json"),
      env,
      ctx,
    );
    assert.equal(first.status, 200);
    assert.ok((await first.json()).items[0].id.startsWith("incident:"));
    const etag = first.headers.get("etag");
    assert.ok(etag);
    assert.equal(recentChecksQueries, 1);

    const cached = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/feeds/incidents.json?cachebust=1",
      ),
      env,
      ctx,
    );
    assert.equal(cached.status, 200);
    assert.equal(recentChecksQueries, 1);

    const head = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/feeds/incidents.json", {
        method: "HEAD",
      }),
      env,
      ctx,
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(recentChecksQueries, 1);

    const conditionalHead = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/feeds/incidents.json", {
        method: "HEAD",
        headers: { "if-none-match": etag },
      }),
      env,
      ctx,
    );
    assert.equal(conditionalHead.status, 304);
    assert.equal(await conditionalHead.text(), "");
    assert.equal(recentChecksQueries, 1);
  });

  test("handleRequest keys edge-cached feeds by since", async () => {
    installMockCache();
    let recentChecksQueries = 0;
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                all: () => {
                  if (sql.includes("recent_checks")) {
                    recentChecksQueries += 1;
                    return Promise.resolve({
                      results: [
                        {
                          netuid: 7,
                          surface_id: "allways-api",
                          surface_key: "allways-api",
                          started_at: 1781266255266,
                          ended_at: 1781499480737,
                          failed_samples: 1945,
                        },
                      ],
                    });
                  }
                  return Promise.resolve({ results: [] });
                },
              };
            },
          };
        },
      },
      METAGRAPH_CONTROL: {
        async get(key) {
          if (key === "health:meta") {
            return { last_run_at: "2026-06-15T00:00:00.000Z" };
          }
          return null;
        },
      },
    };
    const ctx = { waitUntil: (promise) => promise };

    const future = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/feeds/incidents.json?since=2099-01-01",
      ),
      env,
      ctx,
    );
    assert.equal(future.status, 200);
    assert.deepEqual((await future.json()).items, []);
    assert.equal(recentChecksQueries, 1);

    const unfiltered = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/feeds/incidents.json"),
      env,
      ctx,
    );
    assert.equal(unfiltered.status, 200);
    assert.ok((await unfiltered.json()).items.length > 0);
    assert.equal(recentChecksQueries, 2);

    const invalid = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/feeds/incidents.json?since=notadate",
      ),
      env,
      ctx,
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      invalid.headers.get("x-metagraph-error-code"),
      "invalid_since",
    );
  });

  test("an unknown feed path is a 404 with the canonical error envelope", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/feeds/nonexistent"),
      env,
      {},
    );
    assert.equal(res.status, 404);
    // The Worker injects the shared errorResponse, so feed errors carry the
    // same envelope + headers as every other API error (not a bare body).
    assert.equal(res.headers.get("x-metagraph-error-code"), "feed_not_found");
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.schema_version, 1);
    assert.equal(body.data, null);
    assert.equal(body.error.code, "feed_not_found");
    assert.ok(body.meta.contract_version);
  });
});
