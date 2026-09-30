import assert from "node:assert/strict";
import { test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { mockEnv, type Row } from "./row-type.ts";

function fixture(prefixCount: number, schemas: Row[] = []) {
  const reads: string[] = [];
  let schemaFailure = false;
  let registryFailure = false;
  let registryGate: Promise<void> | undefined;
  let announceRegistry!: () => void;
  const registryStarted = new Promise<void>((resolve) => {
    announceRegistry = resolve;
  });
  const subnets = Array.from({ length: 46 }, (_, netuid) => ({ netuid }));
  // Five fixed resources and 92 subnet resources; provider rows fill the rest.
  const providers = Array.from({ length: prefixCount - 97 }, (_, i) => ({
    slug: `provider-${i}`,
  }));
  const readArtifact = async (_env: Env, path: string) => {
    reads.push(path);
    if (path === "/metagraph/schemas/index.json") {
      if (schemaFailure) throw new Error("schema index unavailable");
      return { ok: true, data: { schemas } };
    }
    announceRegistry();
    await registryGate;
    if (registryFailure) return { ok: false, code: "artifact_not_found" };
    return {
      ok: true,
      data: path.includes("subnets") ? { subnets } : { providers },
    };
  };
  async function page(cursor?: string, path = "/mcp", protocol = "2025-06-18") {
    const response = await handleMcpRequest(
      new Request(`https://mcp.invalid${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": protocol,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/list",
          params: cursor === undefined ? {} : { cursor },
        }),
      }),
      mockEnv(),
      {
        readArtifact: readArtifact as NonNullable<
          Parameters<typeof handleMcpRequest>[2]
        >["readArtifact"],
      },
    );
    assert.equal(response.status, 200);
    const bytes = await response.text();
    return { bytes, result: (JSON.parse(bytes) as Row).result as Row };
  }
  return {
    page,
    reads,
    subnets,
    providers,
    registryStarted,
    pauseRegistry() {
      let release!: () => void;
      registryGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failSchemas() {
      schemaFailure = true;
    },
    failRegistry() {
      registryFailure = true;
    },
    schemaReads: () => reads.filter((path) => path.includes("schemas")).length,
  };
}

test("one slot before the boundary still loads schemas and returns the first schema", async () => {
  const f = fixture(99, [{ surface_id: "first" }, { id: "second" }]);
  const first = await f.page();
  assert.equal(f.schemaReads(), 1);
  assert.equal(first.result.resources.length, 100);
  assert.equal(first.result.resources[99].uri, "metagraph://schema/first");
  assert.equal(first.result.nextCursor, "100");
  const second = await f.page(first.result.nextCursor);
  assert.deepEqual(
    second.result.resources.map((r: Row) => r.uri),
    ["metagraph://schema/second"],
  );
  assert.equal(Object.hasOwn(second.result, "nextCursor"), false);
});

test("cold later cursors start schema and registry reads concurrently", async () => {
  const f = fixture(265, [{ surface_id: "last" }]);
  const release = f.pauseRegistry();
  const response = f.page("100");
  await f.registryStarted;
  try {
    assert.equal(
      f.schemaReads(),
      1,
      "schema lookup starts before registry reads finish",
    );
  } finally {
    release();
  }
  assert.equal((await response).result.resources.length, 100);
});

test("an exactly full page loads schemas to distinguish the final page from a continuation", async () => {
  for (const schemas of [[], [{ surface_id: "next" }]]) {
    const f = fixture(100, schemas);
    const first = await f.page();
    assert.equal(f.schemaReads(), 1);
    assert.equal(first.result.resources.length, 100);
    assert.equal(first.result.nextCursor, schemas.length ? "100" : undefined);
  }
});

test("an already proven continuation avoids the unused index across profiles and protocols", async () => {
  const f = fixture(101, [{ surface_id: "last" }]);
  const initial = await f.page();
  assert.equal(f.schemaReads(), 0);
  assert.equal(initial.result.nextCursor, "100");
  for (const protocol of ["2025-06-18", "2025-03-26"]) {
    for (const path of ["/mcp", "/mcp/core", "/mcp?catalog=full"]) {
      assert.equal(
        (await f.page(undefined, path, protocol)).bytes,
        initial.bytes,
      );
    }
  }
  assert.equal(f.schemaReads(), 0);
  const last = await f.page("100");
  assert.equal(f.schemaReads(), 1);
  assert.deepEqual(
    last.result.resources.map((r: Row) => r.uri),
    ["metagraph://provider/provider-3", "metagraph://schema/last"],
  );
  assert.equal(Object.hasOwn(last.result, "nextCursor"), false);
});

test("missing indexes preserve graceful omission and final cursor behavior", async () => {
  const f = fixture(101);
  f.failSchemas();
  assert.equal((await f.page()).result.nextCursor, "100");
  assert.equal(f.schemaReads(), 0);
  const last = await f.page("100");
  assert.equal(f.schemaReads(), 1);
  assert.equal(last.result.resources.length, 1);
  assert.equal(Object.hasOwn(last.result, "nextCursor"), false);
  f.failRegistry();
  assert.equal((await f.page()).result.resources.length, 5);
  assert.equal(f.schemaReads(), 2);
});

test("valid emitted entries determine the boundary, and schema aliases and omissions remain intact", async () => {
  const f = fixture(101, [{}, { id: "alias", content_type: "text/plain" }]);
  f.providers[0] = {} as { slug: string };
  f.subnets[0] = {} as { netuid: number };
  const result = (await f.page()).result;
  assert.equal(f.schemaReads(), 1);
  assert.equal(result.resources.length, 99);
  assert.deepEqual(result.resources.at(-1), {
    uri: "metagraph://schema/alias",
    name: "schema-alias",
    title: "Schema — alias",
    description: "Captured machine-readable API schema.",
    mimeType: "text/plain",
  });
  assert.equal(Object.hasOwn(result, "nextCursor"), false);
});

test("cursor coercion and offsets beyond the catalog retain empty final pages", async () => {
  const f = fixture(101, [{ surface_id: "last" }]);
  const initial = await f.page();
  for (const cursor of ["invalid", "-1", "0tail"]) {
    assert.equal((await f.page(cursor)).bytes, initial.bytes);
  }
  assert.equal(f.schemaReads(), 0);
  for (const cursor of ["102", "99999"]) {
    assert.deepEqual((await f.page(cursor)).result, { resources: [] });
  }
  assert.equal(f.schemaReads(), 2);
});
