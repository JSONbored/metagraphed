import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  GET_SUBNET_PROFILE_MCP_TOOL,
  GET_SUBNET_PROFILE_OUTPUT_SCHEMA,
  LIST_PROFILES_INSTRUCTIONS,
  LIST_PROFILES_MCP_TOOL,
  LIST_PROFILES_OUTPUT_SCHEMA,
  loadProfilesList,
  loadSubnetProfile,
  profilesMcpError,
  profilesQueryUrl,
} from "../src/profiles-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const PROFILE_ROW = {
  netuid: 7,
  slug: "allways",
  name: "Allways",
  completeness_score: 82,
  curation_level: "machine-verified",
  review_state: "verified",
  confidence: "high",
  profile_level: "complete",
  surface_count: 5,
};

const PROFILES_BLOB = {
  captured_at: "2026-06-20T00:00:00Z",
  profiles: [
    PROFILE_ROW,
    {
      ...PROFILE_ROW,
      netuid: 1,
      slug: "alpha",
      name: "Alpha",
      completeness_score: 60,
      confidence: "medium",
    },
  ],
};

function makeCtx() {
  return { env: {} };
}

function makeDeps({ listBlob = PROFILES_BLOB } = {}) {
  return {
    readOptionalArtifact: async (_ctx, path) =>
      path === "/metagraph/profiles.json" ? listBlob : null,
    readArtifact: async (_ctx, path) => {
      if (path === "/metagraph/profiles/7.json") {
        return { subnet: { netuid: 7, slug: "allways" }, profile: PROFILE_ROW };
      }
      const err = profilesMcpError("not_found", "Profile not found.");
      err.code = "not_found";
      throw err;
    },
  };
}

