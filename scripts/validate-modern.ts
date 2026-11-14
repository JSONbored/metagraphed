import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { addAjvFormats } from "./lib/ajv-formats.ts";
import {
  loadModernPostgresFixture,
  loadModernServingFixture,
} from "./lib/modern-postgres-fixture.ts";
import {
  MODERN_FIXTURE as fixture,
  MODERN_REGISTERED_NETUIDS,
  modernVerificationFixture,
  type ModernVerificationFault,
} from "./lib/modern-verification-fixture.ts";

type ApplicationFactory =
  typeof import("../src/modern-application.ts").createModernApplication;
type Application = ReturnType<ApplicationFactory>;
type Row = Record<string, unknown>;

function object(value: unknown): Row {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Row;
}
function objects(value: unknown): Row[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}
function hash(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

const cases = {
  get_chain_head: {
    args: { network: "finney" },
    rest: "/api/v2/networks/finney/head",
  },
  list_blocks: {
    args: { network: "finney", limit: 2 },
    rest: "/api/v2/networks/finney/blocks?limit=2",
  },
  get_block: {
    args: {
      network: "finney",
      height: "123",
      block_hash: fixture.blockHash,
      publication_id: fixture.publication,
      limit: 1,
      extrinsic_limit: 1,
    },
    rest: `/api/v2/networks/finney/blocks/123?block_hash=${fixture.blockHash}&publication_id=${fixture.publication}&limit=1&extrinsic_limit=1`,
  },
  list_account_events: {
    args: { network: "finney", account_id: `0x${"a".repeat(64)}`, limit: 2 },
    rest: `/api/v2/networks/finney/accounts/0x${"a".repeat(64)}/events?limit=2`,
  },
  list_account_stake: {
    args: { network: "finney", account_id: `0x${"a".repeat(64)}`, limit: 2 },
    rest: `/api/v2/networks/finney/accounts/0x${"a".repeat(64)}/stake?limit=2`,
  },
  get_account_balance: {
    args: { network: "finney", account_id: `0x${"a".repeat(64)}` },
    rest: `/api/v2/networks/finney/accounts/0x${"a".repeat(64)}/balance`,
  },
  list_subnets: {
    args: { network: "finney", limit: 200 },
    rest: "/api/v2/networks/finney/subnets?limit=200",
  },
  get_subnet: {
    args: { network: "finney", netuid: 200 },
    rest: "/api/v2/networks/finney/subnets/200",
  },
  list_subnet_apis: {
    args: {
      network: "finney",
      netuid: 200,
      publication_id: fixture.ecosystemPublication,
      catalog_id: fixture.catalog,
    },
    rest: `/api/v2/networks/finney/subnets/200/services?publication_id=${fixture.ecosystemPublication}&catalog_id=${fixture.catalog}`,
  },
  get_api_schema: {
    args: {
      network: "finney",
      netuid: 200,
      service_id: "inference",
      publication_id: fixture.ecosystemPublication,
      catalog_id: fixture.catalog,
    },
    rest: `/api/v2/networks/finney/subnets/200/services/inference/schema?publication_id=${fixture.ecosystemPublication}&catalog_id=${fixture.catalog}`,
  },
  how_do_i_call: {
    args: {
      network: "finney",
      netuid: 200,
      publication_id: fixture.ecosystemPublication,
      catalog_id: fixture.catalog,
    },
    rest: `/api/v2/networks/finney/subnets/200/instructions?publication_id=${fixture.ecosystemPublication}&catalog_id=${fixture.catalog}`,
  },
  find_subnet_for_task: {
    args: {
      network: "finney",
      task: "inference",
      limit: 5,
      publication_id: fixture.ecosystemPublication,
    },
    rest: `/api/v2/networks/finney/services/search?task=inference&limit=5&publication_id=${fixture.ecosystemPublication}`,
  },
} as const;

function post(path: string, body: unknown) {
  return new Request(fixture.origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}
const mcpSessions = new WeakMap<
  Application,
  { id: string; protocol: string; request: number }
>();
async function rpc(app: Application, method: string, params?: unknown) {
  const state = mcpSessions.get(app);
  assert.ok(
    method === "initialize" || state,
    "MCP calls require a negotiated session",
  );
  const requestId = state ? ++state.request : 1;
  const request = post("/mcp", {
    jsonrpc: "2.0",
    id: requestId,
    method,
    ...(params ? { params } : {}),
  });
  if (state) {
    request.headers.set("mcp-session-id", state.id);
    request.headers.set("mcp-protocol-version", state.protocol);
  }
  const response = await app.fetch(request);
  assert.equal(response.status, 200, `${method}: MCP transport status`);
  assert.ok(
    response.headers.get("content-type")?.startsWith("text/event-stream"),
    `${method}: actual Streamable HTTP response`,
  );
  const text = await response.text();
  assert.ok(
    Buffer.byteLength(text) <= 1049600,
    `${method}: bounded MCP response including SSE framing`,
  );
  const frames = text.split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    return data ? [object(JSON.parse(data))] : [];
  });
  assert.equal(frames.length, 1, `${method}: one completed MCP response`);
  const envelope = frames[0];
  assert.equal(envelope.jsonrpc, "2.0");
  assert.equal(envelope.id, requestId);
  assert.ok(!envelope.error, `${method}: JSON-RPC error`);
  const result = object(envelope.result);
  if (method === "initialize") {
    const id = response.headers.get("mcp-session-id");
    assert.ok(id, "MCP initialization must issue a session");
    assert.equal(result.protocolVersion, "2025-11-25");
    mcpSessions.set(app, {
      id,
      protocol: result.protocolVersion,
      request: requestId,
    });
    const notification = post("/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    notification.headers.set("mcp-session-id", id);
    notification.headers.set("mcp-protocol-version", result.protocolVersion);
    assert.equal(
      (await app.fetch(notification)).status,
      202,
      "MCP initialization acknowledgement",
    );
  }
  return result;
}
async function closeMcpSession(app: Application) {
  const state = mcpSessions.get(app);
  if (!state) return;
  const response = await app.fetch(
    new Request(fixture.origin + "/mcp", {
      method: "DELETE",
      headers: {
        "mcp-session-id": state.id,
        "mcp-protocol-version": state.protocol,
      },
    }),
  );
  assert.equal(response.status, 200, "MCP session termination");
  mcpSessions.delete(app);
}
async function responseJson(response: Response, status = 200) {
  assert.equal(response.status, status);
  return object(await response.json());
}

async function boundedPackageFile(name: string, maximum: number) {
  const file = await open(
    new URL(`../dist/modern/${name}`, import.meta.url),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    assert.ok(before.isFile() && before.nlink === 1);
    assert.ok(before.size > 0 && before.size <= maximum);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const next = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    const after = await file.stat();
    assert.equal(length, before.size);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ctimeMs, before.ctimeMs);
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function applicationFactory(
  packaged: boolean,
): Promise<ApplicationFactory> {
  if (!packaged)
    return (await import("../src/modern-application.ts"))
      .createModernApplication;
  const postgresFixture = await loadModernPostgresFixture();
  const postgresServingFixture = await loadModernServingFixture();
  assert.equal(
    postgresServingFixture.baselineFixtureSha256,
    postgresFixture.manifestSha256,
    "Serving fixture does not bind the loaded PostgreSQL baseline",
  );
  const names = [
    "application.mjs",
    "auth-server.mjs",
    "operations.json",
    "schema.graphql",
    "server.mjs",
  ] as const;
  const exports = [
    "createModernApplication",
    "createV2Operations",
    "executeV2Operation",
    "validatePublicRegistrySource",
  ];
  const manifest = z
    .object({
      format: z.literal("metagraphed.application.v1"),
      schema_contract: z.literal(1),
      node_major: z.literal(26),
      source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      postgres_fixture_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      postgres_serving_fixture_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      exports: z
        .object({ "application.mjs": z.array(z.string()).length(4) })
        .strict(),
      files: z
        .array(
          z
            .object({
              path: z.enum(names),
              size_bytes: z
                .int()
                .min(1)
                .max(32 * 1024 * 1024),
              sha256: z.string().regex(/^[0-9a-f]{64}$/),
            })
            .strict(),
        )
        .length(5),
    })
    .strict()
    .parse(
      JSON.parse(
        (await boundedPackageFile("manifest.json", 65536)).toString("utf8"),
      ),
    );
  assert.equal(
    manifest.postgres_fixture_sha256,
    postgresFixture.manifestSha256,
    "Package conformance fixture differs from the validated public projection",
  );
  assert.equal(
    manifest.postgres_serving_fixture_sha256,
    postgresServingFixture.manifestSha256,
    "Package serving fixture differs from the validated public read contract",
  );
  assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), names);
  assert.deepEqual(manifest.exports["application.mjs"], exports);
  assert.ok(
    manifest.files.reduce((total, entry) => total + entry.size_bytes, 0) <=
      128 * 1024 * 1024,
  );
  for (const entry of manifest.files) {
    const bytes = await boundedPackageFile(entry.path, 32 * 1024 * 1024);
    assert.equal(bytes.length, entry.size_bytes);
    assert.equal(
      hash(bytes),
      entry.sha256,
      `${entry.path}: package manifest digest`,
    );
  }
  // Fixed local artifact only, after its complete file/export manifest passed.
  // The build's source SHA is retained provenance, not a runtime/source proof.
  const bundle = await import(
    new URL("../dist/modern/application.mjs", import.meta.url).href
  );
  assert.deepEqual(Object.keys(bundle).sort(), exports);
  for (const name of exports) assert.equal(typeof bundle[name], "function");
  // Execute the actual installed validator, independently of the source import.
  // This is retained controlled content, never current publication authority.
  const registry = {
    format: "metagraphed.registry-source.v1",
    profile: "controlled-package-root",
    source: {
      kind: "controlled-fixture",
      revision: "a".repeat(40),
      origin_verified: false,
      reviewed_at: fixture.now,
      expires_at: new Date(Date.parse(fixture.now) + 3_600_000).toISOString(),
    },
    network: { id: "finney", genesis_hash: `0x${"1".repeat(64)}` },
    catalogs: [
      {
        generation: { netuid: 0, registration_counter: "0" },
        registered_at_block: "0",
        observed_at: fixture.now,
        expires_at: new Date(Date.parse(fixture.now) + 3_600_000).toISOString(),
        services: [],
      },
    ],
    files: [],
  };
  const registryBytes = Buffer.from(JSON.stringify(registry));
  const registryResult = bundle.validatePublicRegistrySource(
    registryBytes,
    new Map(),
    new Date(fixture.now),
  );
  assert.equal(registryResult.manifest_sha256, hash(registryBytes));
  assert.deepEqual(registryResult.manifest, registry);
  assert.equal(registryResult.asset_bytes, 0);
  assert.equal(registryResult.definitions.size, 0);
  assert.equal(registryResult.documents.size, 0);
  assert.throws(() =>
    bundle.validatePublicRegistrySource(
      Buffer.from([0xff]),
      new Map(),
      new Date(fixture.now),
    ),
  );
  assert.throws(() =>
    bundle.validatePublicRegistrySource(
      Buffer.from(
        JSON.stringify({
          ...registry,
          source: { ...registry.source, origin_verified: true },
        }),
      ),
      new Map(),
      new Date(fixture.now),
    ),
  );
  return bundle.createModernApplication as ApplicationFactory;
}

