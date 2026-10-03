import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { HttpSurfaceAdmissionSchema } from "../schemas-src/subnet-http-admission.ts";
import { SurfaceSchema } from "../schemas-src/routes/subnet-detail.ts";
import { AgentCatalogServiceSchema } from "../schemas-src/routes/agent-catalog.ts";
import { HowDoICallOutputSchema } from "../schemas-src/mcp-tools/ai-integration.ts";
import { handleMcpRequest, MCP_TOOLS } from "../src/mcp-server.ts";
import { matchReviewedHttpOperation } from "../src/subnet-http-admission.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const registrySurface = (file: string, id: string, netuid: number) => {
  const registry = JSON.parse(readFileSync(new URL(`../registry/subnets/${file}.json`, import.meta.url), "utf8"));
  return { ...registry.surfaces.find((surface: Row) => surface.id === id), netuid };
};
const taofi = registrySurface("swap", "sn-10-taofi-api", 10);
const gopher = registrySurface("gopher", "sn-42-gopher-ai-subnet-api", 42);
const body = {
  subnetInfo: { netuid: 10, hotkey: "0xacf34e305f1474e4817a66352af736fe6b0bcf5cdfeef18c441e24645c742339" },
  fromTokenInfo: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, amount: "18446744073709551615" },
};

function setup(rows: Row[] = [taofi, gopher], operational: Row[] = []) {
  const calls: { url: string; method?: string; body: unknown; headers: Headers }[] = [];
  const artifacts: string[] = [];
  const readArtifact = async (_env: unknown, path: string) => {
    artifacts.push(path);
    if (path === "/metagraph/operational-surfaces.json") return { ok: true, data: { surfaces: operational } };
    if (path === "/metagraph/surfaces.json") return { ok: true, data: { surfaces: rows } };
    if (path === "/metagraph/surface-aliases.json") return { ok: true, data: { aliases: [{ deprecated_id: "old-taofi", current_id: taofi.id, surface_key: "srf-taofi" }] } };
    if (path === "/metagraph/agent-catalog/10.json") return { ok: true, data: {
      netuid: 10, name: "TaoFi", slug: "swap", services: rows.map((surface) => ({
        surface_id: surface.id, kind: surface.kind, capability: surface.name,
        base_url: surface.url, auth_required: surface.auth_required, auth_schemes: [],
        http: surface.http, eligibility: { callable: false },
      })),
    } };
    return { ok: false, status: 404 };
  };
  const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).startsWith("https://cloudflare-dns.com/dns-query"))
        return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
      calls.push({ url: String(url), method: init?.method, body: init?.body, headers: new Headers(init?.headers) });
      return Response.json(String(url).includes("/result/") ? [{ ID: "fixture", Content: "exact result" }] : { uuid: "fixture-job", expectedAlphaAmount: "18446744073709551615" });
  };
  async function call(arguments_: Row, name = ["POST", "PUT", "PATCH", "DELETE"].includes(String(arguments_.method).toUpperCase()) ? "write_subnet_surface" : "call_subnet_surface") {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const response = await handleMcpRequest(new Request("https://metagraph.sh/mcp", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_ } }),
      }), mockEnv(), { readArtifact });
      return (await jsonBody(response)).result;
    } finally { globalThis.fetch = previousFetch; }
  }
  return { calls, artifacts, call, fetchImpl, readArtifact };
}

