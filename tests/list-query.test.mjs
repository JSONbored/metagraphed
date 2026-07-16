import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { API_QUERY_COLLECTIONS } from "../src/contracts.mjs";
import {
  applyQueryFilters,
  canonicalListSearch,
  paginationLinkHeader,
  validateListQueryParams,
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
  test("rejects empty or whitespace-only field lists", () => {
    for (const path of [
      "/api/v1/subnets?fields=",
      "/api/v1/subnets?fields=%20%20",
      "/api/v1/subnets?fields=,,",
    ]) {
      const result = applyQueryFilters(
        { subnets: [{ netuid: 7, name: "Allways", slug: "allways" }] },
        query(path),
        "subnets",
      );

      assert.equal(result.error.parameter, "fields");
      assert.match(result.error.message, /comma-separated/);
    }
  });

  test("trims field tokens and drops empty segments", () => {
    const result = applyQueryFilters(
      { subnets: [{ netuid: 7, name: "Allways", slug: "allways" }] },
      query("/api/v1/subnets?fields=,name"),
      "subnets",
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(result.meta.projection.fields, ["name"]);
    assert.deepEqual(result.data.subnets, [{ name: "Allways" }]);
  });

  test("trims surrounding whitespace on field names", () => {
    const result = applyQueryFilters(
      { subnets: [{ netuid: 7, name: "Allways", slug: "allways" }] },
      query("/api/v1/subnets?fields=netuid,%20name"),
      "subnets",
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(result.meta.projection.fields, ["netuid", "name"]);
    assert.deepEqual(result.data.subnets, [{ netuid: 7, name: "Allways" }]);
  });

  test("rejects genuinely malformed field names", () => {
    const result = applyQueryFilters(
      { subnets: [{ netuid: 7, name: "Allways", slug: "allways" }] },
      query("/api/v1/subnets?fields=netuid,@name"),
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

describe("list-query sort tie-break", () => {
  test("ties on a non-unique field are broken by ascending netuid", () => {
    const data = {
      subnets: [
        { netuid: 3, name: "Alpha" },
        { netuid: 1, name: "Alpha" },
        { netuid: 2, name: "Beta" },
        { netuid: 5, name: "Alpha" },
      ],
    };
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=name"),
      "subnets",
    );
    assert.deepEqual(
      result.data.subnets.map((r) => r.netuid),
      [1, 3, 5, 2],
      "ties on name=Alpha must be broken by ascending netuid",
    );
  });

  test("ties on a non-unique field in desc order are still broken by ascending netuid", () => {
    const data = {
      subnets: [
        { netuid: 3, name: "Alpha" },
        { netuid: 1, name: "Alpha" },
        { netuid: 2, name: "Beta" },
      ],
    };
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=name&order=desc"),
      "subnets",
    );
    // desc: Beta first, then Alpha ties broken by netuid asc
    assert.deepEqual(
      result.data.subnets.map((r) => r.netuid),
      [2, 1, 3],
    );
  });

  test("ties where rows lack netuid fall back to stable source order", () => {
    const data = {
      subnets: [
        { id: "c", name: "Alpha" },
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
    };
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=name"),
      "subnets",
    );
    // Both Alpha rows lack netuid — sort falls back to stable source order (c, a)
    assert.deepEqual(
      result.data.subnets.map((r) => r.id),
      ["c", "a", "b"],
    );
  });
});

// #2073: REST enum/string filters were case-sensitive while MCP list_subnets
// lowercases its args, so ?status=Active returned a 400 the equivalent MCP call
// would not. Enum + string-equality + array-membership matching is now
// case-insensitive (the configured vocabularies + stored values are lowercase).
describe("list-query case-insensitive enum/string filters (#2073)", () => {
  const data = {
    subnets: [
      {
        netuid: 1,
        status: "active",
        subnet_type: "application",
        categories: ["inference"],
      },
      {
        netuid: 2,
        status: "inactive",
        subnet_type: "root",
        categories: ["training"],
      },
    ],
  };
  const netuids = (result) => result.data.subnets.map((r) => r.netuid);

  for (const [mixed, lower] of [
    ["status=Active", "status=active"],
    ["subnet_type=Application", "subnet_type=application"],
    ["domain=Inference", "domain=inference"],
  ]) {
    test(`?${mixed} returns 200 with the same rows as ?${lower}`, () => {
      const upper = applyQueryFilters(
        data,
        query(`/api/v1/subnets?${mixed}`),
        "subnets",
      );
      const lowerResult = applyQueryFilters(
        data,
        query(`/api/v1/subnets?${lower}`),
        "subnets",
      );
      assert.equal(upper.error, undefined, `?${mixed} must not 400`);
      assert.deepEqual(netuids(upper), [1]);
      assert.deepEqual(netuids(upper), netuids(lowerResult));
    });
  }

  test("a genuinely invalid enum value still errors (400 invalid_query)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?status=Bogus"),
      "subnets",
    );
    assert.equal(result.error.parameter, "status");
  });
});

// #6238: the curation collection could sort=curation_level but not filter on it,
// unlike the sibling gaps collection. It's now a real filter using the same
// shared QUERY_ENUMS.curationLevel vocabulary.
describe("list-query curation curation_level filter (#6238)", () => {
  const data = {
    curation: [
      { netuid: 1, curation_level: "native" },
      { netuid: 2, curation_level: "maintainer-reviewed" },
    ],
  };

  test("?curation_level=native narrows the curation list to matching rows", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/curation?curation_level=native"),
      "curation",
    );
    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.data.curation.map((r) => r.netuid),
      [1],
    );
  });

  test("the filter is case-insensitive, like every other enum filter (#2073)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/curation?curation_level=Maintainer-Reviewed"),
      "curation",
    );
    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.data.curation.map((r) => r.netuid),
      [2],
    );
  });

  test("an invalid curation_level errors with parameter curation_level (400 invalid_query)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/curation?curation_level=bogus"),
      "curation",
    );
    assert.equal(result.error.parameter, "curation_level");
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