async function verify(create: ApplicationFactory) {
  const database = modernVerificationFixture();
  const app = create(database.executor, {
    origin: fixture.origin,
    now: () => new Date(fixture.now),
    maxConcurrentRequests: 2,
    requestTimeoutMillis: 2000,
    // No invocation/identity binding: the catalog must not advertise those tools.
  });
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addAjvFormats(ajv);
  const covered = new Map<string, Row>();
  try {
    const initialized = await rpc(app, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "offline-modern-validator", version: "1" },
    });
    assert.deepEqual(initialized.serverInfo, {
      name: "metagraphed",
      version: "2.0.0",
    });
    const catalog = await rpc(app, "tools/list");
    const tools = z
      .array(
        z
          .object({
            name: z.string(),
            inputSchema: z.record(z.string(), z.unknown()),
            outputSchema: z.record(z.string(), z.unknown()),
          })
          .passthrough(),
      )
      .parse(catalog.tools);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      Object.keys(cases).sort(),
    );
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    for (const name of [
      "prepare_service_invocation",
      "approve_service_invocation",
      "invoke_service",
      "call_subnet_surface",
      "get_fixture",
      "get_adapter",
    ])
      assert.ok(
        !tools.some((tool) => tool.name === name),
        `${name}: no configured modern owner`,
      );

    for (const tool of tools) {
      assert.ok(
        Object.hasOwn(cases, tool.name),
        `${tool.name}: missing controlled journey`,
      );
      const selected = cases[tool.name as keyof typeof cases];
      const validateInput = ajv.compile(tool.inputSchema);
      const validateOutput = ajv.compile(tool.outputSchema);
      assert.ok(
        validateInput(selected.args),
        `${tool.name}: fixture arguments do not satisfy advertised input`,
      );
      const result = await rpc(app, "tools/call", {
        name: tool.name,
        arguments: selected.args,
      });
      assert.notEqual(
        result.isError,
        true,
        `${tool.name}: unexpected tool error`,
      );
      const payload = object(result.structuredContent);
      if ("publication_id" in selected.args) {
        assert.equal(
          object(
            tool.name === "get_block" ? payload.snapshot : payload.ecosystem,
          ).publication_id,
          selected.args.publication_id,
        );
      }
      if ("catalog_id" in selected.args) {
        assert.equal(
          object(payload.catalog).catalog_id,
          selected.args.catalog_id,
        );
      }
      assert.ok(
        validateOutput(payload),
        `${tool.name}: advertised outputSchema failure: ${JSON.stringify(validateOutput.errors)}`,
      );
      // Every advertised top-level collection is populated in this fixture.
      for (const [key, schema] of Object.entries(
        object(tool.outputSchema.properties),
      )) {
        if (object(schema).type === "array") {
          const collection = payload[key];
          assert.ok(
            Array.isArray(collection) && collection.length > 0,
            `${tool.name}.${key}: empty collection proves no row shape`,
          );
        }
      }
      assert.deepEqual(
        await responseJson(
          await app.fetch(new Request(fixture.origin + selected.rest)),
        ),
        payload,
        `${tool.name}: REST/MCP parity`,
      );
      covered.set(tool.name, payload);
    }
    assert.deepEqual(
      [...covered.keys()].sort(),
      tools.map((tool) => tool.name).sort(),
    );
    for (const name of [
      "find_subnet_for_task",
      "list_subnet_apis",
      "get_api_schema",
      "how_do_i_call",
    ] as const) {
      const selected = cases[name];
      const before = database.calls.length;
      await responseJson(
        await app.fetch(
          new Request(
            fixture.origin +
              selected.rest.replace(fixture.ecosystemPublication, "bad"),
          ),
        ),
        400,
      );
      assert.equal(
        database.calls.length,
        before,
        `${name}: invalid publication must precede database reads`,
      );
      const missing = await responseJson(
        await app.fetch(
          new Request(
            fixture.origin +
              selected.rest.replace(
                fixture.ecosystemPublication,
                "f".repeat(64),
              ),
          ),
        ),
        503,
      );
      assert.equal(object(missing.error).code, "data_unavailable");
      if (name !== "find_subnet_for_task") {
        const absent = await responseJson(
          await app.fetch(
            new Request(
              fixture.origin +
                selected.rest.replace(fixture.catalog, "e".repeat(64)),
            ),
          ),
          404,
        );
        assert.equal(object(absent.error).code, "not_found");
      }
    }
    assert.deepEqual(
      database.errors,
      [],
      "pin refusals must not be fixture failures",
    );

    const subnetRows = objects(covered.get("list_subnets")!.subnets);
    assert.deepEqual(
      subnetRows.map((row) => object(row.generation).netuid),
      MODERN_REGISTERED_NETUIDS,
    );
    assert.deepEqual(covered.get("list_subnets")!.coverage, {
      registry_complete: true,
      reportable_subnets: 130,
      operational_subnets: 130,
    });
    assert.equal(covered.get("list_subnets")!.next_after, null);
    for (const netuid of MODERN_REGISTERED_NETUIDS) {
      const result = await responseJson(
        await app.fetch(
          new Request(
            `${fixture.origin}/api/v2/networks/finney/subnets/${netuid}`,
          ),
        ),
      );
      assert.equal(object(object(result.subnet).generation).netuid, netuid);
      assert.equal(
        object(object(result.subnet).current_registration_block).value,
        netuid === 200 ? 42 : 0,
      );
    }
    const head = covered.get("get_chain_head")!;
    assert.deepEqual(head.coverage, {
      from_block: "120",
      through_block: "123",
      contiguous: true,
    });
    assert.equal(object(head.freshness).status, "current");
    const block = covered.get("get_block")!;
    const activity = covered.get("list_account_events")!;
    assert.equal(activity.account_id, `0x${"a".repeat(64)}`);
    assert.deepEqual(activity.coverage, head.coverage);
    assert.equal(activity.next_cursor, null);
    assert.deepEqual(
      objects(activity.events).map((row) => object(row.event).event_index),
      [0],
    );
    assert.deepEqual(
      objects(objects(activity.events)[0].matching_participants).map(
        (row) => row.participant_index,
      ),
      [0],
    );
    const listing = covered.get("list_blocks")!;
    assert.deepEqual(
      objects(listing.blocks).map((row) => object(row.snapshot).block_number),
      ["123", "122"],
    );
    assert.notEqual(
      object(objects(listing.blocks)[1].snapshot).publication_id,
      fixture.publication,
    );
    assert.equal(listing.next_before, "122");
    const older = await responseJson(
      await app.fetch(
        new Request(
          `${fixture.origin}/api/v2/networks/finney/blocks?anchor_height=123&anchor_hash=${fixture.blockHash}&anchor_publication_id=${fixture.publication}&from_block=120&before=122&limit=2`,
        ),
      ),
    );
    assert.deepEqual(
      objects(older.blocks).map((row) => object(row.snapshot).block_number),
      ["121", "120"],
    );
    assert.equal(older.next_before, null);
    const beforeExplorerRefusals = database.calls.length;
    for (const path of [
      "/api/v2/networks/finney/blocks?before=122",
      "/api/v2/networks/finney/blocks/123?after_event_index=0",
      `/api/v2/networks/finney/blocks/123?block_hash=${fixture.blockHash}`,
    ])
      await responseJson(
        await app.fetch(new Request(fixture.origin + path)),
        400,
      );
    assert.equal(database.calls.length, beforeExplorerRefusals);
    const replacedBlock = await responseJson(
      await app.fetch(
        new Request(
          `${fixture.origin}/api/v2/networks/finney/blocks/123?block_hash=${fixture.blockHash}&publication_id=${"f".repeat(64)}`,
        ),
      ),
      503,
    );
    assert.equal(object(replacedBlock.error).code, "data_unavailable");
    const replacedList = await responseJson(
      await app.fetch(
        new Request(
          `${fixture.origin}/api/v2/networks/finney/blocks?anchor_height=123&anchor_hash=${fixture.blockHash}&anchor_publication_id=${"f".repeat(64)}&from_block=120&before=122`,
        ),
      ),
      503,
    );
    assert.equal(object(replacedList.error).code, "data_unavailable");
    assert.deepEqual(database.errors, []);
    assert.equal(block.next_event_index, 0);
    const event = objects(block.events)[0];
    assert.equal(object(event.fields).amount_rao, "9007199254740993");
    assert.equal(objects(event.participants)[0].role, "sender");
    assert.equal(event.phase, "ApplyExtrinsic");
    assert.equal(event.extrinsic_index, 0);
    assert.deepEqual(event.topics, []);
    assert.equal(objects(block.extrinsics)[0].extrinsic_index, 0);
    assert.equal(
      object(objects(block.extrinsics)[0].fields).amount_rao,
      "9007199254740993",
    );
    assert.equal(block.source_capture_digest, "7".repeat(64));
    const next = await responseJson(
      await app.fetch(
        new Request(
          `${fixture.origin}/api/v2/networks/finney/blocks/123?block_hash=${fixture.blockHash}&publication_id=${fixture.publication}&after_event_index=0&limit=1&extrinsic_limit=1`,
        ),
      ),
    );
    assert.equal(objects(next.events)[0].event_index, 1);
    assert.equal(next.next_event_index, null);
    assert.deepEqual(next.extrinsics, block.extrinsics);
    const schema = covered.get("get_api_schema")!;
    assert.equal(schema.document_json, fixture.schema);
    assert.equal(schema.digest, fixture.schemaDigest);
    assert.equal(schema.capture_id, fixture.capture);
    assert.equal(schema.remote_references, "prohibited");
    const services = objects(covered.get("list_subnet_apis")!.services);
    assert.equal(services.length, 1);
    assert.equal(services[0].schema_capture_id, fixture.capture);
    assert.equal(object(services[0].verification).operation_id, "status");
    assert.deepEqual(
      objects(services[0].operations).map((operation) => [
        operation.operation_id,
        operation.example_json,
      ]),
      [
        ["status", "{}"],
        ["infer", '{"prompt":"A controlled example"}'],
      ],
    );
    assert.deepEqual(
      objects(covered.get("how_do_i_call")!.instructions).map((instruction) => [
        object(instruction.operation).operation_id,
        instruction.authorization_required,
        instruction.automatic_verification_allowed,
      ]),
      [
        ["status", false, true],
        ["infer", true, false],
      ],
    );
    const discovery = covered.get("find_subnet_for_task")!;
    assert.deepEqual(discovery.coverage, {
      reportable_subnets: 130,
      operational_subnets: 130,
      observed_subnets: 1,
      complete_subnets: 1,
      subnets_with_services: 1,
    });
    assert.equal(
      object(object(objects(discovery.results)[0].subnet).generation)
        .registration_counter,
      fixture.registrationCounter,
    );

    const graph = await responseJson(
      await app.fetch(
        post("/api/v2/graphql", {
          query: `{ get_chain_head(input:{network:"finney"}) { coverage { from_block through_block contiguous } }
        get_block(input:{network:"finney",height:"123",block_hash:"${fixture.blockHash}",publication_id:"${fixture.publication}",limit:1,extrinsic_limit:1}) { source_capture_digest events { event_index fields phase extrinsic_index topics participants { participant_index account_id role } } extrinsics { extrinsic_index fields is_signed signer } }
        get_api_schema(input:{network:"finney",netuid:200,service_id:"inference",publication_id:"${fixture.ecosystemPublication}",catalog_id:"${fixture.catalog}"}) { capture_id digest document_json remote_references }
        how_do_i_call(input:{network:"finney",netuid:200,publication_id:"${fixture.ecosystemPublication}",catalog_id:"${fixture.catalog}"}) { instructions { authorization_required automatic_verification_allowed operation { operation_id example_json } } } }`,
        }),
      ),
    );
    assert.equal(graph.errors, undefined);
    const data = object(graph.data);
    assert.deepEqual(object(data.get_chain_head).coverage, head.coverage);
    const listingGraph = await responseJson(
      await app.fetch(
        post("/api/v2/graphql", {
          query: `{ list_blocks(input:{network:"finney",limit:2}) { next_before blocks { snapshot { block_number publication_id } } } }`,
        }),
      ),
    );
    assert.equal(listingGraph.errors, undefined);
    assert.deepEqual(object(listingGraph.data).list_blocks, {
      next_before: listing.next_before,
      blocks: objects(listing.blocks).map((row) => ({
        snapshot: {
          block_number: object(row.snapshot).block_number,
          publication_id: object(row.snapshot).publication_id,
        },
      })),
    });
    assert.deepEqual(data.get_block, {
      source_capture_digest: block.source_capture_digest,
      events: objects(block.events).map((row) => ({
        event_index: row.event_index,
        fields: row.fields,
        phase: row.phase,
        extrinsic_index: row.extrinsic_index,
        topics: row.topics,
        participants: row.participants,
      })),
      extrinsics: objects(block.extrinsics).map((row) => ({
        extrinsic_index: row.extrinsic_index,
        fields: row.fields,
        is_signed: row.is_signed,
        signer: row.signer,
      })),
    });
    assert.deepEqual(data.get_api_schema, {
      capture_id: schema.capture_id,
      digest: schema.digest,
      document_json: schema.document_json,
      remote_references: schema.remote_references,
    });
    assert.deepEqual(
      object(data.how_do_i_call).instructions,
      objects(covered.get("how_do_i_call")!.instructions).map(
        (instruction) => ({
          authorization_required: instruction.authorization_required,
          automatic_verification_allowed:
            instruction.automatic_verification_allowed,
          operation: {
            operation_id: object(instruction.operation).operation_id,
            example_json: object(instruction.operation).example_json,
          },
        }),
      ),
    );

    const before = database.calls.length;
    for (const path of [
      "/api/v1/fixtures/7:subnet-api:new_v2",
      "/metagraph/schemas/7:openapi:old.json",
    ])
      await responseJson(
        await app.fetch(new Request(fixture.origin + path)),
        404,
      );
    const oldArguments = await rpc(app, "tools/call", {
      name: "get_api_schema",
      arguments: { surface_id: "7:openapi:old" },
    });
    assert.equal(oldArguments.isError, true);
    await responseJson(
      await app.fetch(
        new Request("https://untrusted.example/api/v2/networks/finney/head"),
      ),
      403,
    );
    await responseJson(
      await app.fetch(
        new Request(`${fixture.origin}/api/v2/networks/finney/subnets/0200`),
      ),
      400,
    );
    assert.equal(
      database.calls.length,
      before,
      "Rejected routes/arguments must not read database rows",
    );
    assert.deepEqual(
      database.errors,
      [],
      "A fixture dispatch failure is never evidence of an application refusal",
    );
    return tools.length;
  } finally {
    try {
      await closeMcpSession(app);
    } finally {
      await app.close();
    }
  }
}

