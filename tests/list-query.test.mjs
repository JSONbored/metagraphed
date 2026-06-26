import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  applyQueryFilters,
  canonicalListSearch,
  paginationLinkHeader,
} from "../workers/list-query.mjs";

function query(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

// Parse an RFC 8288 Link header value into { rel: URL }, so a test can assert on
// the relation set and the cursor each page link points at.
function parseLink(value) {
  const links = {};
  for (const part of String(value || "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      links[match[2]] = new URL(match[1]);
    }
  }
  return links;
}

// Build a paginated page's Link header end-to-end: real pagination meta from
// applyQueryFilters fed straight into paginationLinkHeader, the same wiring the
// Worker uses.
function pageLink(path) {
  const url = query(path);
  const data = {
    subnets: Array.from({ length: 5 }, (_, i) => ({ netuid: i })),
  };
  const { meta } = applyQueryFilters(data, url, "subnets");
  return paginationLinkHeader(url, meta.pagination, {
    queryCollection: "subnets",
  });
}

describe("list-query field projection", () => {
  test("rejects malformed field lists", () => {
    const result = applyQueryFilters(
      { subnets: [{ netuid: 7, name: "Allways", slug: "allways" }] },
      query("/api/v1/subnets?fields=netuid,,name"),
      "subnets",
    );

    assert.equal(result.error.parameter, "fields");
    assert.match(result.error.message, /comma-separated/);
  });

  test("deduplicates projected fields and leaves malformed rows untouched", () => {
    const result = applyQueryFilters(
      {
        subnets: [
          null,
          ["malformed"],
          { netuid: 7, name: "Allways", slug: "allways" },
        ],
      },
      query("/api/v1/subnets?fields=netuid,netuid,slug"),
      "subnets",
    );

    assert.deepEqual(result.meta.projection.fields, ["netuid", "slug"]);
    assert.deepEqual(result.data.subnets, [
      null,
      ["malformed"],
      { netuid: 7, slug: "allways" },
    ]);
  });

  test("accepts a field that only appears on a later, heterogeneous row (union semantics)", () => {
    // `description` is absent from row 0 but present on row 1 — the lazy
    // known-field scan must still consider it valid (a field is known if it
    // appears on ANY row), not just the first.
    const result = applyQueryFilters(
      {
        subnets: [
          { netuid: 7, name: "Allways" },
          { netuid: 8, name: "Beta", description: "second-row-only" },
        ],
      },
      query("/api/v1/subnets?fields=netuid,description"),
      "subnets",
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(result.meta.projection.fields, ["netuid", "description"]);
    assert.deepEqual(result.data.subnets, [
      { netuid: 7 },
      { netuid: 8, description: "second-row-only" },
    ]);
  });

  test("reports every unsupported field, in requested order", () => {
    const result = applyQueryFilters(
      { subnets: [{ netuid: 7, name: "Allways" }] },
      query("/api/v1/subnets?fields=zeta,netuid,alpha"),
      "subnets",
    );

    assert.equal(result.error.parameter, "fields");
    assert.match(
      result.error.message,
      /unsupported fields for subnets: zeta, alpha\./,
    );
  });
});

describe("list-query pagination order", () => {
  const data = {
    subnets: [{ netuid: 3 }, { netuid: 1 }, { netuid: 2 }],
  };

  test("order=desc without a sort key reports asc (rows are unsorted)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?order=desc"),
      "subnets",
    );
    // sortRows did not run (no sort key) → rows stay in source order …
    assert.deepEqual(
      result.data.subnets.map((r) => r.netuid),
      [3, 1, 2],
    );
    // … so meta must not claim a descending order that wasn't applied.
    assert.equal(result.meta.pagination.sort, null);
    assert.equal(result.meta.pagination.order, "asc");
  });

  test("order=desc with a sort key reports desc and sorts", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=netuid&order=desc"),
      "subnets",
    );
    assert.deepEqual(
      result.data.subnets.map((r) => r.netuid),
      [3, 2, 1],
    );
    assert.equal(result.meta.pagination.sort, "netuid");
    assert.equal(result.meta.pagination.order, "desc");
  });
});