describe("list-query unknown parameter validation (#2578)", () => {
  const data = {
    subnets: [
      {
        netuid: 1,
        name: "Alpha Inference",
        slug: "alpha",
        status: "active",
        categories: ["inference"],
        block: 150,
      },
      {
        netuid: 2,
        name: "Beta Compute",
        slug: "beta",
        status: "inactive",
        categories: ["compute"],
        block: 50,
      },
    ],
  };

  test("rejects a typoed query parameter before silently returning an unfiltered list", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?statuss=active"),
      "subnets",
    );

    assert.equal(result.error.parameter, "statuss");
    assert.equal(result.error.message, "unknown query parameter.");
  });

  test("accepts every supported list parameter family", () => {
    const result = applyQueryFilters(
      data,
      query(
        "/api/v1/subnets?q=alpha&fields=netuid,name&limit=10&cursor=0" +
          "&sort=netuid&order=asc&status=active&netuids=1" +
          "&domain=inference&min_block=100&max_block=200",
      ),
      "subnets",
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(result.data.subnets, [
      { netuid: 1, name: "Alpha Inference" },
    ]);
    assert.equal(result.meta.pagination.total, 1);
  });

  test("accepts format=csv on csv-enabled list routes", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?format=csv&status=active"),
      "subnets",
      [],
      { csvResponse: true },
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.data.subnets.map((row) => row.netuid),
      [1],
    );
  });

  test("accepts format=json on csv-enabled list routes", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?format=json&status=active"),
      "subnets",
      [],
      { csvResponse: true },
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.data.subnets.map((row) => row.netuid),
      [1],
    );
  });

  test("rejects an unsupported format value on csv-enabled list routes", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?format=xml"),
      "subnets",
      [],
      { csvResponse: true },
    );

    assert.equal(result.error.parameter, "format");
    assert.equal(result.error.message, "format must be json or csv.");
  });

  test("preflight rejects an unsupported format value before artifact reads", () => {
    const error = validateListQueryParams(
      query("/api/v1/subnets?format=xml"),
      "subnets",
      [],
      { csvResponse: true },
    );

    assert.equal(error.parameter, "format");
    assert.equal(error.message, "format must be json or csv.");
  });

  test("rejects format on routes without csv export", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?format=csv"),
      "subnets",
    );

    assert.equal(result.error.parameter, "format");
    assert.equal(result.error.message, "unknown query parameter.");
  });

  test("accepts an empty query string", () => {
    const result = applyQueryFilters(data, query("/api/v1/subnets"), "subnets");

    assert.equal(result.error, undefined);
    assert.equal(result.data.subnets.length, 2);
  });

  test("rejects filters excluded by a route-level queryFilterNames allowlist", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?curation_level=native"),
      "subnets",
      ["netuid"],
    );

    assert.equal(result.error.parameter, "curation_level");
    assert.equal(result.error.message, "unknown query parameter.");
  });

  test("rejects all filters when a route allowlist has no configured filter names", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?status=active"),
      "subnets",
      ["not_a_configured_filter"],
    );

    assert.equal(result.error.parameter, "status");
    assert.equal(result.error.message, "unknown query parameter.");
  });

  test("preflight skips routes without list-query contracts", () => {
    assert.equal(
      validateListQueryParams(
        query("/api/v1/not-a-list?anything=1"),
        undefined,
      ),
      null,
    );
    assert.equal(
      validateListQueryParams(query("/api/v1/not-a-list?anything=1"), "nope"),
      null,
    );
  });

  test("allowlist keeps only configured filter names that exist on the collection", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?netuid=1"),
      "subnets",
      ["netuid", "not_a_configured_filter"],
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.data.subnets.map((row) => row.netuid),
      [1],
    );
  });

  test("transform stays a no-op when the artifact data key is not a list", () => {
    const result = applyQueryFilters(
      { subnets: null },
      query("/api/v1/subnets?statuss=active"),
      "subnets",
    );

    assert.deepEqual(result, { data: { subnets: null }, meta: {} });
  });

  test("handles sparse collection configs without optional filter families", () => {
    const collection = "__test_sparse_rows";
    const previous = API_QUERY_COLLECTIONS[collection];
    API_QUERY_COLLECTIONS[collection] = { data_key: "rows" };
    try {
      assert.equal(
        validateListQueryParams(query("/api/v1/sparse?limit=1"), collection),
        null,
      );

      const sortError = validateListQueryParams(
        query("/api/v1/sparse?sort=name"),
        collection,
      );
      assert.equal(sortError.parameter, "sort");
      assert.equal(sortError.message, "sort is not supported for rows.");

      const result = applyQueryFilters(
        { rows: [] },
        query("/api/v1/sparse?surprise=1"),
        collection,
      );
      assert.equal(result.error.parameter, "surprise");
      assert.equal(result.error.message, "unknown query parameter.");
    } finally {
      if (previous === undefined) {
        delete API_QUERY_COLLECTIONS[collection];
      } else {
        API_QUERY_COLLECTIONS[collection] = previous;
      }
    }
  });
});

