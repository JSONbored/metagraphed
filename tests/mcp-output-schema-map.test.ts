import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test, vi } from "vitest";

const work = vi.hoisted(() => ({
  factories: null as Readonly<Record<string, () => unknown>> | null,
  schemas: null as Record<string, unknown> | null,
  calls: [] as string[],
  emissions: 0,
  count: true,
}));
vi.mock("../src/mcp-output-schema-map.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/mcp-output-schema-map.ts")>();
  return {
    ...actual,
    lazyOutputSchemas(factories: Readonly<Record<string, () => unknown>>) {
      work.factories = factories;
      const wrapped = Object.fromEntries(
        Object.entries(factories).map(([name, create]) => [
          name,
          () => {
            work.calls.push(name);
            return create();
          },
        ]),
      );
      const schemas = actual.lazyOutputSchemas(wrapped);
      work.schemas = schemas;
      return schemas;
    },
  };
});
vi.mock("../src/mcp-input-schema.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/mcp-input-schema.ts")>();
  return {
    ...actual,
    outputJsonSchema(schema: Parameters<typeof actual.outputJsonSchema>[0]) {
      if (work.count) work.emissions++;
      return actual.outputJsonSchema(schema);
    },
  };
});
const { lazyOutputSchemas } = await vi.importActual<
  typeof import("../src/mcp-output-schema-map.ts")
>("../src/mcp-output-schema-map.ts");
const { stripSentinelIntegerBounds, outputSchemaSource } =
  await import("../src/mcp-input-schema.ts");
const { MCP_TOOLS, MCP_DISCOVERY_TOOL_NAMES, listToolDefinitions } =
  await import("../src/mcp-server.ts");

test("schema factories run on demand once and retain object identity and hidden source metadata", () => {
  const source = Symbol("source"),
    schema = { type: "object" };
  Object.defineProperty(schema, source, {
    value: { validator: true },
    enumerable: false,
  });
  const create = vi.fn(() => schema);
  const schemas = lazyOutputSchemas({ first: create, second: create });
  assert.deepEqual(Object.keys(schemas), ["first", "second"]);
  assert.equal(create.mock.calls.length, 0);
  assert.equal(schemas.first, schema);
  assert.equal(schemas.first, schema);
  assert.equal(create.mock.calls.length, 1);
  assert.deepEqual(Reflect.get(schemas.first, source), { validator: true });
  assert.equal(
    JSON.stringify(schemas),
    '{"first":{"type":"object"},"second":{"type":"object"}}',
  );
  assert.equal(create.mock.calls.length, 2);
});

test("falsy schema values are cached and a failed factory can retry", () => {
  const create = vi.fn(() => false);
  const schemas = lazyOutputSchemas({ first: create });
  assert.equal(schemas.first, false);
  assert.equal(schemas.first, false);
  assert.equal(create.mock.calls.length, 1);
  const retry = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error("schema unavailable");
    })
    .mockReturnValue({ type: "object" });
  const failed = lazyOutputSchemas({ first: retry });
  assert.throws(() => failed.first, /schema unavailable/);
  assert.deepEqual(failed.first, { type: "object" });
  assert.equal(retry.mock.calls.length, 2);
});

test("loading MCP leaves the output map un-emitted and discovery only asks for its own definitions", () => {
  assert.ok(work.factories);
  assert.equal(work.calls.length, 0);
  assert.ok(
    Object.keys(work.factories).length > MCP_DISCOVERY_TOOL_NAMES.length,
  );
  assert.ok(
    MCP_TOOLS.every(
      (tool) => tool.outputSchema || Object.hasOwn(work.factories!, tool.name),
    ),
    "every tool, including computed names, has an output schema or factory",
  );
  listToolDefinitions("discovery");
  assert.ok(work.calls.length <= MCP_DISCOVERY_TOOL_NAMES.length);
  assert.ok(
    work.calls.every((name) => MCP_DISCOVERY_TOOL_NAMES.includes(name)),
  );
});