describe("list-query sort with missing values", () => {
  const data = {
    subnets: [
      { netuid: 1, tempo: 100 },
      { netuid: 2 }, // tempo absent
      { netuid: 3, tempo: 50 },
      { netuid: 4, tempo: null }, // tempo explicitly null
      { netuid: 5, tempo: 360 },
    ],
  };
  const order = (result) => result.data.subnets.map((r) => r.netuid);

  test("ascending sort keeps rows missing the field at the end, not the front", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=tempo"),
      "subnets",
    );
    // present ascending (50, 100, 360) then the absent/null rows last.
    assert.deepEqual(order(result), [3, 1, 5, 2, 4]);
  });

  test("descending sort still keeps missing rows last (not flipped to the front)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=tempo&order=desc"),
      "subnets",
    );
    // present descending (360, 100, 50) then the absent/null rows last.
    assert.deepEqual(order(result), [5, 1, 3, 2, 4]);
  });

  test("toggling order does not move incomplete rows out of the tail", () => {
    const asc = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=tempo&order=asc"),
      "subnets",
    );
    const desc = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=tempo&order=desc"),
      "subnets",
    );
    assert.deepEqual(order(asc).slice(-2).sort(), [2, 4]);
    assert.deepEqual(order(desc).slice(-2).sort(), [2, 4]);
  });
});

describe("list-query numeric range filters", () => {
  const data = {
    subnets: [
      { netuid: 1, surface_count: 2, tempo: 100 },
      { netuid: 2, surface_count: 9, tempo: 360 },
      { netuid: 3, surface_count: 5, tempo: 360 },
      { netuid: 4 }, // surface_count absent
      { netuid: 5, surface_count: "x" }, // non-numeric
    ],
  };
  const netuids = (result) => result.data.subnets.map((r) => r.netuid);

  test("min_<field> keeps rows >= the bound (inclusive)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_surface_count=5"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [2, 3]);
  });

  test("max_<field> keeps rows <= the bound (inclusive)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?max_surface_count=5"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [1, 3]);
  });

  test("min + max combine into an inclusive range, across fields", () => {
    const result = applyQueryFilters(
      data,
      query(
        "/api/v1/subnets?min_surface_count=3&max_surface_count=9&min_tempo=360",
      ),
      "subnets",
    );
    // surface_count in [3,9] → {2,3}; AND tempo >= 360 → both qualify.
    assert.deepEqual(netuids(result), [2, 3]);
  });

  test("a row whose field is absent or non-numeric is excluded once a bound is set", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_surface_count=0"),
      "subnets",
    );
    // netuid 4 (absent) and 5 (non-numeric) drop out even at min 0.
    assert.deepEqual(netuids(result), [1, 2, 3]);
  });

  test("no range param is a no-op (every row passes)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=netuid"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [1, 2, 3, 4, 5]);
  });

  test("accepts a negative / decimal bound", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_surface_count=-1&max_surface_count=4.5"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [1]); // surface_count 2 only
  });

  test("a non-numeric min_/max_ value is a query error", () => {
    const bad = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_surface_count=lots"),
      "subnets",
    );
    assert.equal(bad.error.parameter, "min_surface_count");
    assert.match(bad.error.message, /must be a number/);

    const badMax = applyQueryFilters(
      data,
      query("/api/v1/subnets?max_tempo="),
      "subnets",
    );
    assert.equal(badMax.error.parameter, "max_tempo");
  });

  test("an overflowing decimal range bound is a query error", () => {
    const hugeDecimal = "9".repeat(400);
    const bad = applyQueryFilters(
      data,
      query(`/api/v1/subnets?max_surface_count=${hugeDecimal}`),
      "subnets",
    );

    assert.equal(bad.error.parameter, "max_surface_count");
    assert.match(bad.error.message, /must be a number/);
  });

  test("contradictory min_ > max_ on the same field is a query error", () => {
    const bad = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_surface_count=9&max_surface_count=2"),
      "subnets",
    );
    assert.equal(bad.error.parameter, "min_surface_count");
    assert.match(
      bad.error.message,
      /must not be greater than max_surface_count/,
    );
  });

  test("equal min_ and max_ bounds form a single-value inclusive range", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_surface_count=5&max_surface_count=5"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [3]);
  });
});