// #2085: integration_readiness was sortable/filterable via MCP list_subnets but
// not on the equivalent REST subnets collection. After wiring it into the
// contract's sort + rangeFilters, the generic list-query engine reads row[key]
// and must rank/threshold by it just like the other numeric fields.
describe("list-query integration_readiness (#2085)", () => {
  const data = {
    subnets: [
      { netuid: 1, integration_readiness: 40 },
      { netuid: 2, integration_readiness: 90 },
      { netuid: 3, integration_readiness: 65 },
      { netuid: 4 }, // field absent → sorts last, filtered out by min_
    ],
  };
  const netuids = (result) => result.data.subnets.map((r) => r.netuid);

  test("?sort=integration_readiness&order=desc ranks by the field", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=integration_readiness&order=desc"),
      "subnets",
    );
    // 90, 65, 40 desc, then the row missing the field last.
    assert.deepEqual(netuids(result), [2, 3, 1, 4]);
  });

  test("?min_integration_readiness=N keeps rows >= the bound (inclusive)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_integration_readiness=65"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [2, 3]);
  });
});

// #2587: endpoint-pools and pools are duplicate collection configs (same data_key,
// same filters/sort/rangeFilters). REST exposes endpoint-pools; pools is the
// canonical id for the artifact data_key. Both must accept min_/max_ on counts.
describe("list-query endpoint pool count range filters (#2587)", () => {
  const data = {
    pools: [
      { id: "finney-rpc", eligible_count: 2, endpoint_count: 5 },
      { id: "finney-wss", eligible_count: 8, endpoint_count: 10 },
      { id: "finney-archive", eligible_count: 0, endpoint_count: 3 },
      { id: "test-rpc" }, // eligible_count absent
      { id: "test-wss", eligible_count: "x" }, // non-numeric
    ],
  };
  const poolIds = (result) => result.data.pools.map((r) => r.id);

  for (const collection of ["endpoint-pools", "pools"]) {
    test(`${collection}: min_eligible_count keeps rows >= the bound and drops absent/non-numeric`, () => {
      const result = applyQueryFilters(
        data,
        query("/api/v1/endpoint-pools?min_eligible_count=2"),
        collection,
      );
      assert.deepEqual(poolIds(result), ["finney-rpc", "finney-wss"]);
    });

    test(`${collection}: no range param is a no-op (every row passes)`, () => {
      const result = applyQueryFilters(
        data,
        query("/api/v1/endpoint-pools"),
        collection,
      );
      assert.deepEqual(poolIds(result), [
        "finney-rpc",
        "finney-wss",
        "finney-archive",
        "test-rpc",
        "test-wss",
      ]);
    });

    test(`${collection}: contradictory min_ > max_ on the same field is a query error`, () => {
      const bad = applyQueryFilters(
        data,
        query(
          "/api/v1/endpoint-pools?min_eligible_count=9&max_eligible_count=2",
        ),
        collection,
      );
      assert.equal(bad.error.parameter, "min_eligible_count");
      assert.match(
        bad.error.message,
        /must not be greater than max_eligible_count/,
      );
    });
  }
});

