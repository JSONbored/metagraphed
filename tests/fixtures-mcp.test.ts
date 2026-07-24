import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  FIXTURE_SURFACE_ID_PATTERN,
  fixtureArtifactPath,
  fixtureMcpError,
  loadFixture,
  parseFixtureSurfaceId,
  resolveFixtureArtifactId,
} from "../src/fixtures-mcp.ts";
import type { Row } from "./row-type.ts";

type Ctx = Parameters<typeof loadFixture>[0];
type Deps = Parameters<typeof loadFixture>[2];

const SAMPLE_FIXTURE = {
  surface_id: "allways-api-health",
  netuid: 7,
  kind: "subnet-api",
  request: { method: "GET", url: "https://api.all-ways.io/health" },
  response: { status: 200, body: { ok: true } },
};

function readArtifact(_env: unknown, path: string) {
  if (path === fixtureArtifactPath("allways-api-health")) {
    return Promise.resolve({ ok: true, data: SAMPLE_FIXTURE });
  }
  if (path === fixtureArtifactPath("7:subnet-api:new")) {
    return Promise.resolve({
      ok: true,
      data: { surface_id: "7:subnet-api:new", response: { status: 200 } },
    });
  }
  if (path === "/metagraph/operational-surfaces.json") {
    return Promise.resolve({
      ok: true,
      data: {
        surfaces: [
          {
            surface_id: "7:subnet-api:new",
            surface_key: "srf-renamed",
            netuid: 7,
            kind: "subnet-api",
          },
        ],
      },
    });
  }
  if (path === "/metagraph/surface-aliases.json") {
    return Promise.resolve({
      ok: true,
      data: {
        aliases: [
          {
            deprecated_id: "7:subnet-api:old",
            surface_key: "srf-renamed",
            current_id: "7:subnet-api:new",
            netuid: 7,
            kind: "subnet-api",
          },
        ],
      },
    });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("fixtures-mcp (#7867)", () => {
  test("fixtureMcpError is shaped for toolError handling", () => {
    const err = fixtureMcpError("invalid_params", "bad id");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("parseFixtureSurfaceId validates surface_id", () => {
    assert.equal(
      parseFixtureSurfaceId({ surface_id: "allways-api-health" }),
      "allways-api-health",
    );
    assert.ok(FIXTURE_SURFACE_ID_PATTERN.test("7:subnet-api:new_v2"));
    assert.throws(
      () => parseFixtureSurfaceId({}),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => parseFixtureSurfaceId({ surface_id: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => parseFixtureSurfaceId({ surface_id: "../secrets" }),
      (err: Row) =>
        err.code === "invalid_params" && /invalid characters/.test(err.message),
    );
  });

  test("loadFixture returns the baked fixture", async () => {
    const out = (await loadFixture(
      { env: {}, readArtifact } as unknown as Ctx,
      { surface_id: "allways-api-health" },
    )) as Row;
    assert.equal(out.surface_id, "allways-api-health");
    assert.equal((out.response as Row).status, 200);
  });

  test("loadFixture resolves a deprecated surface_id alias", async () => {
    const out = (await loadFixture(
      { env: {}, readArtifact } as unknown as Ctx,
      { surface_id: "7:subnet-api:old" },
    )) as Row;
    assert.equal(out.surface_id, "7:subnet-api:new");
  });

  test("resolveFixtureArtifactId falls back to the input id when catalogs are cold", async () => {
    const id = await resolveFixtureArtifactId(
      {
        env: {},
        readArtifact: async () => ({ ok: false, code: "artifact_not_found" }),
      } as unknown as Ctx,
      "plain-id",
    );
    assert.equal(id, "plain-id");
  });

  test("loadFixture uses an injected readArtifact dep", async () => {
    const out = (await loadFixture(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as Ctx,
      { surface_id: "injected" },
      {
        readArtifact: async (_env: Env, path: string) => {
          if (path.includes("operational-surfaces")) {
            return { ok: true, data: { surfaces: [] } };
          }
          return {
            ok: true,
            data: { surface_id: "injected", from: "dep" },
          };
        },
      } as unknown as Deps,
    )) as Row;
    assert.equal(out.from, "dep");
  });

  test("loadFixture maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadFixture({ env: {}, readArtifact } as unknown as Ctx, {
          surface_id: "missing-fixture",
        }),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadFixture maps r2_binding_missing to not_found", async () => {
    await assert.rejects(
      () =>
        loadFixture(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "r2_binding_missing",
            }),
          } as unknown as Ctx,
          { surface_id: "allways-api-health" },
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadFixture maps bare failure to not_found via artifact_unavailable", async () => {
    await assert.rejects(
      () =>
        loadFixture(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as Ctx,
          { surface_id: "allways-api-health" },
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadFixture surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadFixture(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          } as unknown as Ctx,
          { surface_id: "allways-api-health" },
        ),
      (err: Row) =>
        err.code === "artifact_timeout" &&
        /fixtures\/allways-api-health\.json/.test(err.message),
    );
  });

  test("loadFixture rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadFixture(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as Ctx,
          { surface_id: "allways-api-health" },
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("resolveFixtureArtifactId uses a direct catalog hit without aliases", async () => {
    const id = await resolveFixtureArtifactId(
      { env: {}, readArtifact } as unknown as Ctx,
      "7:subnet-api:new",
    );
    assert.equal(id, "7:subnet-api:new");
  });
});
