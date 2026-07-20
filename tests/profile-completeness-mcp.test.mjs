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
  notes: ["profile gaps"],
  summary: { profile_count: 2 },
  profiles: [
    {
      netuid: 7,
      name: "Allways",
      priority_score: 80,
      profile_level: "identity-partial",
      identity_level: "partial",
      confidence: "medium",
      native_name_quality: "chain",
      identity_promotion_kinds: ["source-repo"],
    },
    {
      netuid: 12,
      name: "Compute",
      priority_score: 40,
      profile_level: "directory-only",
      identity_level: "none",
      confidence: "low",
      native_name_quality: "empty",
      identity_promotion_kinds: [],
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
      profile_level: "identity-partial",
      confidence: "medium",
      identity_level: "partial",
      identity_promotion_kinds: "source-repo",
      native_name_quality: "chain",
      sort: "priority_score",
      order: "desc",
      fields: "netuid,priority_score",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("profile_level"), "identity-partial");
    assert.equal(url.searchParams.get("confidence"), "medium");
    assert.equal(url.searchParams.get("identity_level"), "partial");
    assert.equal(
      url.searchParams.get("identity_promotion_kinds"),
      "source-repo",
    );
    assert.equal(url.searchParams.get("native_name_quality"), "chain");
    assert.equal(url.searchParams.get("sort"), "priority_score");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("profileCompletenessQueryUrl rejects invalid identity_level", () => {
    assert.throws(
      () => profileCompletenessQueryUrl({ identity_level: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("profileCompletenessQueryUrl rejects non-string fields and invalid order", () => {
    assert.throws(
      () => profileCompletenessQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => profileCompletenessQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("profileCompletenessQueryUrl rejects empty fields projection", () => {
    assert.throws(
      () => profileCompletenessQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("profileCompletenessQueryUrl rejects a non-string enum filter", () => {
    assert.throws(
      () => profileCompletenessQueryUrl({ confidence: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("profileCompletenessQueryUrl trims and forwards a fields projection", () => {
    const url = profileCompletenessQueryUrl({
      fields: " netuid,priority_score ",
    });
    assert.equal(url.searchParams.get("fields"), "netuid,priority_score");
  });

  test("profileCompletenessQueryUrl clamps a non-numeric limit to the default", () => {
    const url = profileCompletenessQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("profileCompletenessQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = profileCompletenessQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("profileCompletenessQueryUrl clamps a non-finite numeric limit to the default", () => {
    const url = profileCompletenessQueryUrl({
      limit: Number.POSITIVE_INFINITY,
    });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("profileCompletenessQueryUrl clamps limit above the MCP maximum", () => {
    const url = profileCompletenessQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("profileCompletenessQueryUrl rejects a fractional netuid and cursor", () => {
    assert.throws(
      () => profileCompletenessQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => profileCompletenessQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("profileCompletenessQueryUrl omits empty optional string/enum filters", () => {
    const url = profileCompletenessQueryUrl({
      fields: "",
      confidence: "",
      identity_level: null,
    });
    assert.equal(url.searchParams.get("fields"), null);
    assert.equal(url.searchParams.get("confidence"), null);
    assert.equal(url.searchParams.get("identity_level"), null);
  });

  test("profileCompletenessQueryUrl rejects invalid netuid and cursor", () => {
    assert.throws(
      () => profileCompletenessQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => profileCompletenessQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadProfileCompletenessList filters, sorts, and paginates", async () => {
    const filtered = await loadProfileCompletenessList(
      { env: {}, readArtifact },
      { identity_level: "partial" },
    );
    assert.equal(filtered.total, 1);
    assert.equal(filtered.profiles[0].netuid, 7);
    assert.equal(filtered.summary.profile_count, 2);

    const sorted = await loadProfileCompletenessList(
      { env: {}, readArtifact },
      { sort: "priority_score", order: "asc" },
    );
    assert.equal(sorted.profiles[0].netuid, 12);

    const paged = await loadProfileCompletenessList(
      { env: {}, readArtifact },
      { limit: 1 },
    );
    assert.equal(paged.returned, 1);
    assert.equal(paged.total, 2);
    assert.ok(paged.next_cursor != null);
  });

  test("loadProfileCompletenessList projects row fields when requested", async () => {
    const out = await loadProfileCompletenessList(
      { env: {}, readArtifact },
      { fields: "netuid,priority_score", limit: 1 },
    );
    assert.deepEqual(out.profiles[0], { netuid: 7, priority_score: 80 });
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
    assert.equal(out.notes, null);
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

  test("loadProfileCompletenessList rejects a cold artifact", async () => {
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

  test("loadProfileCompletenessList rejects a malformed artifact payload", async () => {
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

  test("loadProfileCompletenessList defaults code when the read result is bare", async () => {
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

  test("loadProfileCompletenessList surfaces applyQueryFilters errors", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      error: { message: "bad fields" },
    });
    try {
      await assert.rejects(
        () => loadProfileCompletenessList({ env: {}, readArtifact }, {}),
        (err) =>
          err.code === "invalid_params" && err.message.includes("bad fields"),
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(
      LIST_PROFILE_COMPLETENESS_MCP_TOOL.name,
      "list_profile_completeness",
    );
    assert.match(
      LIST_PROFILE_COMPLETENESS_INSTRUCTIONS,
      /list_profile_completeness/,
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_PROFILE_COMPLETENESS_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_profile_completeness", () => {
    assert.match(MCP_INSTRUCTIONS, /list_profile_completeness/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_profile_completeness");
    assert.ok(tool);
    assert.equal(tool.title, "List subnet profile-completeness gaps");
    assert.ok(tool.inputSchema.properties.netuid);
  });
});