describe("profiles-mcp — profilesQueryUrl", () => {
  test("maps list-query args onto the internal URL", () => {
    const url = profilesQueryUrl({
      netuid: 7,
      q: "allways",
      curation_level: "machine-verified",
      sort: "completeness_score",
      order: "desc",
      limit: 25,
      cursor: 1,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("q"), "allways");
    assert.equal(url.searchParams.get("curation_level"), "machine-verified");
    assert.equal(url.searchParams.get("sort"), "completeness_score");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("limit"), "25");
    assert.equal(url.searchParams.get("cursor"), "1");
  });

  test("rejects invalid netuid and cursor", () => {
    for (const [args, pattern] of [
      [{ netuid: -1 }, /netuid must be a non-negative integer/],
      [{ cursor: -1 }, /cursor must be a non-negative integer/],
      [{ sort: "not_a_field" }, /must be one of:/],
      [{ q: "   " }, /must be a non-empty string/],
      [{ review_state: "   " }, /must be a non-empty string/],
    ]) {
      assert.throws(
        () => profilesQueryUrl(args),
        (err) => {
          assert.equal(err.profilesMcp, true);
          assert.equal(err.code, "invalid_params");
          assert.match(err.message, pattern);
          return true;
        },
      );
    }
  });

  test("maps every optional filter onto the internal URL", () => {
    const url = profilesQueryUrl({
      subnet_type: "application",
      review_state: "verified",
      confidence: "high",
      profile_level: "operational",
      fields: "netuid,name",
      limit: 0,
    });
    assert.equal(url.searchParams.get("subnet_type"), "application");
    assert.equal(url.searchParams.get("review_state"), "verified");
    assert.equal(url.searchParams.get("confidence"), "high");
    assert.equal(url.searchParams.get("profile_level"), "operational");
    assert.equal(url.searchParams.get("fields"), "netuid,name");
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("clamps a non-numeric limit to the default", () => {
    const url = profilesQueryUrl({ limit: "50" });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("clamps zero and negative numeric limits to the default", () => {
    assert.equal(
      profilesQueryUrl({ limit: 0 }).searchParams.get("limit"),
      "100",
    );
    assert.equal(
      profilesQueryUrl({ limit: -5 }).searchParams.get("limit"),
      "100",
    );
  });

  test("accepts a valid cursor", () => {
    const url = profilesQueryUrl({ cursor: 0 });
    assert.equal(url.searchParams.get("cursor"), "0");
  });
});

describe("profiles-mcp — loadProfilesList", () => {
  test("applies list-query filters over profiles.json", async () => {
    const out = await loadProfilesList(
      makeCtx(),
      { netuid: 7, limit: 10 },
      makeDeps(),
    );
    assert.equal(out.profiles.length, 1);
    assert.equal(out.profiles[0].netuid, 7);
    assert.equal(out.returned, 1);
    assert.equal(out.total, 1);
  });

  test("throws not_found when profiles.json is absent", async () => {
    await assert.rejects(
      () => loadProfilesList(makeCtx(), {}, makeDeps({ listBlob: null })),
      (err) => {
        assert.equal(err.profilesMcp, true);
        assert.equal(err.code, "not_found");
        return true;
      },
    );
  });

  test("surfaces invalid_params from list-query validation", async () => {
    await assert.rejects(
      () =>
        loadProfilesList(
          makeCtx(),
          { fields: "netuid,not_a_field" },
          makeDeps(),
        ),
      (err) => {
        assert.equal(err.profilesMcp, true);
        assert.equal(err.code, "invalid_params");
        return true;
      },
    );
  });

  test("supports q search, fields projection, and pagination metadata", async () => {
    const out = await loadProfilesList(
      makeCtx(),
      {
        q: "allways",
        fields: "netuid,name,completeness_score",
        sort: "completeness_score",
        order: "desc",
        limit: 1,
      },
      makeDeps(),
    );
    assert.equal(out.profiles.length, 1);
    assert.equal(out.profiles[0].netuid, 7);
    assert.equal(out.limit, 1);
    assert.equal(out.returned, 1);
    assert.equal(out.cursor, 0);
    assert.equal(out.next_cursor, null);
    assert.deepEqual(Object.keys(out.profiles[0]).sort(), [
      "completeness_score",
      "name",
      "netuid",
    ]);
  });

  test("defaults pagination totals when the list-query meta omits page fields", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { profiles: [PROFILE_ROW] },
      meta: {},
    });
    try {
      const out = await loadProfilesList(makeCtx(), {}, makeDeps());
      assert.equal(out.profiles.length, 1);
      assert.equal(out.total, 1);
      assert.equal(out.returned, 1);
      assert.equal(out.limit, 1);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
      assert.equal(out.sort, null);
      assert.equal(out.order, null);
      assert.equal(out.captured_at, null);
    } finally {
      spy.mockRestore();
    }
  });

  test("falls back when list-query data omits captured_at and profile rows", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { profiles: null },
      meta: { pagination: { total: 0, returned: 0, limit: 0, cursor: 0 } },
    });
    try {
      const out = await loadProfilesList(makeCtx(), {}, makeDeps());
      assert.deepEqual(out.profiles, []);
      assert.equal(out.captured_at, null);
      assert.equal(out.total, 0);
      assert.equal(out.returned, 0);
      assert.equal(out.limit, 0);
    } finally {
      spy.mockRestore();
    }
  });

  test("pages with limit and echoes next_cursor when more rows remain", async () => {
    const out = await loadProfilesList(
      makeCtx(),
      { limit: 1, sort: "netuid", order: "asc" },
      makeDeps(),
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.limit, 1);
    assert.equal(out.next_cursor, 1);
    assert.equal(out.sort, "netuid");
    assert.equal(out.order, "asc");
  });

  test("rejects non-string enum and optional string values", () => {
    assert.throws(() => profilesQueryUrl({ confidence: 9 }), /must be one of:/);
    assert.throws(
      () => profilesQueryUrl({ fields: 123 }),
      /must be a non-empty string/,
    );
  });
});

describe("profiles-mcp — loadSubnetProfile", () => {
  test("loads the per-netuid profile artifact", async () => {
    const out = await loadSubnetProfile(makeCtx(), 7, makeDeps());
    assert.equal(out.subnet?.netuid ?? out.profile?.netuid, 7);
  });

  test("rejects invalid netuid before artifact I/O", async () => {
    await assert.rejects(
      () => loadSubnetProfile(makeCtx(), 7.5, makeDeps()),
      /netuid must be a non-negative integer/,
    );
  });
});

describe("profiles-mcp — MCP metadata", () => {
  test("tool metadata and output schemas compile", () => {
    assert.equal(LIST_PROFILES_MCP_TOOL.name, "list_profiles");
    assert.match(LIST_PROFILES_INSTRUCTIONS, /list_profiles/);
    assert.equal(GET_SUBNET_PROFILE_MCP_TOOL.name, "get_subnet_profile");
    const ajv = new Ajv2020({ strict: false });
    assert.ok(ajv.compile(LIST_PROFILES_OUTPUT_SCHEMA));
    assert.ok(ajv.compile(GET_SUBNET_PROFILE_OUTPUT_SCHEMA));
  });

  test("MCP server exports wire profile tools", () => {
    assert.match(MCP_INSTRUCTIONS, /list_profiles/);
    assert.match(MCP_INSTRUCTIONS, /get_subnet_profile/);
    for (const name of ["list_profiles", "get_subnet_profile"]) {
      const tool = MCP_TOOLS.find((t) => t.name === name);
      assert.ok(tool?.handler, `${name} must be registered`);
    }
  });
});
