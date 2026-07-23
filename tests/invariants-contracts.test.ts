// Invariant + regression coverage for the public contract registry
// (src/contracts.mjs). These lock in the structural guarantees the rest of the
// API relies on: every advertised route maps to a real artifact contract, every
// path-template token type compiles to an ANCHORED regex that matches valid refs
// and rejects malformed ones, and the public id namespaces stay unique. A break
// here is a silent contract drift, so these assert PROPERTIES over the whole
// table, not a handful of sampled rows.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  API_ROUTES,
  PUBLIC_ARTIFACTS,
  artifactPathFromTemplate,
  buildApiIndexArtifact,
  buildContractsArtifact,
  buildOpenApiArtifact,
  compileRoutePattern,
} from "../src/contracts.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import type { Row } from "./row-type.ts";

describe("contracts — route ⇄ artifact mapping invariants", () => {
  test("every API route's artifact_path resolves to a public artifact contract", async () => {
    // buildOpenApiArtifact internally calls schemaRefForArtifactPath for each
    // route, which THROWS if a route's artifact_path matches no PUBLIC_ARTIFACTS
    // entry (or that entry has no schema_ref). A clean build is the proof that
    // every route is backed by a real, typed artifact — assert it never throws
    // AND that no route was dropped.
    const generatedAt = "1970-01-01T00:00:00.000Z";
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    );
    assert.equal(Object.keys(openapi.paths).length, API_ROUTES.length);
    for (const route of API_ROUTES) {
      const op = (openapi.paths as Record<string, Record<string, Row>>)[
        route.path
      ]?.[route.method.toLowerCase()];
      assert.ok(op, `route ${route.id} (${route.path}) missing from OpenAPI`);
      const dataRef =
        op.responses["200"].content["application/json"].schema.allOf[1]
          .properties.data.$ref;
      // The resolved data schema must be a NAMED component (a typed artifact),
      // never a generic fallback — that is the whole point of the mapping.
      assert.match(dataRef, /^#\/components\/schemas\/\w+$/);
      const componentName = dataRef.split("/").pop();
      assert.ok(
        (openapi.components.schemas as Row)[componentName],
        `route ${route.id} data schema ${componentName} is not a defined component`,
      );
    }
  });

  test("every API route artifact_path also appears (as a template) in PUBLIC_ARTIFACTS", () => {
    // Reduce each path to its token-shape so a templated route
    // (/metagraph/subnets/{netuid}.json) lines up with its artifact contract.
    const toShape = (p: string) =>
      p
        .replace(/\{netuid\}/g, ":n")
        .replace(/\{slug\}/g, ":s")
        .replace(/\{date\}/g, ":d")
        .replace(/\{surface_id\}/g, ":sid");
    const artifactShapes = new Set(
      PUBLIC_ARTIFACTS.map((a) => toShape(a.path)),
    );
    for (const route of API_ROUTES) {
      assert.ok(
        artifactShapes.has(toShape(route.artifact_path)),
        `route ${route.id} artifact_path ${route.artifact_path} has no PUBLIC_ARTIFACTS contract`,
      );
    }
  });

  test("public id namespaces are unique (routes AND artifacts)", () => {
    const routeIds = API_ROUTES.map((r) => r.id);
    assert.equal(new Set(routeIds).size, routeIds.length, "duplicate route id");
    const artifactIds = PUBLIC_ARTIFACTS.map((a) => a.id);
    assert.equal(
      new Set(artifactIds).size,
      artifactIds.length,
      "duplicate artifact id",
    );
  });

  test("every artifact contract is a /metagraph path; every JSON artifact has a schema_ref", () => {
    for (const artifact of PUBLIC_ARTIFACTS) {
      assert.ok(
        artifact.path.startsWith("/metagraph/"),
        `${artifact.id} is not under /metagraph/`,
      );
      assert.ok(artifact.storage_tier, `${artifact.id} has no storage_tier`);
      // Every JSON payload must be typed; the generated .d.ts text artifact is
      // the documented exception (it carries TS types, not a JSON schema).
      if (artifact.path.endsWith(".json")) {
        assert.ok(
          typeof artifact.schema_ref === "string" && artifact.schema_ref,
          `JSON artifact ${artifact.id} has no schema_ref`,
        );
      } else {
        assert.ok(
          artifact.path.endsWith(".d.ts"),
          `non-JSON artifact ${artifact.id} must be the .d.ts exception`,
        );
        assert.equal(artifact.schema_ref, null);
      }
    }
  });

  test("buildContractsArtifact + buildApiIndexArtifact agree on the route count", () => {
    const generatedAt = "1970-01-01T00:00:00.000Z";
    const contracts = buildContractsArtifact(generatedAt);
    const apiIndex = buildApiIndexArtifact(generatedAt, contracts);
    assert.equal(apiIndex.routes.length, API_ROUTES.length);
    assert.equal(contracts.artifacts.length, PUBLIC_ARTIFACTS.length);
  });
});