async function verifyRefusals(create: ApplicationFactory) {
  const faults: ModernVerificationFault[] = [
    "old_registration",
    "catalog_identity",
    "schema_digest",
    "remote_reference",
    "unsafe_example",
    "registry_coverage",
  ];
  for (const fault of faults) {
    const database = modernVerificationFixture(fault);
    const app = create(database.executor, {
      origin: fixture.origin,
      now: () => new Date(fixture.now),
    });
    try {
      if (fault === "old_registration") {
        const unavailable = await responseJson(
          await app.fetch(
            new Request(
              fixture.origin + "/api/v2/networks/finney/subnets/200/services",
            ),
          ),
        );
        assert.equal(object(unavailable.catalog).status, "unobserved");
        assert.deepEqual(unavailable.services, []);
      }
      const route =
        fault === "registry_coverage"
          ? cases.list_subnets.rest
          : cases.get_api_schema.rest;
      const status = fault === "old_registration" ? 404 : 503;
      const code =
        fault === "old_registration" ? "not_found" : "data_unavailable";
      const result = await responseJson(
        await app.fetch(new Request(fixture.origin + route)),
        status,
      );
      assert.equal(object(result.error).code, code);
      assert.ok(!JSON.stringify(result).includes("not-a-placeholder"));
      if (fault === "schema_digest" || fault === "remote_reference")
        assert.ok(
          database.calls.some(
            (call) =>
              call.sql.includes("JOIN registry.schema_captures capture") &&
              call.sql.includes(
                "JOIN registry.schema_documents document ON document.digest=capture.digest",
              ),
          ),
          "Schema refusal must reach the controlled capture",
        );
      assert.deepEqual(
        database.errors,
        [],
        `${fault}: fixture failure cannot count as a safety refusal`,
      );
    } finally {
      await app.close();
    }
  }
}

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--packaged"),
  "Only the fixed --packaged mode is supported",
);
assert.equal(
  Number(process.versions.node.split(".")[0]),
  26,
  "Modern validation requires Node 26",
);
assert.equal(
  hash(fixture.schema),
  fixture.schemaDigest,
  "The independently recorded schema fixture digest changed",
);
assert.equal(
  hash('{"$ref":"https://external.example.com/schema.json"}'),
  "d95315080a032389446a3488b6f4a37f9e40f88cdfe03df51003874b77c9ea59",
);
const originalFetch = globalThis.fetch;
let outbound = 0;
globalThis.fetch = async () => {
  outbound++;
  throw new Error("Modern validation prohibits outbound fetch");
};
try {
  const create = await applicationFactory(args.length === 1);
  const tools = await verify(create);
  await verifyRefusals(create);
  assert.equal(
    outbound,
    0,
    "No source, provider, repository or RPC fetch may be attempted",
  );
  console.log(
    `Modern ${args.length ? "package" : "source"} contract verified: ${tools} advertised outputs, root/all 128/future registration, REST/MCP/GraphQL parity, identity and safety refusals; invocation deliberately unbound.`,
  );
} finally {
  globalThis.fetch = originalFetch;
}
