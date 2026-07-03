import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
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
} from "../src/profiles-mcp.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

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

function makeDeps({ listBlob = PROFILES_BLOB, detailBlob = PROFILE_ROW } = {}) {
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
      () =>
        loadProfilesList(makeCtx(), {}, makeDeps({ listBlob: null })),
      (err) => {
        assert.equal(err.profilesMcp, true);
        assert.equal(err.code, "not_found");
        return true;
      },
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

  test("MCP server exports wire profile tools at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.21.0");
    assert.match(MCP_INSTRUCTIONS, /list_profiles/);
    assert.match(MCP_INSTRUCTIONS, /get_subnet_profile/);
    for (const name of ["list_profiles", "get_subnet_profile"]) {
      const tool = MCP_TOOLS.find((t) => t.name === name);
      assert.ok(tool?.handler, `${name} must be registered`);
    }
  });
});
