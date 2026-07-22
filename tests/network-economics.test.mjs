import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as healthServing from "../src/health-serving.ts";
import {
  economicsQueryUrl,
  GET_ECONOMICS_MCP_TOOL,
  GET_ECONOMICS_OUTPUT_SCHEMA,
  loadNetworkEconomics,
  networkEconomicsError,
} from "../src/network-economics.ts";

const FRESH_RUN = new Date(Date.now() - 60_000).toISOString();

const ECON_ROW = {
  netuid: 7,
  name: "Allways",
  slug: "allways",
  emission_share: 1,
  registration_allowed: true,
};

const ECON_BLOB = {
  contract_version: "test-contract",
  captured_at: FRESH_RUN,
  schema_version: 1,
  summary: { with_economics_count: 1, subnet_count: 1 },
  subnets: [ECON_ROW],
};

function makeCtx({ kv = null } = {}) {
  return {
    readHealthKv(_env, key) {
      if (kv && Object.prototype.hasOwnProperty.call(kv, key)) {
        return Promise.resolve(kv[key]);
      }
      return Promise.resolve(null);
    },
    env: { METAGRAPH_CONTRACT_VERSION: "test-contract" },
  };
}

function makeDeps(artifactData) {
  return {
    contractVersion: () => "test-contract",
    readOptionalArtifact: async () => artifactData,
  };
}