describe("contracts — compileRoutePattern per token type", () => {
  // Each token compiles to a named capture group whose character class must
  // match a valid ref and REJECT an out-of-class one. Anchoring (^…$) is the
  // load-bearing property: a token must not match a prefix/suffix of a longer
  // path (which would let a crafted path slip into the wrong handler).
  const cases = [
    {
      token: "{netuid}",
      group: "netuid",
      template: "/api/v1/subnets/{netuid}",
      valid: ["/api/v1/subnets/0", "/api/v1/subnets/74"],
      captured: "74",
      validPath: "/api/v1/subnets/74",
      invalid: ["/api/v1/subnets/-1", "/api/v1/subnets/7a", "/api/v1/subnets/"],
    },
    {
      token: "{uid}",
      group: "uid",
      template: "/api/v1/subnets/{netuid}/neurons/{uid}",
      validPath: "/api/v1/subnets/7/neurons/3",
      captured: "3",
      invalid: [
        "/api/v1/subnets/7/neurons/x",
        "/api/v1/subnets/7/neurons/",
        "/api/v1/subnets/7/neurons/3.5",
      ],
    },
    {
      token: "{ss58}",
      group: "ss58",
      template: "/api/v1/accounts/{ss58}",
      // 48-char base58 (no 0,O,I,l) is a valid ss58 address shape.
      validPath: `/api/v1/accounts/${"5".repeat(48)}`,
      captured: "5".repeat(48),
      invalid: [
        "/api/v1/accounts/short", // too short (<47)
        `/api/v1/accounts/${"0".repeat(48)}`, // base58 excludes 0
        `/api/v1/accounts/${"5".repeat(49)}`, // too long (>48)
      ],
    },
    {
      // {hotkey} (#4334/7.1) shares {ss58}'s compiled token/character class —
      // just a more self-documenting path-parameter name for a route that only
      // ever accepts a hotkey. The captured named group is still `ss58`.
      token: "{hotkey}",
      group: "ss58",
      template: "/api/v1/validators/{hotkey}",
      validPath: `/api/v1/validators/${"5".repeat(48)}`,
      captured: "5".repeat(48),
      invalid: [
        "/api/v1/validators/short", // too short (<47)
        `/api/v1/validators/${"0".repeat(48)}`, // base58 excludes 0
      ],
    },
    {
      token: "{slug}",
      group: "slug",
      template: "/api/v1/adapters/{slug}",
      validPath: "/api/v1/adapters/gittensor",
      captured: "gittensor",
      invalid: [
        "/api/v1/adapters/Gittensor", // uppercase excluded
        "/api/v1/adapters/has_underscore",
        "/api/v1/adapters/",
      ],
    },
    {
      token: "{date}",
      group: "date",
      template: "/api/v1/health/history/{date}",
      validPath: "/api/v1/health/history/2026-06-06",
      captured: "2026-06-06",
      invalid: [
        "/api/v1/health/history/today",
        "/api/v1/health/history/2026-6-6", // not zero-padded
        "/api/v1/health/history/2026-06-06-extra",
      ],
    },
    {
      token: "{surface_id}",
      group: "surface_id",
      template: "/metagraph/schemas/{surface_id}.json",
      validPath: "/metagraph/schemas/7:Subnet_API.new-v2.json",
      captured: "7:Subnet_API.new-v2",
      invalid: [
        "/metagraph/schemas/.json", // empty id
        "/metagraph/schemas/../secrets.json", // traversal-like path
      ],
    },
    {
      token: "{ref} (numeric block number)",
      group: "ref",
      template: "/api/v1/blocks/{ref}",
      validPath: "/api/v1/blocks/8400000",
      captured: "8400000",
      invalid: ["/api/v1/blocks/0x123", "/api/v1/blocks/abc"],
    },
    {
      token: "{ref} (0x block hash)",
      group: "ref",
      template: "/api/v1/blocks/{ref}",
      validPath: `/api/v1/blocks/0x${"a".repeat(64)}`,
      captured: `0x${"a".repeat(64)}`,
      invalid: [
        `/api/v1/blocks/0x${"a".repeat(63)}`, // 63 hex digits
        `/api/v1/blocks/0x${"g".repeat(64)}`, // non-hex
      ],
    },
    {
      token: "{hash} (0x extrinsic hash)",
      group: "hash",
      template: "/api/v1/extrinsics/{hash}",
      validPath: `/api/v1/extrinsics/0x${"F".repeat(64)}`,
      captured: `0x${"F".repeat(64)}`,
      invalid: [
        "/api/v1/extrinsics/123", // a bare number is NOT a hash
        `/api/v1/extrinsics/0x${"a".repeat(65)}`, // 65 hex digits
      ],
    },
    {
      token: "{hash} (composite extrinsic id)",
      group: "hash",
      template: "/metagraph/extrinsics/{hash}.json",
      validPath: "/metagraph/extrinsics/1234-3.json",
      captured: "1234-3",
      invalid: [
        "/metagraph/extrinsics/1234.json", // missing extrinsic_index half
        "/metagraph/extrinsics/1234-3-1.json", // too many halves
      ],
    },
  ];

  for (const c of cases) {
    test(`${c.token} → captures a valid ref + rejects malformed ones`, () => {
      const pattern = compileRoutePattern(c.template);
      const match = pattern.exec(c.validPath);
      assert.ok(match, `${c.token} should match ${c.validPath}`);
      assert.equal(match!.groups![c.group], c.captured);
      for (const bad of c.invalid) {
        assert.equal(pattern.test(bad), false, `${c.token} must reject ${bad}`);
      }
    });
  }

  test("compiled patterns are anchored — no prefix/suffix slip", () => {
    const pattern = compileRoutePattern("/api/v1/subnets/{netuid}");
    // A trailing extra segment must NOT match (would route a deeper path here).
    assert.equal(pattern.test("/api/v1/subnets/7/neurons"), false);
    // A leading prefix must NOT match either.
    assert.equal(pattern.test("/x/api/v1/subnets/7"), false);
    // A single optional trailing slash IS tolerated (the `\/?$` suffix).
    assert.equal(pattern.test("/api/v1/subnets/7/"), true);
  });

  test("artifactPathFromTemplate substitutes every supported token", () => {
    assert.equal(
      artifactPathFromTemplate(
        "/metagraph/subnets/{netuid}/{slug}/{date}/{surface_id}.json",
        { netuid: 7, slug: "x", date: "2026-06-06", surface_id: "sid" },
      ),
      "/metagraph/subnets/7/x/2026-06-06/sid.json",
    );
    // Block-explorer + account tokens (#1686).
    assert.equal(
      artifactPathFromTemplate(
        "/metagraph/subnets/{netuid}/neurons/{uid}.json",
        { netuid: 7, uid: 3 },
      ),
      "/metagraph/subnets/7/neurons/3.json",
    );
    assert.equal(
      artifactPathFromTemplate("/metagraph/accounts/{ss58}.json", {
        ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      }),
      "/metagraph/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5.json",
    );
    // {hotkey} reads from params.ss58, matching compileRoutePattern's shared
    // __METAGRAPH_SS58__ token/named group for this same route.
    assert.equal(
      artifactPathFromTemplate("/metagraph/validators/{hotkey}.json", {
        ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      }),
      "/metagraph/validators/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5.json",
    );
    assert.equal(
      artifactPathFromTemplate("/metagraph/blocks/{ref}.json", { ref: "1234" }),
      "/metagraph/blocks/1234.json",
    );
    assert.equal(
      artifactPathFromTemplate("/metagraph/extrinsics/{hash}.json", {
        hash: "0xabc",
      }),
      "/metagraph/extrinsics/0xabc.json",
    );
    // A missing param substitutes the empty string (never "undefined").
    assert.equal(
      artifactPathFromTemplate("/metagraph/subnets/{netuid}.json", {}),
      "/metagraph/subnets/.json",
    );
  });
});
