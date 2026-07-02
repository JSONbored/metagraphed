// #1000 — the cold-start committed-seed gate. Proves it (a) passes on the
// current committed seed and (b) catches the exact #356/#998 drift class
// (a required field added to the schema but missing from the committed seed),
// using a synthetic env so the real public/ files are never touched.

import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  committedSeedRoutes,
  runCommittedSeedGate,
} from "../scripts/validate-committed-seed.mjs";
import { createLocalArtifactEnv, readJson, repoRoot } from "../scripts/lib.mjs";

const openapi = await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
);

describe("committed cold-start seed gate", () => {
  it("derives the DUAL-tier committed routes (only the contract stays committed)", () => {
    const paths = committedSeedRoutes().map((route) => route.path);
    expect(paths.length).toBeGreaterThan(0);
    // The reproducible contract stays committed; live-data indexes (incl.
    // agent-catalog) moved to R2-only (#1003), so they leave the seed set.
    expect(paths).toContain("/api/v1");
    expect(paths).not.toContain("/api/v1/agent-catalog");
    // Per-subnet detail is R2-only and must NOT be in scope (it 404s pre-build).
    expect(paths.every((p) => !p.includes("{"))).toBe(true);
  });

  it("passes on the current committed seed", async () => {
    const env = createLocalArtifactEnv();
    const { checked, errors } = await runCommittedSeedGate({ env, openapi });
    expect(checked).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it("accepts not-captured schema-index placeholders", () => {
    const operation = openapi.paths["/api/v1/schemas"].get;
    const responseSchema =
      operation.responses["200"].content["application/json"].schema;
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: true,
      strict: false,
      validateFormats: true,
    });
    addFormats(ajv);
    const validate = ajv.compile({
      components: openapi.components,
      ...responseSchema,
    });
    const body = {
      ok: true,
      schema_version: 1,
      data: {
        schema_version: 1,
        contract_version: "test",
        generated_at: "1970-01-01T00:00:00.000Z",
        source: "openapi-snapshot",
        schemas: [
          {
            netuid: 59,
            subnet_slug: "sn-59",
            surface_id: "sn-59-babelbit-openapi",
            url: "https://api.babelbit.ai/openapi.json",
            schema_url: "https://api.babelbit.ai/openapi.json",
            status: "not-captured",
            drift_status: "not-captured",
            hash: null,
            previous_hash: null,
            path: null,
            error: null,
          },
        ],
      },
      meta: {
        contract_version: "test",
      },
    };

    expect(validate(body), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("flags a committed contract seed that no longer matches the schema", async () => {
    // Serve a deliberately-broken api-index — a route entry missing its required
    // `id` — so the /api/v1 response fails the (strict) ApiRoute schema.
    // api-index.json is a committed (dual) contract artifact served ASSETS-first,
    // so overriding ASSETS for that one path injects the drift; every other path
    // passes through to the real committed seed.
    const fresh = await readJson(
      path.join(repoRoot, "public/metagraph/api-index.json"),
    );
    const stale = structuredClone(fresh);
    if (stale.routes?.[0]) delete stale.routes[0].id;
    const isApiIndex = (value) => String(value).endsWith("api-index.json");

    const base = createLocalArtifactEnv();
    const env = {
      ...base,
      ASSETS: {
        async fetch(request) {
          if (isApiIndex(new URL(request.url).pathname)) {
            return new Response(JSON.stringify(stale), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return base.ASSETS.fetch(request);
        },
      },
    };

    const { errors } = await runCommittedSeedGate({ env, openapi });
    const joined = errors.join("\n");
    expect(joined).toMatch(/\/api\/v1\b/);
    expect(joined).toMatch(/id/);
  });
});
