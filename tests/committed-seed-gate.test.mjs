// #1000 — the cold-start committed-seed gate. Proves it (a) passes on the
// current committed seed and (b) catches the exact #356/#998 drift class
// (a required field added to the schema but missing from the committed seed),
// using a synthetic env so the real public/ files are never touched.

import path from "node:path";
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
  it("derives the DUAL-tier committed routes (incl. agent-catalog)", () => {
    const paths = committedSeedRoutes().map((route) => route.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain("/api/v1/agent-catalog");
    // Per-subnet detail is R2-only and must NOT be in scope (it 404s pre-build).
    expect(paths.every((p) => !p.includes("{"))).toBe(true);
  });

  it("passes on the current committed seed", async () => {
    const env = createLocalArtifactEnv();
    const { checked, errors } = await runCommittedSeedGate({ env, openapi });
    expect(checked).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it("flags a stale agent-catalog seed missing readiness_tier", async () => {
    // Build a deliberately-stale agent-catalog (readiness_tier stripped) and
    // serve it from BOTH tiers the Worker may read (ASSETS + R2 archive), so the
    // injection is robust to the R2-preferred-dual serving order. Every other
    // path passes through to the real committed seed.
    const fresh = await readJson(
      path.join(repoRoot, "public/metagraph/agent-catalog.json"),
    );
    const stale = structuredClone(fresh);
    for (const subnet of stale.subnets ?? []) {
      if (subnet.readiness) delete subnet.readiness.readiness_tier;
    }
    const isAgentCatalog = (value) =>
      String(value).endsWith("agent-catalog.json");

    const base = createLocalArtifactEnv();
    const env = {
      ...base,
      ASSETS: {
        async fetch(request) {
          if (isAgentCatalog(new URL(request.url).pathname)) {
            return new Response(JSON.stringify(stale), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return base.ASSETS.fetch(request);
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key) {
          if (isAgentCatalog(key)) {
            return {
              async json() {
                return stale;
              },
              async text() {
                return JSON.stringify(stale);
              },
            };
          }
          return base.METAGRAPH_ARCHIVE.get(key);
        },
      },
    };

    const { errors } = await runCommittedSeedGate({ env, openapi });
    const joined = errors.join("\n");
    expect(joined).toMatch(/agent-catalog/);
    expect(joined).toMatch(/readiness_tier/);
  });
});
