// The worked-response examples in the OpenAPI contract are hoisted into
// components.examples and referenced by $ref rather than inlined once per
// media type (#8763). These tests hold that mechanism to its invariants:
// every media type points at exactly one example, every pointer resolves,
// nothing is left inline, nothing is orphaned, and the names are the stable,
// derived ones the generator promises — not whatever route happened to be
// walked first.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  API_ROUTES,
  buildOpenApiArtifact,
  buildOpenApiExampleRegistry,
} from "../src/contracts.ts";
import { readJson, repoRoot } from "../scripts/lib.ts";
import { inlineOpenApiExamples } from "../scripts/openapi-inline-examples.ts";
import path from "node:path";

type Row = Record<string, never>;

const componentSchemas = (
  (await readJson(
    path.join(repoRoot, "public/metagraph/openapi.json"),
  )) as unknown as { components: { schemas: Row } }
).components.schemas;

const openapi = buildOpenApiArtifact(
  "1970-01-01T00:00:00.000Z",
  componentSchemas,
) as unknown as {
  paths: Record<string, Record<string, Operation>>;
  components: { examples: Record<string, { value: unknown }> };
};

type Operation = {
  operationId?: string;
  responses?: {
    "200"?: {
      content?: Record<
        string,
        {
          example?: unknown;
          examples?: Record<string, { $ref?: string }>;
        }
      >;
    };
  };
};

const REF_PREFIX = "#/components/examples/";

/** Every (path, method, media type) in the document that carries examples. */
function mediaTypes() {
  const out: {
    path: string;
    method: string;
    contentType: string;
    operationId: string;
    media: { example?: unknown; examples?: Record<string, { $ref?: string }> };
  }[] = [];
  for (const [routePath, item] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const content = operation?.responses?.["200"]?.content;
      if (!content) continue;
      for (const [contentType, media] of Object.entries(content)) {
        if (!media.examples && media.example === undefined) continue;
        out.push({
          path: routePath,
          method,
          contentType,
          operationId: operation.operationId as string,
          media,
        });
      }
    }
  }
  return out;
}

describe("OpenAPI worked examples are hoisted, not inlined", () => {
  test("every media type carries exactly one $ref example and no inline copy", () => {
    const all = mediaTypes();
    assert.ok(all.length > 0, "expected media types carrying examples");
    for (const { path: routePath, contentType, media } of all) {
      const where = `${routePath} ${contentType}`;
      assert.equal(
        media.example,
        undefined,
        `${where}: inline example must be hoisted, not duplicated`,
      );
      const names = Object.keys(media.examples ?? {});
      assert.equal(names.length, 1, `${where}: expected one worked example`);
      const name = names[0] as string;
      assert.equal(
        media.examples?.[name]?.$ref,
        `${REF_PREFIX}${name}`,
        `${where}: example key must match the component it points at`,
      );
    }
  });

  test("every $ref resolves to a components.examples entry with a value", () => {
    for (const { path: routePath, contentType, media } of mediaTypes()) {
      const name = Object.keys(media.examples ?? {})[0] as string;
      const target = openapi.components.examples[name];
      assert.ok(
        target,
        `${routePath} ${contentType}: dangling $ref ${REF_PREFIX}${name}`,
      );
      assert.notEqual(
        target.value,
        undefined,
        `${routePath} ${contentType}: ${name} has no value`,
      );
    }
  });

  test("components.examples has no orphaned entries", () => {
    const referenced = new Set(
      mediaTypes().map(({ media }) => Object.keys(media.examples ?? {})[0]),
    );
    const orphans = Object.keys(openapi.components.examples).filter(
      (name) => !referenced.has(name),
    );
    assert.deepEqual(orphans, [], "every hoisted example must be referenced");
  });

  test("a JSON example is named for the artifact component it demonstrates", () => {
    // Checked against the operation's OWN data $ref, so the name cannot drift
    // from the schema it is a sample of.
    let checked = 0;
    for (const route of API_ROUTES) {
      const media = openapi.paths[route.path]?.[route.method.toLowerCase()]
        ?.responses?.["200"]?.content?.["application/json"] as
        | {
            schema?: {
              allOf?: { properties?: { data?: { $ref?: string } } }[];
            };
            examples?: Record<string, { $ref?: string }>;
          }
        | undefined;
      const dataRef = media?.schema?.allOf?.[1]?.properties?.data?.$ref;
      const component = (dataRef as string).split("/").pop() as string;
      assert.equal(
        Object.keys(media?.examples ?? {})[0],
        `${component}Response`,
        `${route.path}: example name must be derived from ${component}`,
      );
      checked += 1;
    }
    assert.equal(checked, API_ROUTES.length);
  });

  test("routes sharing an artifact component share one example entry", () => {
    // The dedup that makes hoisting worth doing: the four *-history artifacts
    // and every network-addressed twin (#8698) resolve to a single entry
    // rather than a private copy each.
    const namesByComponent = new Map<string, Set<string>>();
    for (const route of API_ROUTES) {
      const operation = openapi.paths[route.path]?.[route.method.toLowerCase()];
      const media = operation?.responses?.["200"]?.content?.[
        "application/json"
      ] as { examples?: Record<string, { $ref?: string }> } | undefined;
      const name = Object.keys(media?.examples ?? {})[0] as string;
      const component = name.replace(/Response$/, "");
      const existing = namesByComponent.get(component) ?? new Set<string>();
      existing.add(name);
      namesByComponent.set(component, existing);
    }
    for (const [component, names] of namesByComponent) {
      assert.equal(
        names.size,
        1,
        `${component} resolved to ${names.size} example entries; expected one`,
      );
    }
  });

  test("a CSV example is named for the alphabetically-first operation showing it", () => {
    // Alphabetical rather than route order, so adding a route can never
    // silently rename an entry that already shipped.
    const operationIdsByName = new Map<string, string[]>();
    for (const { contentType, operationId, media } of mediaTypes()) {
      if (contentType !== "text/csv") continue;
      const name = Object.keys(media.examples ?? {})[0] as string;
      operationIdsByName.set(name, [
        ...(operationIdsByName.get(name) ?? []),
        operationId,
      ]);
    }
    assert.ok(operationIdsByName.size > 0, "expected CSV examples");
    for (const [name, operationIds] of operationIdsByName) {
      const first = [...operationIds].sort()[0] as string;
      assert.equal(
        name,
        `${first.charAt(0).toUpperCase()}${first.slice(1)}Csv`,
        `CSV example ${name} must be named for its alphabetically-first operation`,
      );
    }
  });

  test("hoisting removes real duplication rather than renaming it", () => {
    // Distinct entries may still hold equal values (two components that happen
    // to sample identically keep their own, honestly-named entry on purpose).
    // What must NOT happen is the same component being written twice.
    const names = Object.keys(openapi.components.examples);
    assert.equal(
      names.length,
      new Set(names).size,
      "components.examples keys must be unique",
    );
    // Fewer entries than the media types referencing them — i.e. sharing is
    // actually happening, not just indirection for its own sake.
    assert.ok(
      names.length < mediaTypes().length,
      `expected fewer example entries (${names.length}) than referencing media types (${mediaTypes().length})`,
    );
  });
});

