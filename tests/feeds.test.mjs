import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  handleFeedRequest,
  parseFeedPath,
  resolveFeedFormat,
  feedLinkHeader,
  __test,
} from "../src/feeds.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const { registryItems, incidentItems, jsonFeed, rssFeed, atomFeed, escapeXml } =
  __test;

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

async function feed(pathname, { accept, deps, method = "GET" } = {}) {
  const url = new URL(`https://api.metagraph.sh${pathname}`);
  const request = new Request(url, {
    method,
    headers: accept ? { accept } : {},
  });
  const readArtifact =
    deps ||
    makeReadArtifact({
      "/metagraph/changelog.json": CHANGELOG,
      "/metagraph/incidents.json": INCIDENTS,
      "/metagraph/health/incidents/7.json": INCIDENTS,
    });
  const res = await handleFeedRequest(request, {}, url, { readArtifact });
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
    const empty = makeReadArtifact({});
    const { res, text } = await feed("/api/v1/feeds/incidents", {
      deps: empty,
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(text);
    assert.equal(parsed.items.length, 0);
    assert.ok(parsed.title && parsed.feed_url);
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

  test("an unknown feed path is a 404 (not a static-asset fall-through)", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/feeds/nonexistent"),
      env,
      {},
    );
    assert.equal(res.status, 404);
  });
});
