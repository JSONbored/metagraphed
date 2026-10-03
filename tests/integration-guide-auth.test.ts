import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, test, vi } from "vitest";
import { AuthSchema } from "../schemas-src/routes/subnet-detail.ts";
import { HowDoICallOutputSchema } from "../schemas-src/mcp-tools/ai-integration.ts";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const http = {
  operations: [
    {
      method: "POST",
      path: "/detect",
      request_content_types: ["application/json"],
    },
  ],
};
const mcp = {
  transport: "streamable-http",
  read_tools: ["detect"],
  write_tools: [],
};
const authCases = [
  { scheme: "none" },
  {
    scheme: "bearer",
    location: "header",
    name: "Authorization",
    value_format: "Bearer <token>",
    scopes_note: "Caller-scoped provider token.",
  },
  {
    scheme: "api-key",
    location: "query",
    name: "api_key",
    value_format: "<api-key>",
  },
  {
    scheme: "basic",
    location: "header",
    name: "Authorization",
    value_format: "Basic <base64(user:pass)>",
  },
  {
    scheme: "oauth2",
    location: "header",
    name: "Authorization",
    value_format: "Bearer <token>",
    token_url: "https://provider.example/oauth/token",
  },
  {
    scheme: "signature",
    location: "body",
    names: ["hotkey", "nonce", "signature"],
    body_envelope: { credential_key: "auth", payload_key: "payload" },
    scopes_note: "Caller signs each request.",
  },
  {
    scheme: "custom",
    location: "cookie",
    name: "session",
    value_format: "<session>",
  },
] as const;

function service(
  auth: unknown,
  admission: Row = { http },
  overrides: Row = {},
) {
  return {
    surface_id: "sn-34-fixture",
    kind: "subnet-api",
    capability: "Detection",
    method: "POST",
    base_url: "https://provider.example/detect",
    auth_required: true,
    auth_schemes: ["http"],
    auth,
    eligibility: { callable: false },
    ...admission,
    ...overrides,
  };
}

async function guide(services: Row[]) {
  const artifacts: string[] = [];
  const kvReads: string[] = [];
  let networkRequests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    networkRequests++;
    throw new Error(
      "No provider, DNS, schema or production requests in this fixture",
    );
  };
  try {
    const response = await handleMcpRequest(
      new Request("https://metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "how_do_i_call", arguments: { netuid: 34 } },
        }),
      }),
      mockEnv({
        METAGRAPH_VALIDATE_RESPONSES: "true",
        MCP_SURFACE_CREDENTIAL_SECRET: "fixture-secret",
        METAGRAPH_CONTROL: {
          async get(key: string) {
            kvReads.push(key);
            return null;
          },
        },
      }),
      {
        readArtifact: async (_env: unknown, path: string) => {
          artifacts.push(path);
          assert.equal(path, "/metagraph/agent-catalog/34.json");
          return {
            ok: true,
            data: { netuid: 34, name: "Fixture", slug: "fixture", services },
          };
        },
      },
    );
    assert.equal(response.status, 200);
    const result = (await jsonBody(response)).result;
    assert.equal(result.isError, false, result.content?.[0]?.text);
    const output = HowDoICallOutputSchema.parse(result.structuredContent);
    assert.deepEqual(artifacts, ["/metagraph/agent-catalog/34.json"]);
    assert.deepEqual(kvReads, []);
    assert.equal(networkRequests, 0);
    return output;
  } finally {
    globalThis.fetch = original;
  }
}