describe("list-query pagination Link header", () => {
  test("first page: next + last only (no earlier page exists)", () => {
    const links = parseLink(pageLink("/api/v1/subnets?sort=netuid&limit=2"));
    assert.deepEqual(Object.keys(links).sort(), ["last", "next"]);
    assert.equal(links.next.searchParams.get("cursor"), "2");
    assert.equal(links.last.searchParams.get("cursor"), "4"); // floor((5-1)/2)*2
  });

  test("middle page: every relation, with stride-aligned offsets", () => {
    const links = parseLink(
      pageLink("/api/v1/subnets?sort=netuid&limit=2&cursor=2"),
    );
    assert.deepEqual(Object.keys(links).sort(), [
      "first",
      "last",
      "next",
      "prev",
    ]);
    assert.equal(links.first.searchParams.get("cursor"), "0");
    assert.equal(links.prev.searchParams.get("cursor"), "0");
    assert.equal(links.next.searchParams.get("cursor"), "4");
    assert.equal(links.last.searchParams.get("cursor"), "4");
  });

  test("last page: first + prev only (no later page exists)", () => {
    const links = parseLink(
      pageLink("/api/v1/subnets?sort=netuid&limit=2&cursor=4"),
    );
    assert.deepEqual(Object.keys(links).sort(), ["first", "prev"]);
    assert.equal(links.first.searchParams.get("cursor"), "0");
    assert.equal(links.prev.searchParams.get("cursor"), "2");
  });

  test("last points at the final page when total is a multiple of limit", () => {
    // limit=1 makes total (5) an exact multiple of limit — the only case where
    // the `(total - 1)` correction matters. last must be 4 (the final row), not
    // a naive floor(total/limit)*limit = 5, which is an empty page past the end.
    const links = parseLink(pageLink("/api/v1/subnets?sort=netuid&limit=1"));
    assert.equal(links.next.searchParams.get("cursor"), "1");
    assert.equal(links.last.searchParams.get("cursor"), "4");
  });

  test("prev clamps to 0 when the cursor is less than one full page in", () => {
    // cursor=1, limit=3 → prev = max(0, 1 - 3); without the clamp the link
    // would carry a negative cursor. first and prev both land on page 0.
    const links = parseLink(
      pageLink("/api/v1/subnets?sort=netuid&limit=3&cursor=1"),
    );
    assert.equal(links.prev.searchParams.get("cursor"), "0");
    assert.equal(links.first.searchParams.get("cursor"), "0");
  });

  test("links pin the resolved limit even when the client omits it", () => {
    // ?cursor=2 with no limit → the default window (100) is resolved and pinned
    // onto every page link, so a client can keep walking with a stable window.
    const links = parseLink(pageLink("/api/v1/subnets?sort=netuid&cursor=2"));
    assert.equal(links.prev.searchParams.get("limit"), "100");
    assert.equal(links.first.searchParams.get("limit"), "100");
  });

  test("empty result emits no Link header", () => {
    // netuid=999 matches no row → total 0 → no walkable page.
    assert.equal(pageLink("/api/v1/subnets?netuid=999&limit=2"), null);
  });

  test("an unpaged request (no limit/cursor) emits no Link header", () => {
    assert.equal(pageLink("/api/v1/subnets?sort=netuid"), null);
  });

  test("each page link is absolute and carries the active query through", () => {
    const links = parseLink(
      pageLink("/api/v1/subnets?sort=netuid&order=desc&limit=2&cursor=2"),
    );
    for (const rel of ["first", "prev", "next", "last"]) {
      const target = links[rel];
      assert.equal(target.origin, "https://api.metagraph.sh");
      assert.equal(target.pathname, "/api/v1/subnets");
      assert.equal(target.searchParams.get("sort"), "netuid");
      assert.equal(target.searchParams.get("order"), "desc");
      assert.equal(target.searchParams.get("limit"), "2"); // resolved window pinned
    }
  });

  test("drops ignored query parameters from cacheable page links", () => {
    const links = parseLink(
      pageLink(
        "/api/v1/subnets?sort=netuid&limit=2&utm_campaign=evil&token=SECRET123",
      ),
    );

    assert.equal(links.next.searchParams.get("sort"), "netuid");
    assert.equal(links.next.searchParams.get("limit"), "2");
    assert.equal(links.next.searchParams.has("utm_campaign"), false);
    assert.equal(links.next.searchParams.has("token"), false);
  });

  test("a non-list (no pagination meta) collection yields no header", () => {
    assert.equal(
      paginationLinkHeader(query("/api/v1/subnets"), undefined),
      null,
    );
    assert.equal(paginationLinkHeader(query("/api/v1/subnets"), {}), null);
  });
});