describe("network-economics — economicsQueryUrl", () => {
  test("maps every list-query arg onto the internal URL", () => {
    const url = economicsQueryUrl({
      netuid: 7,
      q: "allways",
      registration_allowed: "true",
      sort: "emission_share",
      order: "desc",
      fields: "netuid,name",
      limit: 50,
      cursor: 2,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("q"), "allways");
    assert.equal(url.searchParams.get("registration_allowed"), "true");
    assert.equal(url.searchParams.get("sort"), "emission_share");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("fields"), "netuid,name");
    assert.equal(url.searchParams.get("limit"), "50");
    assert.equal(url.searchParams.get("cursor"), "2");
  });

  test("rejects invalid netuid and cursor", () => {
    for (const [args, pattern] of [
      [{ netuid: -1 }, /netuid must be a non-negative integer/],
      [{ cursor: -1 }, /cursor must be a non-negative integer/],
    ]) {
      assert.throws(
        () => economicsQueryUrl(args),
        (err) => {
          assert.equal(err.networkEconomics, true);
          assert.equal(err.code, "invalid_params");
          assert.match(err.message, pattern);
          return true;
        },
      );
    }
  });

  test("rejects blank optional strings and invalid enums", () => {
    assert.throws(
      () => economicsQueryUrl({ q: "   " }),
      /must be a non-empty string/,
    );
    assert.throws(
      () => economicsQueryUrl({ sort: "not_a_field" }),
      /must be one of:/,
    );
  });

  test("clamps limit fallback when limit is below 1", () => {
    const url = economicsQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("falls back when limit is not a number", () => {
    const url = economicsQueryUrl({ limit: "50" });
    assert.equal(url.searchParams.get("limit"), "100");
  });
});

describe("network-economics — loadNetworkEconomics", () => {
  test("serves the live KV tier with list-query filters applied", async () => {
    const blob = {
      ...ECON_BLOB,
      subnets: [
        ECON_ROW,
        {
          ...ECON_ROW,
          netuid: 9,
          registration_allowed: false,
          emission_share: 0,
        },
      ],
      summary: {
        ...ECON_BLOB.summary,
        subnet_count: 2,
        with_economics_count: 2,
      },
    };
    const out = await loadNetworkEconomics(
      makeCtx({ kv: { "economics:current": blob } }),
      { registration_allowed: "true", sort: "emission_share", order: "desc" },
      makeDeps(null),
    );
    assert.equal(out.source, "live-kv");
    assert.equal(out.subnets.length, 1);
    assert.equal(out.subnets[0].netuid, 7);
  });

  test("falls back to R2 and pages with limit/cursor", async () => {
    const blob = {
      ...ECON_BLOB,
      subnets: [
        ECON_ROW,
        { ...ECON_ROW, netuid: 8, emission_share: 0.5 },
        { ...ECON_ROW, netuid: 9, emission_share: 0.1 },
      ],
    };
    const out = await loadNetworkEconomics(
      makeCtx(),
      { limit: 2, cursor: 1, sort: "netuid", order: "asc" },
      makeDeps(blob),
    );
    assert.equal(out.source, "r2-fallback");
    assert.equal(out.total, 3);
    assert.equal(out.returned, 2);
    assert.deepEqual(
      out.subnets.map((row) => row.netuid),
      [8, 9],
    );
  });

  test("null-fills optional envelope fields and tolerates missing subnets[]", async () => {
    const out = await loadNetworkEconomics(
      makeCtx(),
      {},
      makeDeps({ captured_at: FRESH_RUN, summary: null }),
    );
    assert.equal(out.source, "r2-fallback");
    assert.deepEqual(out.subnets, []);
    assert.equal(out.summary, null);
    assert.equal(out.network, null);
    assert.equal(out.captured_at, FRESH_RUN);
  });

  test("null-fills captured_at when the snapshot omits it", async () => {
    const out = await loadNetworkEconomics(
      makeCtx(),
      {},
      makeDeps({ subnets: [ECON_ROW], summary: ECON_BLOB.summary }),
    );
    assert.equal(out.captured_at, null);
  });

  test("defaults source when the live tier returns data without a source label", async () => {
    const spy = vi
      .spyOn(healthServing, "resolveLiveEconomics")
      .mockResolvedValue({ data: ECON_BLOB, source: null });
    try {
      const out = await loadNetworkEconomics(makeCtx(), {}, makeDeps(null));
      assert.equal(out.source, "r2-fallback");
    } finally {
      spy.mockRestore();
    }
  });

  test("validates list-query args before live-KV or R2 reads", async () => {
    let tierReads = 0;
    const deps = {
      contractVersion: () => "test-contract",
      readOptionalArtifact: async () => {
        tierReads += 1;
        return ECON_BLOB;
      },
    };
    const ctx = {
      readHealthKv: async () => {
        tierReads += 1;
        return ECON_BLOB;
      },
      env: { METAGRAPH_CONTRACT_VERSION: "test-contract" },
    };
    await assert.rejects(
      () => loadNetworkEconomics(ctx, { netuid: -1 }, deps),
      /netuid must be a non-negative integer/,
    );
    assert.equal(tierReads, 0);
  });

  test("surfaces not_found when neither tier has data", async () => {
    await assert.rejects(
      () => loadNetworkEconomics(makeCtx(), {}, makeDeps(null)),
      (err) => {
        assert.equal(err.code, "not_found");
        assert.match(err.message, /unavailable/);
        return true;
      },
    );
  });

  test("surfaces invalid_params from list-query validation", async () => {
    await assert.rejects(
      () =>
        loadNetworkEconomics(
          makeCtx(),
          { sort: "not_a_field" },
          makeDeps(ECON_BLOB),
        ),
      (err) => {
        assert.equal(err.code, "invalid_params");
        return true;
      },
    );
  });

  test("supports q search, fields projection, netuid filter, and next_cursor", async () => {
    const blob = {
      ...ECON_BLOB,
      network: "finney",
      subnets: [
        ECON_ROW,
        { ...ECON_ROW, netuid: 8, name: "Other", slug: "other" },
        { ...ECON_ROW, netuid: 9, name: "Third", slug: "third" },
      ],
    };
    const searched = await loadNetworkEconomics(
      makeCtx(),
      { q: "allways", fields: "netuid,name,emission_share" },
      makeDeps(blob),
    );
    assert.equal(searched.network, "finney");
    assert.equal(searched.subnets.length, 1);

    const byNetuid = await loadNetworkEconomics(
      makeCtx(),
      { netuid: 8 },
      makeDeps(blob),
    );
    assert.equal(byNetuid.subnets[0].netuid, 8);

    const paged = await loadNetworkEconomics(
      makeCtx(),
      { limit: 1, sort: "netuid", order: "asc" },
      makeDeps(blob),
    );
    assert.equal(paged.next_cursor, 1);
    assert.equal(paged.returned, 1);
  });

  test("rejects unsupported and malformed fields projection", async () => {
    await assert.rejects(
      () =>
        loadNetworkEconomics(
          makeCtx(),
          { fields: "netuid,not_a_field" },
          makeDeps(ECON_BLOB),
        ),
      /unsupported field/,
    );
    await assert.rejects(
      () =>
        loadNetworkEconomics(
          makeCtx(),
          { fields: "netuid,9invalid" },
          makeDeps(ECON_BLOB),
        ),
      /fields must be a comma-separated/,
    );
  });
});

describe("network-economics — MCP surface exports", () => {
  test("declares a compilable tool + output schema", () => {
    assert.equal(GET_ECONOMICS_MCP_TOOL.name, "get_economics");
    assert.ok(
      GET_ECONOMICS_MCP_TOOL.inputSchema.properties.sort.enum.length > 0,
    );
    const ajv = new Ajv2020({ strict: false });
    assert.ok(ajv.compile(GET_ECONOMICS_OUTPUT_SCHEMA));
  });

  test("networkEconomicsError tags typed loader failures", () => {
    const err = networkEconomicsError("invalid_params", "bad");
    assert.equal(err.networkEconomics, true);
    assert.equal(err.code, "invalid_params");
  });
});