describe("Reviewed integration guide public auth detail", () => {
  for (const [protocol, admission] of [
    ["HTTP", { http }],
    ["MCP", { mcp }],
  ] as const) {
    for (const auth of authCases) {
      test(`${protocol} preserves canonical ${auth.scheme} instructions without a second read`, async () => {
        const output = await guide([service(auth, admission)]);
        assert.deepEqual(output.services[0]!.auth, {
          required: true,
          schemes: ["http"],
          detail: auth,
        });
        assert.equal(output.services[0]!.snippets, null);
        assert.equal(
          AuthSchema.safeParse(output.services[0]!.auth.detail).success,
          true,
        );
        assert.ok(
          output.services[0]![
            protocol === "HTTP" ? "http_execution" : "mcp_discovery"
          ],
        );
      });
    }
  }
  for (const [label, auth] of [
    ["missing", undefined],
    ["null", null],
    ["string", "Bearer fixture-private-key"],
    ["unknown scheme", { scheme: "unknown" }],
    ["unknown location", { scheme: "bearer", location: "secret-store" }],
    [
      "invalid header name shape",
      { scheme: "bearer", name: { value: "Authorization" } },
    ],
    ["empty header set", { scheme: "signature", names: [] }],
    [
      "invalid body envelope",
      {
        scheme: "signature",
        body_envelope: { credential_key: "", payload_key: "payload" },
      },
    ],
    [
      "extra credential field",
      { scheme: "bearer", credential: "fixture-private-key" },
    ],
  ] as const)
    test(`${label} descriptor is omitted and does not leak private fields`, async () => {
      const output = await guide([
        service(auth, { http }),
        service(auth, { mcp }, { surface_id: "sn-34-fixture-mcp" }),
      ]);
      for (const row of output.services)
        assert.deepEqual(row.auth, { required: true, schemes: ["http"] });
      assert.equal(
        JSON.stringify(output).includes("fixture-private-key"),
        false,
      );
    });
  test("legacy and malformed-admission guides keep exact auth bytes and skip descriptor parsing", async () => {
    const auth = authCases[1];
    const parser = vi.spyOn(AuthSchema, "safeParse");
    try {
      const output = await guide([
        service(
          auth,
          {},
          {
            method: "GET",
            eligibility: { callable: true },
            auth_schemes: ["apiKey"],
          },
        ),
        service(
          auth,
          {
            http: { operations: [{ method: "DROP", path: "/" }] },
            mcp: { transport: "unknown" },
          },
          { surface_id: "sn-34-invalid" },
        ),
      ]);
      assert.equal(output.services.length, 1);
      assert.equal(
        JSON.stringify(output.services[0]!.auth),
        '{"required":true,"schemes":["apiKey"]}',
      );
      assert.equal(parser.mock.calls.length, 0);
      // With no callable legacy service, malformed records are still returned.
      const cold = await guide([service(auth, { http: {}, mcp: {} })]);
      assert.equal(
        JSON.stringify(cold.services[0]!.auth),
        '{"required":true,"schemes":["http"]}',
      );
      assert.equal(parser.mock.calls.length, 0);
    } finally {
      parser.mockRestore();
    }
  });
  test("a doubly admitted descriptor is parsed once, preserves optional auth and has independent results", async () => {
    const auth = { ...authCases[1] };
    const rows = [
      service(auth, { http, mcp }, { auth_required: false }),
      service(auth, { http, mcp }, { surface_id: "sn-34-second" }),
    ];
    const parser = vi.spyOn(AuthSchema, "safeParse");
    try {
      const output = await guide(rows);
      assert.equal(parser.mock.calls.length, 2);
      assert.equal(output.services[0]!.auth.required, false);
      assert.deepEqual(output.services[1]!.auth.detail, auth);
      output.services[0]!.auth.detail!.value_format = "changed";
      assert.equal(
        output.services[1]!.auth.detail!.value_format,
        "Bearer <token>",
      );
      assert.equal(auth.value_format, "Bearer <token>");
      console.log(
        "INTEGRATION_GUIDE_AUTH_FIXTURE",
        JSON.stringify({
          reviewed_services: 2,
          auth_descriptor_parses: 2,
          catalog_reads: 1,
          private_kv_reads: 0,
          provider_schema_requests: 0,
          production_requests: 0,
        }),
      );
    } finally {
      parser.mockRestore();
    }
  });
  test("the published MCP output schema reuses canonical auth validation", async () => {
    const output = await guide([service(authCases[4])]);
    const definition = listToolDefinitions().find(
      (row) => row.name === "how_do_i_call",
    )!;
    assert.ok(definition.outputSchema);
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(definition.outputSchema);
    assert.equal(validate(output), true, JSON.stringify(validate.errors));
    for (const invalid of [
      { scheme: "unsupported" },
      { scheme: "bearer", credential: "fixture-private-key" },
      { scheme: "signature", names: [] },
    ]) {
      const changed = structuredClone(output) as Row;
      changed.services[0].auth.detail = invalid;
      assert.equal(validate(changed), false);
      assert.equal(HowDoICallOutputSchema.safeParse(changed).success, false);
    }
  });
});
