import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import * as listQuery from "../workers/list-query.ts";
import {
  loadSubnetGapsList,
  requireSubnetGapsNetuid,
  subnetGapsArtifactPath,
  subnetGapsMcpError,
  subnetGapsQueryUrl,
} from "../src/subnet-gaps-mcp.ts";
import type { Row } from "./row-type.ts";

type Ctx = Parameters<typeof loadSubnetGapsList>[0];

const SAMPLE_BLOB = {
  schema_version: 1,
  generated_at: "2026-07-01T00:00:00.000Z",
  netuid: 5,
  slug: "demo",
  name: "Demo",
  priorities: [
    {
      netuid: 5,
      missing_kinds: ["docs"],
      priority_score: 72,
      curation_level: "maintainer-reviewed",
      review_state: "maintainer-reviewed",
    },
    {
      netuid: 5,
      missing_kinds: ["openapi"],
      priority_score: 40,
      curation_level: "candidate-discovered",
      review_state: "community-submitted",
    },
  ],
  enrichment_queue: [{ netuid: 5, lane: "direct-submission" }],
};

function readArtifact(_env: unknown, path: string) {
  if (path === subnetGapsArtifactPath(5)) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("subnet-gaps-mcp (#7880)", () => {
  test("subnetGapsMcpError is shaped for toolError handling", () => {
    const err = subnetGapsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("requireSubnetGapsNetuid validates netuid", () => {
    assert.equal(requireSubnetGapsNetuid({ netuid: 5 }), 5);
    assert.throws(
      () => requireSubnetGapsNetuid({ netuid: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetGapsQueryUrl forwards filters including missing_kinds list", () => {
    const url = subnetGapsQueryUrl({
      netuid: 5,
      curation_level: "candidate-discovered",
      missing_kinds: ["openapi", "docs"],
      review_state: "community-submitted",
      sort: "priority_score",
      order: "desc",
      limit: 10,
      cursor: "0",
    });
    assert.equal(
      url.searchParams.get("curation_level"),
      "candidate-discovered",
    );
    assert.equal(url.searchParams.get("missing_kinds"), "openapi");
    assert.equal(url.searchParams.get("review_state"), "community-submitted");
    assert.equal(url.searchParams.get("sort"), "priority_score");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "0");
  });

  test("subnetGapsQueryUrl rejects invalid inputs", () => {
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, sort: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, missing_kinds: ["seed-node"] }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, missing_kinds: [] }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, cursor: "abc" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSubnetGapsList filters by curation_level", async () => {
    const out = await loadSubnetGapsList(
      { env: {}, readArtifact } as unknown as Ctx,
      { netuid: 5, curation_level: "candidate-discovered" },
    );
    assert.equal(out.total, 1);
    assert.equal(out.priorities[0].curation_level, "candidate-discovered");
    assert.equal(out.enrichment_queue[0].lane, "direct-submission");
  });

  test("loadSubnetGapsList filters by missing_kinds", async () => {
    const out = await loadSubnetGapsList(
      { env: {}, readArtifact } as unknown as Ctx,
      { netuid: 5, missing_kinds: ["docs"] },
    );
    assert.equal(out.total, 1);
    assert.deepEqual(out.priorities[0].missing_kinds, ["docs"]);
  });

  test("loadSubnetGapsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList({ env: {}, readArtifact } as unknown as Ctx, {
          netuid: 999,
        }),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSubnetGapsList maps r2_binding_missing to not_found", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "r2_binding_missing",
            }),
          } as unknown as Ctx,
          { netuid: 5 },
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSubnetGapsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          } as unknown as Ctx,
          { netuid: 5 },
        ),
      (err: Row) => err.code === "artifact_timeout",
    );
  });

  test("loadSubnetGapsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as Ctx,
          { netuid: 5 },
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSubnetGapsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: {
        netuid: 5,
        priorities: [{ id: "a" }],
        enrichment_queue: [],
      },
      meta: undefined,
    });
    try {
      const out = await loadSubnetGapsList(
        { env: {}, readArtifact } as unknown as Ctx,
        { netuid: 5 },
      );
      assert.equal(out.total, 1);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
    } finally {
      spy.mockRestore();
    }
  });
});
