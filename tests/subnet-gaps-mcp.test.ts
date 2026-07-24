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
type Deps = Parameters<typeof loadSubnetGapsList>[2];

const SAMPLE_BLOB = {
  schema_version: 1,
  contract_version: "1.0.0",
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["gaps"],
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
      () => requireSubnetGapsNetuid({}),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => requireSubnetGapsNetuid({ netuid: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => requireSubnetGapsNetuid({ netuid: 1.5 }),
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

  test("subnetGapsQueryUrl accepts string missing_kinds and numeric cursor", () => {
    const url = subnetGapsQueryUrl({
      netuid: 5,
      missing_kinds: "docs",
      cursor: 3,
      limit: 200,
      fields: "netuid,slug",
    });
    assert.equal(url.searchParams.get("missing_kinds"), "docs");
    assert.equal(url.searchParams.get("cursor"), "3");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("fields"), "netuid,slug");
  });

  test("subnetGapsQueryUrl clamps non-positive limits to the default", () => {
    assert.equal(
      subnetGapsQueryUrl({ netuid: 5, limit: 0 }).searchParams.get("limit"),
      "50",
    );
    assert.equal(
      subnetGapsQueryUrl({ netuid: 5, limit: Number.NaN }).searchParams.get(
        "limit",
      ),
      "50",
    );
    assert.equal(
      subnetGapsQueryUrl({ netuid: 5, limit: "lots" }).searchParams.get(
        "limit",
      ),
      "50",
    );
  });

  test("subnetGapsQueryUrl rejects invalid inputs", () => {
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, sort: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, curation_level: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, order: "sideways" }),
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
      () => subnetGapsQueryUrl({ netuid: 5, missing_kinds: [12] }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, missing_kinds: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, review_state: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, review_state: 12 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, cursor: "abc" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 5, cursor: 1.5 }),
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
    assert.equal(out.schema_version, 1);
    assert.equal(out.contract_version, "1.0.0");
    assert.equal(out.slug, "demo");
    assert.equal(out.name, "Demo");
  });

  test("loadSubnetGapsList filters by missing_kinds", async () => {
    const out = await loadSubnetGapsList(
      { env: {}, readArtifact } as unknown as Ctx,
      { netuid: 5, missing_kinds: ["docs"] },
    );
    assert.equal(out.total, 1);
    assert.deepEqual(out.priorities[0].missing_kinds, ["docs"]);
  });

  test("loadSubnetGapsList uses an injected readArtifact dep", async () => {
    const out = await loadSubnetGapsList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as Ctx,
      { netuid: 5 },
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            priorities: [{ id: "injected", missing_kinds: ["website"] }],
            enrichment_queue: null,
          },
        }),
      } as unknown as Deps,
    );
    assert.equal(out.priorities[0].id, "injected");
    assert.deepEqual(out.enrichment_queue, []);
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

  test("loadSubnetGapsList maps bare failure to not_found via artifact_unavailable", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
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
      (err: Row) =>
        err.code === "artifact_timeout" && /gaps\/5\.json/.test(err.message),
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

  test("loadSubnetGapsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList({ env: {}, readArtifact } as unknown as Ctx, {
          netuid: 5,
          fields: "not_a_column",
        }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSubnetGapsList treats a non-array priorities key as empty", async () => {
    const out = await loadSubnetGapsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { priorities: null, enrichment_queue: [{ lane: "x" }] },
        }),
      } as unknown as Ctx,
      { netuid: 5 },
    );
    assert.deepEqual(out.priorities, []);
    assert.equal(out.total, 0);
    assert.equal(out.enrichment_queue[0].lane, "x");
  });

  test("loadSubnetGapsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: {
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
      assert.equal(out.returned, 1);
      assert.equal(out.limit, 1);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
      assert.equal(out.sort, null);
      assert.equal(out.order, null);
      assert.equal(out.netuid, 5);
      assert.equal(out.generated_at, null);
      assert.equal(out.notes, null);
      assert.equal(out.slug, null);
      assert.equal(out.name, null);
    } finally {
      spy.mockRestore();
    }
  });
});