describe("source-reviewed HTTP operations independent of health probes", () => {
  test("both actual registry declarations validate through canonical and manifest schemas", () => {
    const manifest = JSON.parse(readFileSync(new URL("../schemas/subnet-manifest.schema.json", import.meta.url), "utf8"));
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile({ ...manifest.$defs.surface, $defs: manifest.$defs });
    for (const surface of [taofi, gopher]) {
      assert.equal(surface.probe.enabled, false);
      assert.equal(HttpSurfaceAdmissionSchema.safeParse(surface.http).success, true);
      assert.equal(SurfaceSchema.safeParse(surface).success, true);
      const { netuid: _netuid, ...declaration } = surface;
      assert.equal(validate(declaration), true, JSON.stringify(validate.errors));
      assert.equal(AgentCatalogServiceSchema.safeParse({ surface_id: surface.id, kind: surface.kind, base_url: surface.url, auth: surface.auth ?? null, http: surface.http }).success, true);
    }
    assert.equal(taofi.http.operations.length, 8);
    assert.deepEqual(gopher.http.operations.map((operation: Row) => `${operation.method} ${operation.path}`), ["POST /api/v1/search/live", "GET /api/v1/search/live/result/{uuid}"]);
  });

  for (const path of ["/getBuyQuote", "/getBuyCall", "/getSellQuote", "/getSellCall", "/getRefundCall", "/getBalance", "/getNativeTaoQuote", "/getNativeTaoCall"]) {
    test(`TaoFi ${path} executes the declared POST once with exact JSON bytes`, async () => {
      const fixture = setup();
      const result = await fixture.call({ surface_id: taofi.id, path, method: "POST", json_body: body });
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.body.expectedAlphaAmount, "18446744073709551615");
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.calls[0].url, new URL(path, taofi.url).href);
      assert.equal(fixture.calls[0].method, "POST");
      assert.equal(fixture.calls[0].body, JSON.stringify(body));
      assert.equal(fixture.calls[0].headers.get("content-type"), "application/json");
      assert.equal(fixture.calls[0].headers.has("authorization"), false);
      assert.equal(fixture.artifacts.some((artifact) => artifact.startsWith("/metagraph/schemas/")), false);
    });
  }

  test("Gopher submits and retrieves a job with caller auth, without implicit polling", async () => {
    const fixture = setup();
    const requestBody = { type: "twitter", arguments: { type: "searchbyquery", query: "bittensor", max_results: 10 } };
    const submitted = await fixture.call({ surface_id: gopher.id, path: "/api/v1/search/live", method: "POST", json_body: requestBody, credential: "Bearer fixture-caller" });
    assert.equal(submitted.isError, false);
    assert.equal(submitted.structuredContent.body.uuid, "fixture-job");
    assert.equal(fixture.calls.length, 1);
    const result = await fixture.call({ surface_id: gopher.id, path: "/api/v1/search/live/result/fixture-job", method: "GET", credential: "Bearer fixture-caller" });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent.body, [{ ID: "fixture", Content: "exact result" }]);
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[0].body, JSON.stringify(requestBody));
    assert.equal(fixture.calls[1].body, undefined);
    assert.deepEqual(fixture.calls.map((call) => call.headers.get("authorization")), ["Bearer fixture-caller", "Bearer fixture-caller"]);
    assert.equal(JSON.stringify(result).includes("fixture-caller"), false);
  });

  test("stable keys and deprecated aliases resolve to the surface's own id", async () => {
    const fixture = setup([{ ...taofi, key: "srf-taofi" }]);
    for (const surface_id of ["srf-taofi", "old-taofi"]) {
      const result = await fixture.call({ surface_id, path: "/getBuyQuote", method: "post", body });
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.surface_id, taofi.id);
    }
    assert.equal(fixture.calls.length, 2);
  });

  test("an admitted operational row uses the same reviewed permission gate", async () => {
    const fixture = setup([], [{ ...taofi, surface_id: taofi.id }]);
    const result = await fixture.call({ surface_id: taofi.id, path: "/getBuyQuote", method: "POST", json_body: body });
    assert.equal(result.isError, false);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.artifacts.includes("/metagraph/surfaces.json"), false);
  });

  for (const args of [
    {},
    { path: "/getBuyQuote", method: "GET" },
    { path: "/not-admitted", method: "POST", json_body: body },
    { path: "/getBuyQuote", method: "POST" },
    { path: "/getBuyQuote", method: "POST", body: "raw", content_type: "text/plain" },
    { path: "/getBuyQuote?extra=1", method: "POST", json_body: body },
    { path: "/getBuyQuote/../getBalance", method: "POST", json_body: body },
  ]) {
    test(`refuses unadmitted or incomplete calls before traffic: ${JSON.stringify(args)}`, async () => {
      const fixture = setup();
      const result = await fixture.call({ surface_id: taofi.id, ...args });
      assert.equal(result.isError, true);
      assert.equal(fixture.calls.length, 0);
    });
  }

  for (const path of ["/api/v1/search/live/result/a%2Fb", "/api/v1/search/live/result/a%5Cb", "/api/v1/search/live/result/", "/api/v1/search/live/result/a/extra"]) {
    test(`rejects an escaped or incomplete job identifier: ${path}`, async () => {
      const fixture = setup();
      const result = await fixture.call({ surface_id: gopher.id, path, method: "GET", credential: "Bearer fixture-caller" });
      assert.equal(result.isError, true);
      assert.equal(fixture.calls.length, 0);
    });
  }

  test("a credential is still required before any Gopher request", async () => {
    const fixture = setup();
    const result = await fixture.call({ surface_id: gopher.id, path: "/api/v1/search/live", method: "POST", json_body: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /auth_required/);
    assert.equal(fixture.calls.length, 0);
  });

  test("the read tool still refuses an admitted POST and names the write sibling", async () => {
    const fixture = setup();
    const result = await fixture.call({ surface_id: taofi.id, path: "/getBuyQuote", method: "POST" }, "call_subnet_surface");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /write_subnet_surface/);
    assert.equal(fixture.calls.length, 0);
  });

  test("HTTP credential registration resolves the canonical key and preserves account isolation", async () => {
    const fixture = setup([{ ...gopher, key: "srf-gopher12345678" }]);
    const values = new Map<string, string>();
    const env = mockEnv({
      MCP_SURFACE_CREDENTIAL_SECRET: "fixture-encryption-key",
      METAGRAPH_CONTROL: {
        get: async (key: string) => values.has(key) ? JSON.parse(values.get(key)!) : null,
        put: async (key: string, value: string) => { values.set(key, value); },
      },
    });
    type Ctx = Parameters<(typeof MCP_TOOLS)[number]["handler"]>[1];
    const ctx = { env, accountId: "7", readArtifact: fixture.readArtifact } as unknown as Ctx;
    const store = MCP_TOOLS.find((tool) => tool.name === "store_surface_credential")!;
    const write = MCP_TOOLS.find((tool) => tool.name === "write_subnet_surface")!;
    const registered = await store.handler({ surface_id: "srf-gopher12345678", credential: "Bearer stored-fixture" }, ctx) as Row;
    assert.equal(registered.surface_id, gopher.id);
    assert.equal(fixture.calls.length, 0);
    const args = { surface_id: gopher.id, path: "/api/v1/search/live", method: "POST", json_body: { type: "twitter", arguments: { type: "searchbyquery", query: "bittensor" } } };
    const previous = globalThis.fetch;
    globalThis.fetch = fixture.fetchImpl;
    try {
      await write.handler(args, ctx);
      assert.equal(fixture.calls[0].headers.get("authorization"), "Bearer stored-fixture");
      await write.handler({ ...args, credential: "Bearer explicit-fixture" }, ctx);
      assert.equal(fixture.calls[1].headers.get("authorization"), "Bearer explicit-fixture");
      await assert.rejects(write.handler(args, { ...ctx, accountId: "8" }), (error: Row) => error.code === "auth_required");
      assert.equal(fixture.calls.length, 2);
    } finally { globalThis.fetch = previous; }
  });

  test("an unreviewed disabled surface stays blocked", async () => {
    const { http: _http, ...unreviewed } = taofi;
    for (const operational of [[], [{ ...unreviewed, surface_id: taofi.id }]]) {
      const fixture = setup([unreviewed], operational);
      const result = await fixture.call({ surface_id: taofi.id, path: "/getBuyQuote", method: "POST", json_body: body });
      assert.equal(result.isError, true);
      assert.equal(fixture.calls.length, 0);
    }
  });

  for (const override of [{ public_safe: false }, { kind: "docs" }, { http: { operations: [] } }, { http: { operations: [{ method: "POST", path: "/getBuyQuote", request_body_required: true }] } }]) {
    test(`invalid registry admission never grants traffic: ${JSON.stringify(override)}`, async () => {
      const fixture = setup([{ ...taofi, ...override }]);
      const result = await fixture.call({ surface_id: taofi.id, path: "/getBuyQuote", method: "POST", json_body: body });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /invalid_registry/);
      assert.equal(fixture.calls.length, 0);
    });
  }

  test("required-body and duplicate-operation metadata are rejected", () => {
    assert.equal(HttpSurfaceAdmissionSchema.safeParse({ operations: [taofi.http.operations[0], taofi.http.operations[0]] }).success, false);
    assert.equal(HttpSurfaceAdmissionSchema.safeParse({ operations: [{ method: "POST", path: "/a", request_body_required: true }] }).success, false);
    const admission = HttpSurfaceAdmissionSchema.parse({ operations: [{ method: "POST", path: "/optional", request_content_types: ["application/json"], request_body_required: false }] });
    assert.deepEqual(matchReviewedHttpOperation(admission, "/optional", "POST")?.operation.requestBody, { required: false, content: { "application/json": {} } });
  });

  test("how_do_i_call exposes exact operations and suppresses misleading GET snippets", async () => {
    const fixture = setup([taofi]);
    const result = await fixture.call({ netuid: 10 }, "how_do_i_call");
    assert.equal(result.isError, false);
    const guide = HowDoICallOutputSchema.parse(result.structuredContent);
    assert.deepEqual(guide.services[0].http, taofi.http);
    assert.equal(guide.services[0].snippets, null);
    assert.ok(guide.services[0].http_execution?.includes("call_subnet_surface"));
    assert.ok(guide.next_steps?.includes(guide.services[0].http_execution!));
    assert.equal(fixture.calls.length, 0);
  });
});