describe("one component, one worked example", () => {
  test("two routes on one component with different values are rejected", () => {
    // Not a theoretical guard: openApiExampleForRoute overrides the sampled
    // value for `fixture-detail`, so a second route on that same artifact path
    // yields two different values under one name. Without the guard, whichever
    // route was walked last would silently win and the document would publish
    // the wrong worked example for one of them.
    const fixtureRoute = API_ROUTES.find(
      (route) => route.id === "fixture-detail",
    );
    assert.ok(fixtureRoute, "expected a fixture-detail route to exist");
    const twin = { ...fixtureRoute, id: "fixture-detail-twin" };
    assert.throws(
      () =>
        buildOpenApiExampleRegistry(componentSchemas as unknown as Row, [
          fixtureRoute,
          twin,
        ]),
      /OpenAPI example collision/,
    );
  });

  test("two routes on one component with equal values are fine", () => {
    const route = API_ROUTES.find((entry) => entry.id === "coverage");
    assert.ok(route, "expected a coverage route to exist");
    const registry = buildOpenApiExampleRegistry(
      componentSchemas as unknown as Row,
      [route, { ...route, id: "coverage-twin" }],
    );
    assert.equal(
      registry.jsonNameByRouteId.get("coverage"),
      registry.jsonNameByRouteId.get("coverage-twin"),
      "identical values must share one entry rather than collide",
    );
  });
});

describe("the inlined projection keeps the generated types documented", () => {
  // openapi-typescript cannot read the hoisted map and would drop every
  // `@example` JSDoc block from the published .d.ts artifacts. Type generation
  // and drift validation therefore both read an inlined projection instead.
  // These tests hold that projection to being a faithful, lossless view — the
  // documentation is preserved, not approximated.
  const projected = structuredClone(openapi) as unknown as Record<
    string,
    unknown
  >;
  const inlined = inlineOpenApiExamples(projected);
  const projectedPaths = (projected as unknown as typeof openapi).paths;

  test("every hoisted example comes back inline, with nothing left behind", () => {
    // Asserted structurally, per media type, rather than as a rewrite count.
    // A network-addressed variant (#8698) is built by spreading the base
    // operation, so base and twin SHARE one `responses` object — and
    // structuredClone preserves that sharing. One rewrite therefore serves both
    // paths here, making the count lower than the number of (path, media type)
    // pairs while every pair is still correctly inlined. The real generator
    // reads the spec back from disk, where nothing is shared and every pair is
    // rewritten individually; this invariant holds either way, a count does not.
    assert.ok(inlined > 0, "expected the projection to rewrite something");

    // No `examples` map survives anywhere — including the feed routes, whose
    // media types (application/rss+xml and friends) never carried one.
    for (const [routePath, item] of Object.entries(projectedPaths)) {
      for (const [method, operation] of Object.entries(item)) {
        for (const [contentType, media] of Object.entries(
          operation?.responses?.["200"]?.content ?? {},
        )) {
          assert.equal(
            media.examples,
            undefined,
            `${routePath} ${method} ${contentType}: examples map must be consumed`,
          );
        }
      }
    }

    // And every media type that HAD an example ends up with it inline, which is
    // what openapi-typescript needs to emit the `@example` JSDoc.
    for (const { path: routePath, method, contentType } of mediaTypes()) {
      const media = (projectedPaths[routePath]?.[method]?.responses?.["200"]
        ?.content ?? {})[contentType] as { example?: unknown };
      assert.notEqual(
        media?.example,
        undefined,
        `${routePath} ${method} ${contentType}: must carry an inline example for the JSDoc`,
      );
    }
  });

  test("each inlined value is the one its $ref pointed at", () => {
    for (const {
      path: routePath,
      method,
      contentType,
      media,
    } of mediaTypes()) {
      const name = Object.keys(media.examples ?? {})[0] as string;
      const projectedMedia = (projectedPaths[routePath]?.[method]?.responses?.[
        "200"
      ]?.content ?? {})[contentType] as { example?: unknown };
      assert.deepEqual(
        projectedMedia.example,
        openapi.components.examples[name]?.value,
        `${routePath} ${contentType}: inlined value must match ${name}`,
      );
    }
  });
});