test("full, core and discovery schema bytes match eager emission, including tripwire source references", () => {
  const eager = Object.fromEntries(
    Object.entries(work.factories!).map(([name, create]) => [name, create()]),
  );
  const rawByName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
  for (const profile of ["full", "core", "discovery"] as const) {
    const definitions = listToolDefinitions(profile);
    const baseline = definitions.map((definition) => {
      const raw = rawByName.get(definition.name)!;
      const outputSchema = stripSentinelIntegerBounds(
        raw.outputSchema || eager[definition.name],
      );
      assert.deepEqual(definition.outputSchema, outputSchema);
      return { ...definition, ...(outputSchema ? { outputSchema } : {}) };
    });
    assert.equal(JSON.stringify(definitions), JSON.stringify(baseline));
  }
  for (const name of Object.keys(eager)) {
    const schema = work.schemas![name];
    assert.equal(JSON.stringify(schema), JSON.stringify(eager[name]));
    assert.equal(
      Boolean(outputSchemaSource(schema)),
      Boolean(outputSchemaSource(eager[name])),
    );
    assert.equal(work.schemas![name], schema);
    assert.equal(
      outputSchemaSource(work.schemas![name]),
      outputSchemaSource(schema),
    );
  }
});

test("remote fixture measures eager output emission against registration and only the requested schemas", () => {
  const factories = work.factories!;
  const rawByName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
  const discovery = MCP_DISCOVERY_TOOL_NAMES.filter(
    (name) =>
      !rawByName.get(name)?.outputSchema && Object.hasOwn(factories, name),
  );
  assert.ok(Object.hasOwn(factories, "get_account"));
  const fixtures = [
    { name: "discovery", names: discovery },
    { name: "single_account_tool", names: ["get_account"] },
    { name: "full_map_control", names: Object.keys(factories) },
  ];
  const eager = () =>
    Object.fromEntries(
      Object.entries(factories).map(([name, create]) => [name, create()]),
    );
  const sparse = () => lazyOutputSchemas(factories);
  const results = [];
  try {
    for (const fixture of fixtures) {
      const counts = [];
      for (const build of [eager, sparse]) {
        work.count = true;
        work.emissions = 0;
        const schemas = build();
        for (const name of fixture.names) void schemas[name];
        counts.push(work.emissions);
      }
      const measure = (build: typeof sparse) => {
        const start = performance.now();
        const schemas = build();
        const selected = fixture.names.map((name) => schemas[name]);
        const elapsed = performance.now() - start;
        return { elapsed, bytes: JSON.stringify(selected) };
      };
      work.count = false;
      const before = [],
        after = [];
      for (let pair = 0; pair < 9; pair++) {
        let baseline, optimized;
        if (pair % 2 === 0) {
          baseline = measure(eager);
          optimized = measure(sparse);
        } else {
          optimized = measure(sparse);
          baseline = measure(eager);
        }
        assert.equal(optimized.bytes, baseline.bytes);
        before.push(baseline.elapsed);
        after.push(optimized.elapsed);
      }
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[4];
      results.push({
        name: fixture.name,
        requested_map_entries: fixture.names.length,
        baseline_emissions: counts[0],
        optimized_emissions: counts[1],
        baseline_ms: median(before),
        optimized_ms: median(after),
        pairs: 9,
      });
    }
    assert.ok(results[0].baseline_emissions > results[0].optimized_emissions);
    assert.ok(results[0].optimized_emissions <= 4);
    assert.equal(results[1].optimized_emissions, 1);
    assert.equal(results[2].optimized_emissions, results[2].baseline_emissions);
    console.info(
      "MCP_OUTPUT_SCHEMA_EMISSION_FIXTURE",
      JSON.stringify({ node: process.version, results }),
    );
  } finally {
    work.count = true;
  }
});