describe("list-query free-text search", () => {
  const data = {
    subnets: [
      {
        netuid: 1,
        name: "Gradients Training",
        slug: "gradients",
      },
      {
        netuid: 2,
        name: "Chutes",
        slug: "chutes",
      },
      {
        netuid: 3,
        name: "Training Hub",
        slug: "gradients-hub",
      },
    ],
  };
  const netuids = (result) => result.data.subnets.map((r) => r.netuid);

  test("matches every whitespace-separated term independently across searchable fields", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?q=gradients%20training"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [1, 3]);
  });

  test("term order does not matter", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?q=training%20gradients"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [1, 3]);
  });

  test("a single term keeps substring semantics", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?q=chutes"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [2]);
  });

  test("whitespace-only q is treated as no search", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?q=%20%20"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [1, 2, 3]);
  });

  test("an absent q is a no-op", () => {
    const result = applyQueryFilters(data, query("/api/v1/subnets"), "subnets");
    assert.deepEqual(netuids(result), [1, 2, 3]);
  });
});

// canonicalListSearch is the cache-key safety primitive behind the pagination
// Link header (#1932): it rebuilds the query string from ONLY the body-affecting
// params the edge cache keys on, so attacker- or tracker-supplied extras can
// never ride along in a cached Link header.
describe("list-query canonicalListSearch (cache-key safety)", () => {
  function params(search) {
    return new URL(`https://edge.test/${search}`).searchParams;
  }

  test("keeps every body-affecting param family and drops the rest", () => {
    const url = query(
      "/api/v1/subnets?q=chutes&fields=netuid&sort=netuid&order=desc" +
        "&limit=5&cursor=10&curation_level=native" + // a plain filter
        "&netuids=1,2" + // a csv filter
        "&domain=ai" + // an array filter
        "&min_block=100&max_block=200" + // a range filter pair
        "&utm_campaign=evil&token=SECRET123&__proto__=x", // ignored extras
    );
    const p = params(canonicalListSearch(url, "subnets"));
    // Preserved: the static page controls + each filter family.
    assert.equal(p.get("q"), "chutes");
    assert.equal(p.get("fields"), "netuid");
    assert.equal(p.get("sort"), "netuid");
    assert.equal(p.get("order"), "desc");
    assert.equal(p.get("limit"), "5");
    assert.equal(p.get("cursor"), "10");
    assert.equal(p.get("curation_level"), "native");
    assert.equal(p.get("netuids"), "1,2");
    assert.equal(p.get("domain"), "ai");
    assert.equal(p.get("min_block"), "100");
    assert.equal(p.get("max_block"), "200");
    // Dropped: anything the edge cache key ignores.
    assert.equal(p.has("utm_campaign"), false);
    assert.equal(p.has("token"), false);
    assert.equal(p.has("__proto__"), false);
  });

  test("an unknown collection canonicalizes to an empty search", () => {
    assert.equal(canonicalListSearch(query("/api/v1/x?a=1"), "nope"), "");
  });

  test("an explicit queryFilterNames allowlist overrides the collection filters", () => {
    const url = query("/api/v1/subnets?netuid=3&curation_level=native&q=z");
    const p = params(canonicalListSearch(url, "subnets", ["netuid"]));
    // Only the allowlisted filter (plus the static controls) survives.
    assert.equal(p.get("netuid"), "3");
    assert.equal(p.get("q"), "z");
    assert.equal(p.has("curation_level"), false);
  });

  test("a present-but-empty param value is preserved (distinct from absent)", () => {
    const p = params(
      canonicalListSearch(query("/api/v1/subnets?q="), "subnets"),
    );
    assert.equal(p.get("q"), "");
  });
});

describe("list-query paginationLinkHeader canonicalization", () => {
  function pagedUrl(path) {
    return query(path);
  }
  const meta = { cursor: 0, limit: 2, next_cursor: 2, total: 5 };

  test("without a queryCollection, the raw search (incl. extras) is preserved", () => {
    // The legacy/non-canonical path: callers that pass no collection get the
    // request search verbatim — this guards that the canonical branch is opt-in.
    const header = paginationLinkHeader(
      pagedUrl("/api/v1/subnets?sort=netuid&utm=evil"),
      meta,
    );
    const next = new URL(header.match(/<([^>]+)>;\s*rel="next"/)[1]);
    assert.equal(next.searchParams.get("utm"), "evil");
    assert.equal(next.searchParams.get("sort"), "netuid");
  });

  test("with a queryCollection, ignored params are stripped from page links", () => {
    const header = paginationLinkHeader(
      pagedUrl("/api/v1/subnets?sort=netuid&utm=evil"),
      meta,
      { queryCollection: "subnets" },
    );
    const next = new URL(header.match(/<([^>]+)>;\s*rel="next"/)[1]);
    assert.equal(next.searchParams.has("utm"), false);
    assert.equal(next.searchParams.get("sort"), "netuid");
  });
});
