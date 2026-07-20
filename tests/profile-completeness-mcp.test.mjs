import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  LIST_PROFILE_COMPLETENESS_INSTRUCTIONS,
  LIST_PROFILE_COMPLETENESS_MCP_TOOL,
  LIST_PROFILE_COMPLETENESS_OUTPUT_SCHEMA,
  PROFILE_COMPLETENESS_ARTIFACT,
  loadProfileCompletenessList,
  profileCompletenessMcpError,
  profileCompletenessQueryUrl,
} from "../src/profile-completeness-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
  summary: { profile_count: 2 },
  profiles: [
    {
      netuid: 7,
      name: "Allways",
      profile_level: "directory-only",
      identity_level: "partial",
      confidence: "low",
      priority_score: 70,
      native_name_quality: "placeholder",
    },
    {
      netuid: 31,
      name: "Candles",
      profile_level: "adapter-backed",
      identity_level: "complete",
      confidence: "high",
      priority_score: 5,
      native_name_quality: "chain",
    },
  ],
};

function readArtifact(_env, path) {
  if (path === PROFILE_COMPLETENESS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("profile-completeness-mcp", () => {
  test("profileCompletenessMcpError is shaped for MCP toolError handling", () => {
    const err = profileCompletenessMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("profileCompletenessQueryUrl validates filters and cursor", () => {
    const url = profileCompletenessQueryUrl({
      netuid: 7,
      profile_level: "directory-only",
      confidence: "low",
      identity_level: "partial",
      identity_promotion_kinds: "source-repo",
      native_name_quality: "placeholder",
      sort: "priority_score",
      order: "desc",
      fields: "netuid,priority_score",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("profile_level"), "directory-only");
    assert.equal(url.searchParams.get("confidence"), "low");
    assert.equal(url.searchParams.get("identity_level"), "partial");
    assert.equal(
      url.searchParams.get("identity_promotion_kinds"),
      "source-repo",
    );
    assert.equal(url.searchParams.get("native_name_quality"), "placeholder");
    assert.equal(url.searchParams.get("sort"), "priority_score");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("profileCompletenessQueryUrl rejects invalid enums and netuid", () => {
    assert.throws(
      () => profileCompletenessQueryUrl({ profile_level: "bogus" }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => profileCompletenessQueryUrl({ confidence: "bogus" }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => profileCompletenessQueryUrl({ identity_level: "bogus" }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => profileCompletenessQueryUrl({ native_name_quality: "bogus" }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => profileCompletenessQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => profileCompletenessQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => profileCompletenessQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => profileCompletenessQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("profileCompletenessQueryUrl clamps limit", () => {
    assert.equal(
      profileCompletenessQueryUrl({ limit: 500 }).searchParams.get("limit"),
      "100",
    );
    assert.equal(
      profileCompletenessQueryUrl({ limit: 0 }).searchParams.get("limit"),
      "50",
    );
    assert.equal(
      profileCompletenessQueryUrl({ limit: "lots" }).searchParams.get("limit"),
      "50",
    );
  });

  test("profileCompletenessQueryUrl ignores empty optional enums", () => {
    const url = profileCompletenessQueryUrl({
      profile_level: "",
      confidence: null,
      identity_level: undefined,
    });
    assert.equal(url.searchParams.get("profile_level"), null);
    assert.equal(url.searchParams.get("confidence"), null);
    assert.equal(url.searchParams.get("identity_level"), null);
  });

  test("loadProfileCompletenessList returns filtered rows with pagination meta", async () => {
    const out = await loadProfileCompletenessList(
      { env: {}, readArtifact },
      { identity_level: "partial" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.profiles[0].netuid, 7);
    assert.equal(out.summary.profile_count, 2);
    assert.equal(out.generated_at, SAMPLE_BLOB.generated_at);
  });

  test("loadProfileCompletenessList sorts and pages the collection", async () => {
    const out = await loadProfileCompletenessList(
      { env: {}, readArtifact },
      { sort: "priority_score", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.profiles[0].netuid, 7);
    assert.equal(out.next_cursor, 1);
  });

  test("loadProfileCompletenessList uses an injected readArtifact dep", async () => {
    const out = await loadProfileCompletenessList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { profiles: [{ netuid: 0, priority_score: 1 }] },
        }),
      },
    );
    assert.equal(out.profiles[0].netuid, 0);
  });

  test("loadProfileCompletenessList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadProfileCompletenessList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadProfileCompletenessList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadProfileCompletenessList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          },
          {},
        ),
      (err) =>
        err.code === "artifact_timeout" &&
        /profile-completeness\.json/.test(err.message),
    );
  });

  test("loadProfileCompletenessList defaults a missing failure code", async () => {
    await assert.rejects(
      () =>
        loadProfileCompletenessList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          },
          {},
        ),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("loadProfileCompletenessList rejects a non-object blob", async () => {
    await assert.rejects(
      () =>
        loadProfileCompletenessList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadProfileCompletenessList rejects invalid list-query params", async () => {
    await assert.rejects(
      () =>
        loadProfileCompletenessList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadProfileCompletenessList omits nullable artifact metadata when absent", async () => {
    const out = await loadProfileCompletenessList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { profiles: [{ netuid: 0, priority_score: 1 }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.schema_version, null);
    assert.equal(out.summary, null);
  });

  test("loadProfileCompletenessList treats a non-array profiles key as empty", async () => {
    const out = await loadProfileCompletenessList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { profiles: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.profiles, []);
    assert.equal(out.total, 0);
  });

  test("loadProfileCompletenessList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { profiles: [{ netuid: 9 }, { netuid: 10 }] },
      meta: {},
    });
    try {
      const out = await loadProfileCompletenessList(
        { env: {}, readArtifact },
        {},
      );
      assert.equal(out.total, 2);
      assert.equal(out.returned, 2);
      assert.equal(out.limit, 2);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
      assert.equal(out.sort, null);
      assert.equal(out.order, null);
    } finally {
      spy.mockRestore();
    }
  });

  test("tool is registered and instructions mention list_profile_completeness", () => {
    assert.ok(MCP_TOOLS.some((t) => t.name === "list_profile_completeness"));
    assert.match(MCP_INSTRUCTIONS, /list_profile_completeness/);
    assert.match(
      LIST_PROFILE_COMPLETENESS_INSTRUCTIONS,
      /profile-completeness/,
    );
    assert.equal(
      LIST_PROFILE_COMPLETENESS_MCP_TOOL.name,
      "list_profile_completeness",
    );
  });

  test("output schema accepts a successful payload", () => {
    const validate = new Ajv2020({ strict: false }).compile(
      LIST_PROFILE_COMPLETENESS_OUTPUT_SCHEMA,
    );
    assert.ok(
      validate({
        generated_at: "2026-07-01T00:00:00.000Z",
        profiles: [{ netuid: 7 }],
        total: 1,
        returned: 1,
        limit: 1,
        cursor: 0,
        next_cursor: null,
        sort: null,
        order: null,
      }),
    );
  });
});