// #2577: endpoints can now threshold on latency_ms / score.
describe("list-query endpoint latency / score range filters (#2577)", () => {
  const data = {
    endpoints: [
      { surface_id: "fast-rpc", latency_ms: 120, score: 0.95 },
      { surface_id: "slow-rpc", latency_ms: 800, score: 0.7 },
      { surface_id: "no-latency", score: 0.5 },
      { surface_id: "non-numeric-latency", latency_ms: "x", score: 0.4 },
    ],
  };
  const surfaceIds = (result) => result.data.endpoints.map((r) => r.surface_id);

  test("?max_latency_ms=500 keeps rows with latency_ms <= 500 and drops non-numeric / absent cells", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/endpoints?max_latency_ms=500"),
      "endpoints",
    );
    assert.deepEqual(surfaceIds(result), ["fast-rpc"]);
  });

  test("?min_latency_ms=100&max_latency_ms=500 keeps rows inside the inclusive latency window", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/endpoints?min_latency_ms=100&max_latency_ms=500"),
      "endpoints",
    );
    assert.deepEqual(surfaceIds(result), ["fast-rpc"]);
  });

  test("?min_score=0.5 keeps rows with score >= 0.5", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/endpoints?min_score=0.5"),
      "endpoints",
    );
    assert.deepEqual(surfaceIds(result), [
      "fast-rpc",
      "slow-rpc",
      "no-latency",
    ]);
  });

  test("no range param is a no-op (every row passes)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/endpoints"),
      "endpoints",
    );
    assert.deepEqual(surfaceIds(result), [
      "fast-rpc",
      "slow-rpc",
      "no-latency",
      "non-numeric-latency",
    ]);
  });

  test("contradictory min_score > max_score is a query error", () => {
    const bad = applyQueryFilters(
      data,
      query("/api/v1/endpoints?min_score=0.9&max_score=0.3"),
      "endpoints",
    );
    assert.equal(bad.error.parameter, "min_score");
    assert.match(bad.error.message, /must not be greater than max_score/);
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

  test("single incomplete page emits no Link header", () => {
    const url = query("/api/v1/subnets?sort=netuid&limit=10");
    const data = {
      subnets: Array.from({ length: 5 }, (_, i) => ({ netuid: i })),
    };
    const { meta } = applyQueryFilters(data, url, "subnets");

    assert.equal(meta.pagination.cursor, 0);
    assert.equal(meta.pagination.next_cursor, null);
    assert.equal(
      paginationLinkHeader(url, meta.pagination, {
        queryCollection: "subnets",
      }),
      null,
    );
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
      paginationLinkHeader(
        query(
          "/api/v1/subnets?sort=netuid&limit=2&utm_campaign=evil&token=SECRET123",
        ),
        { cursor: 0, limit: 2, next_cursor: 2, total: 5 },
        { queryCollection: "subnets" },
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

  test("sparse collection configs without filter families still canonicalize static controls", () => {
    const collection = "__test_sparse_canonical";
    const previous = API_QUERY_COLLECTIONS[collection];
    API_QUERY_COLLECTIONS[collection] = { data_key: "rows" };
    try {
      const search = canonicalListSearch(
        query("/api/v1/sparse?limit=5&cursor=2"),
        collection,
      );
      const p = params(search);
      assert.equal(p.get("limit"), "5");
      assert.equal(p.get("cursor"), "2");
      assert.equal(p.has("status"), false);
    } finally {
      if (previous === undefined) {
        delete API_QUERY_COLLECTIONS[collection];
      } else {
        API_QUERY_COLLECTIONS[collection] = previous;
      }
    }
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

  test("canonicalizes unordered duplicate params in page links", () => {
    const header = paginationLinkHeader(
      pagedUrl(
        "/api/v1/subnets?order=desc&sort=tempo&netuid=7&sort=netuid&limit=2&utm=evil&cursor=0&netuid=8",
      ),
      meta,
      { queryCollection: "subnets" },
    );
    const links = parseLink(header);

    assert.equal(
      links.next.search,
      "?limit=2&cursor=2&sort=tempo&order=desc&netuid=7",
    );
    assert.equal(
      links.last.search,
      "?limit=2&cursor=4&sort=tempo&order=desc&netuid=7",
    );
  });
});

// A string-equality filter must exclude a row that is MISSING the filtered field
// — the same absent-field-excluded convention rangeFilterRows already applies —
// instead of letting String(undefined)/String(null) coerce into a matchable token.
describe("list-query string filter excludes rows missing the field", () => {
  const collection = "__test_string_filter_missing_field";

  function withCollection(fn) {
    const previous = API_QUERY_COLLECTIONS[collection];
    API_QUERY_COLLECTIONS[collection] = {
      data_key: "rows",
      filters: { provider: { type: "string" } },
      csv_filters: {},
      array_filters: {},
      range_filters: [],
      search_keys: [],
      sort_fields: [],
    };
    try {
      return fn();
    } finally {
      if (previous === undefined) {
        delete API_QUERY_COLLECTIONS[collection];
      } else {
        API_QUERY_COLLECTIONS[collection] = previous;
      }
    }
  }

  const data = {
    rows: [
      { id: 1, provider: "alpha" },
      { id: 2 }, // provider absent
    ],
  };
  const ids = (result) => result.data.rows.map((row) => row.id);

  test("?provider=undefined does not match a row whose provider is absent", () => {
    withCollection(() => {
      // Before the null guard, String(undefined) === "undefined" made the
      // provider-less row match; a missing field must never satisfy a value filter.
      const result = applyQueryFilters(
        data,
        query("/api/v1/x?provider=undefined"),
        collection,
      );
      assert.deepEqual(ids(result), []);
    });
  });

  test("a real filter value still matches only the rows that carry it", () => {
    withCollection(() => {
      const result = applyQueryFilters(
        data,
        query("/api/v1/x?provider=alpha"),
        collection,
      );
      assert.deepEqual(ids(result), [1]);
    });
  });
});
