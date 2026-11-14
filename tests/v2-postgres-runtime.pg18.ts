import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { z } from "zod";
import { createV2ReadClient } from "../src/v2/client.ts";
import { createModernApplication } from "../src/modern-application.ts";
import {
  loadModernPostgresFixture,
  loadModernServingFixture,
} from "../scripts/lib/modern-postgres-fixture.ts";
import { canonicalSubnet } from "../scripts/lib/modern-ecosystem-fixture.ts";
import {
  modernAccountStakeRow,
  modernAccountBalanceRow,
} from "../scripts/lib/modern-verification-fixture.ts";
import { serviceDefinitionDigest } from "../src/v2/service-definition.ts";
import {
  V2BlockListSchema,
  V2BlockSchema,
  V2AccountEventsSchema,
  V2AccountStakeSchema,
  V2AccountBalanceSchema,
  V2HeadSchema,
  V2SubnetListSchema,
  V2SubnetResultSchema,
} from "../schemas-src/v2/contracts.ts";
import {
  V2CapturedServiceSchema,
  V2CallInstructionsSchema,
  V2ServiceDiscoverySchema,
  V2ServiceDefinitionSchema,
  V2SubnetServicesSchema,
} from "../schemas-src/v2/registry.ts";

const graphResponse = z
  .object({
    data: z.record(z.string(), z.unknown()).nullable().optional(),
    errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
  })
  .transform((value) => ({ ...value, data: value.data ?? {} }));
const errorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const origin = "https://example.test";
const at = "2026-11-05T14:00:00.000Z";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const oldPublication = "f".repeat(64);
const publication = "0".repeat(64);
const oldEcosystemPublication = digest("old-fixture-ecosystem");
const ecosystemPublication = digest("fixture-ecosystem");
const currentCounter = "9007199254740993";
const oldCounter = "9007199254740992";
const oldCatalog = "e".repeat(64);
const catalog = "1".repeat(64);
const capture = "2".repeat(64);
const directoryPublication = "7".repeat(64);
const newerDirectoryPublication = "8".repeat(64);
const directoryBlockPublication = digest("directory-block-publication");
const directoryNetuids = Array.from({ length: 406 }, (_, index) => index);
const schemaJson = JSON.stringify({
  openapi: "3.1.0",
  paths: { "/models": { get: { operationId: "models" } } },
  components: {
    schemas: {
      Amount: { type: "string" },
      Copy: { $ref: "#/components/schemas/Amount" },
    },
  },
});
const authentication = { required: false, schemes: [] };
const effects = {
  writes_state: false,
  billable: false,
  requires_credentials: false,
  unknown: false,
};
const operations = [
  {
    operation_id: "models",
    method: "GET",
    path: "/models",
    description: "Read models",
    effects,
    example_json: null,
  },
  {
    operation_id: "infer",
    method: "POST",
    path: "/infer",
    description: "Run inference",
    effects: { ...effects, billable: true },
    example_json: '{"prompt":"A public example"}',
  },
];
let admin: Client | undefined;
let reader: Client | undefined;
let servingPool: Pool | undefined;
let app: ReturnType<typeof createModernApplication> | undefined;
let mcpSession: string | undefined;
let mcpRequestId = 0;
const calls: { sql: string; values: unknown[] }[] = [];

function fixtureUrl(): URL {
  const supplied = process.env.METAGRAPHED_TEST_DATABASE_URL;
  assert.ok(
    supplied,
    "METAGRAPHED_TEST_DATABASE_URL must explicitly name an empty local test database",
  );
  let url: URL;
  try {
    url = new URL(supplied);
  } catch {
    throw new Error("Invalid local PostgreSQL fixture URL");
  }
  assert.ok(
    ["postgres:", "postgresql:"].includes(url.protocol),
    "PostgreSQL URL required",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Only a local fixture is permitted",
  );
  assert.match(
    url.pathname,
    /^\/metagraphed_test_[a-zA-Z0-9_]{1,80}$/,
    "Explicit test database name required",
  );
  assert.equal(url.search, "", "Connection overrides are not permitted");
  assert.equal(url.hash, "", "Connection fragments are not permitted");
  return url;
}

async function migrationArtifacts(): Promise<string[]> {
  const fixture = await loadModernPostgresFixture(
    process.env.METAGRAPHED_MODERN_MIGRATIONS_DIR,
  );
  const serving = await loadModernServingFixture();
  assert.equal(
    serving.baselineFixtureSha256,
    fixture.manifestSha256,
    "Serving fixture must bind the actual loaded baseline before connecting",
  );
  const result: string[] = [];
  for (const file of fixture.files) {
    const parts = file.bytes.toString("utf8").split("-- migrate:down");
    assert.equal(
      parts.length,
      2,
      "Migration artifact must separate up and down sections",
    );
    assert.ok(
      parts[0].startsWith("-- migrate:up"),
      "Migration up section required",
    );
    result.push(parts[0]);
  }
  result.push(serving.files[0]!.bytes.toString("utf8"));
  return result;
}

async function transaction(operation: (client: Client) => Promise<void>) {
  assert.ok(admin);
  await admin.query("BEGIN");
  try {
    await operation(admin);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function addSubnet(
  client: Client,
  id: string,
  network: string,
  netuid: number,
  counter: string,
  registrationBlock = 0,
  lifecycle: "started" | "dissolving" = "started",
  mechanismCount: number | null = netuid === 0 ? 1 : 2,
) {
  const subnet = canonicalSubnet({
    netuid,
    counter,
    registrationBlock,
    lifecycle,
    mechanismCount,
  });
  if (netuid === 0) {
    subnet.counter_source = "runtime_default";
    subnet.current_registration_block.source = "runtime_default";
    subnet.pricing_mode_code.source = "runtime_default";
    if (subnet.mechanism_count?.value === 1)
      subnet.mechanism_count.source = "runtime_default";
  }
  await client.query(
    `INSERT INTO registry.subnets
    (publication_id,network_id,netuid,current_registration_block,name,operational,registration_counter,
      counter_source,baseline_history_unqualified,lifecycle,registration_block_source,pricing_mode_code,
      pricing_mode_source,mechanism_count,mechanism_count_source,mechanism_availability,mechanisms)
    VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
    [
      id,
      network,
      netuid,
      registrationBlock,
      subnet.operational,
      counter,
      subnet.counter_source,
      subnet.baseline_history_unqualified,
      lifecycle,
      subnet.current_registration_block.source,
      subnet.pricing_mode_code.value,
      subnet.pricing_mode_code.source,
      subnet.mechanism_count?.value ?? null,
      subnet.mechanism_count?.source ?? null,
      subnet.mechanism_availability,
      JSON.stringify(subnet.mechanisms),
    ],
  );
}

async function addEcosystem(
  client: Client,
  id: string,
  network: string,
  blockPublication: string,
  netuids: number[],
  operational: number[],
  mechanismsComplete: boolean,
) {
  await client.query(
    `INSERT INTO ops.publications
    (publication_id,network_id,first_block,last_block,scope,stage,producer_revision,observed_at,
      registry_complete,registry_expected_netuids,published_at)
    VALUES($1,$2,123,123,'ecosystem','published',$3,$4,true,$5::integer[],$4)`,
    [id, network, "c".repeat(40), at, netuids],
  );
  await client.query(
    `INSERT INTO registry.fixture_ecosystem_admissions
    (publication_id,network_id,block_number,block_publication_id,source_id,candidate_id,snapshot_id,
      projection_contract,state_block_hash,state_metadata_digest,state_spec_version,state_transaction_version,
      state_producer_revision,profile_revision,upstream_revision,reportable_mechanisms_complete,
      operational_netuids,residual_storage_netuids,fixture_eligible)
    VALUES($1,$2,123,$3,$4,$5,$6,1,$7,$8,488,2,$9,'fixture-ecosystem-v1',$10,$11,$12::jsonb,$13::jsonb,true)`,
    [
      id,
      network,
      blockPublication,
      digest(`source-${id}`),
      digest(`candidate-${id}`),
      digest(`snapshot-${id}`),
      hash(123),
      digest("state-metadata"),
      "d".repeat(40),
      "e".repeat(40),
      mechanismsComplete,
      JSON.stringify(operational),
      JSON.stringify([4094]),
    ],
  );
}

async function addDefinition(client: Client, input: unknown) {
  const value = V2ServiceDefinitionSchema.parse(input);
  const identity = serviceDefinitionDigest(value);
  await client.query(
    `INSERT INTO registry.service_definitions
    (definition_id,encoding,name,description,kind,base_url,source_urls,authentication,operations)
    VALUES($1,'service-definition-v1',$2,$3,$4,$5,$6::text[],$7::jsonb,$8::jsonb)
    ON CONFLICT DO NOTHING`,
    [
      identity,
      value.name,
      value.description,
      value.kind,
      value.base_url,
      value.source_urls,
      JSON.stringify(value.authentication),
      JSON.stringify(value.operations),
    ],
  );
  return identity;
}

const serviceContent = (name: string) => ({
  name,
  description: "Image language inference",
  kind: "http",
  base_url: "https://api.example.com/v1",
  source_urls: ["https://example.com/docs"],
  authentication,
  operations,
});

async function addService(client: Client, id: string, name: string) {
  const definition = await addDefinition(client, serviceContent(name));
  await client.query(
    `INSERT INTO registry.service_versions
    (catalog_id,network_id,netuid,registered_at_block,registration_counter,service_id,definition_id,schema_capture_id,public_safe)
    VALUES($1,'fixture',200,40,$4,'inference',$2,$3,true)`,
    [
      id,
      definition,
      id === oldCatalog ? digest("old-capture") : capture,
      id === oldCatalog ? oldCounter : currentCounter,
    ],
  );
}

async function addDirectoryPublication(
  client: Client,
  id: string,
  netuids: number[],
  registration = 0,
  registrationCounter = "0",
) {
  if (id === directoryPublication) {
    await client.query(
      `INSERT INTO ops.publications
      (publication_id,network_id,first_block,last_block,scope,stage,producer_revision,observed_at,published_at)
      VALUES($1,'directory',123,123,'blocks','published',$2,$3,$3)`,
      [directoryBlockPublication, "a".repeat(40), at],
    );
    await client.query(
      `INSERT INTO chain.blocks
      (network_id,block_number,block_hash,parent_hash,metadata_digest,spec_version,transaction_version,
        raw_digest,producer_revision,observed_at,event_count,extrinsic_count,publication_id)
      VALUES('directory',123,$1,$2,$3,486,1,$4,$5,$6,0,0,$7)`,
      [
        hash(123),
        hash(122),
        digest("metadata"),
        digest("directory-raw"),
        "a".repeat(40),
        at,
        directoryBlockPublication,
      ],
    );
    await client.query(
      `INSERT INTO chain.block_publications VALUES($1,'directory',123)`,
      [directoryBlockPublication],
    );
    await client.query(
      `INSERT INTO ops.checkpoints VALUES('directory','blocks',123,123,$1,$2)`,
      [hash(123), directoryBlockPublication],
    );
  }
  await addEcosystem(
    client,
    id,
    "directory",
    directoryBlockPublication,
    netuids,
    netuids.filter((n) => n !== 4095),
    true,
  );
  for (const netuid of netuids)
    await addSubnet(
      client,
      id,
      "directory",
      netuid,
      netuid === 200
        ? registrationCounter
        : netuid === 4095
          ? "18446744073709551614"
          : "0",
      netuid === 200 ? registration : 0,
      netuid === 4095 ? "dissolving" : "started",
      netuid === 4095 ? 16 : netuid === 0 ? 1 : 2,
    );
}

async function seed(client: Client) {
  await client.query(
    `INSERT INTO chain.networks(network_id,genesis_hash,finalized_observed_height,finalized_observed_hash,finalized_observed_at)
    VALUES('fixture',$1,123,$2,$3)`,
    [hash(1), hash(123), at],
  );
  await client.query(
    `INSERT INTO chain.runtime_metadata VALUES('fixture',$1,'0x00')`,
    [digest("metadata")],
  );
  await client.query(
    `INSERT INTO chain.raw_objects(digest,kind,content_digest,stored_digest,object_key,byte_length,stored_byte_length,compression,integrity_verified)
    VALUES($1,'opaque',$1,$1,$2,3,3,'none',true)`,
    [digest("raw"), `${digest("raw")}.raw`],
  );
  for (const [id, revision] of [
    [oldPublication, "a".repeat(40)],
    [publication, "b".repeat(40)],
  ]) {
    await client.query(
      `INSERT INTO ops.publications
      (publication_id,network_id,first_block,last_block,scope,stage,producer_revision,observed_at,registry_complete,registry_expected_netuids,published_at)
      VALUES($1,'fixture',123,123,'blocks','published',$2,$3,false,NULL,$3)`,
      [id, revision, id === oldPublication ? "2026-11-05T13:59:48.000Z" : at],
    );
    if (id === oldPublication)
      await client.query(
        `INSERT INTO chain.blocks
      (network_id,block_number,block_hash,parent_hash,metadata_digest,spec_version,transaction_version,
       raw_digest,producer_revision,observed_at,event_count,extrinsic_count,publication_id)
      VALUES('fixture',123,$1,$2,$3,486,1,$4,$5,$6,0,0,$7)`,
        [
          hash(123),
          hash(122),
          digest("metadata"),
          digest("raw"),
          revision,
          "2026-11-05T13:59:48.000Z",
          id,
        ],
      );
    await client.query(
      `INSERT INTO chain.block_publications VALUES($1,'fixture',123)`,
      [id],
    );
  }
  await client.query(
    `UPDATE chain.blocks SET publication_id=$1,producer_revision=$2,observed_at=$3 WHERE network_id='fixture'`,
    [publication, "b".repeat(40), at],
  );
  await client.query(
    `INSERT INTO ops.checkpoints VALUES('fixture','blocks',123,123,$1,$2)`,
    [hash(123), publication],
  );
  await client.query(
    `INSERT INTO registry.schema_documents(digest,document_json) VALUES($1,$2)`,
    [digest(schemaJson), schemaJson],
  );
  for (const [id, counter] of [
    [oldEcosystemPublication, oldCounter],
    [ecosystemPublication, currentCounter],
  ]) {
    await addEcosystem(
      client,
      id,
      "fixture",
      oldPublication,
      [0, 128, 200],
      [0, 200],
      false,
    );
    await addSubnet(client, id, "fixture", 0, "0");
    await addSubnet(client, id, "fixture", 128, "0", 30, "dissolving", null);
    await addSubnet(client, id, "fixture", 200, counter, 40);
  }
  for (const [id, counter] of [
    [digest("old-capture"), oldCounter],
    [capture, currentCounter],
  ])
    await client.query(
      `INSERT INTO registry.schema_captures
      (capture_id,network_id,netuid,registered_at_block,registration_counter,service_id,digest,source_url,observed_at,public_safe)
      VALUES($1,'fixture',200,40,$2,'inference',$3,'https://example.com/openapi.json',$4,true)`,
      [id, counter, digest(schemaJson), at],
    );
  for (const id of [oldCatalog, catalog]) {
    await client.query(
      `INSERT INTO registry.service_catalogs
      (catalog_id,network_id,netuid,registered_at_block,registration_counter,chain_publication_id,observed_at,published_at,expires_at,producer_revision,expected_service_ids)
      VALUES($1,'fixture',200,40,$5,$2,$3,$3,$3::timestamptz+interval '1 day',$4,ARRAY['inference'])`,
      [
        id,
        id === catalog ? ecosystemPublication : oldEcosystemPublication,
        at,
        "c".repeat(40),
        id === catalog ? currentCounter : oldCounter,
      ],
    );
    await addService(
      client,
      id,
      id === catalog ? "Current image inference" : "Old image inference",
    );
  }
  for (const [id, status] of [
    ["f".repeat(64), "failed"],
    ["0".repeat(64), "verified"],
  ]) {
    await client.query(
      `INSERT INTO registry.service_verifications
      (verification_id,catalog_id,service_id,operation_id,status,observed_at,expires_at)
      VALUES($1,$2,'inference','models',$3,$4,$4::timestamptz+interval '1 day')`,
      [id, catalog, status, at],
    );
  }
}

function application() {
  assert.ok(app, "Native fixture was not initialized");
  return app;
}
function post(path: string, body: unknown) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}
async function tool<T extends z.ZodType>(
  name: string,
  args: unknown,
  output: T,
) {
  const response = await mcpRequest({
    jsonrpc: "2.0",
    id: ++mcpRequestId,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.equal(response.status, 200);
  return z
    .object({ result: z.object({ structuredContent: output }) })
    .parse(await response.json());
}
async function mcpResponse(response: Response) {
  assert.equal(response.status, 200);
  assert.ok(
    response.headers.get("content-type")?.startsWith("text/event-stream"),
  );
  const frames = (await response.text()).split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    return data ? [JSON.parse(data) as unknown] : [];
  });
  assert.equal(frames.length, 1);
  return frames[0];
}
async function mcpRequest(body: Record<string, unknown>) {
  if (!mcpSession) {
    const initial = await application().fetch(
      post("/mcp", {
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "postgres-fixture", version: "1" },
        },
      }),
    );
    const id = initial.headers.get("mcp-session-id");
    assert.ok(id, "MCP initialization must issue a session");
    await mcpResponse(initial);
    mcpSession = id;
    const initialized = post("/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    initialized.headers.set("mcp-session-id", id);
    initialized.headers.set("mcp-protocol-version", "2025-11-25");
    assert.equal((await application().fetch(initialized)).status, 202);
  }
  const request = post("/mcp", body);
  request.headers.set("mcp-session-id", mcpSession);
  request.headers.set("mcp-protocol-version", "2025-11-25");
  const response = await application().fetch(request);
  const value = await mcpResponse(response);
  assert.equal(
    z.object({ id: z.union([z.string(), z.number()]) }).parse(value).id,
    body.id,
  );
  return new Response(JSON.stringify(value), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

describe(
  "modern shared application against PostgreSQL 18",
  { concurrency: false },
  () => {
    before(async () => {
      // Validate both inputs before constructing or connecting any database client.
      const url = fixtureUrl();
      const migrations = await migrationArtifacts();
      admin = new Client({
        connectionString: url.toString(),
        connectionTimeoutMillis: 2000,
        statement_timeout: 5000,
        query_timeout: 6000,
        application_name: "metagraphed-test-admin",
      });
      await admin.connect();
      const identity = (
        await admin.query(`SELECT current_database() AS name,
      current_setting('server_version_num')::integer AS version,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS fixture_admin,
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema') AS objects,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname NOT LIKE 'pg_%'
        AND nspname NOT IN ('information_schema','public')) AS schemas`)
      ).rows[0];
      assert.equal(identity.name, url.pathname.slice(1));
      assert.ok(
        identity.version >= 180000 && identity.version < 190000,
        "PostgreSQL 18 fixture required",
      );
      assert.equal(
        identity.fixture_admin,
        true,
        "Disposable test administrator required",
      );
      assert.equal(
        identity.objects,
        0,
        "Database must contain no application objects",
      );
      assert.equal(
        identity.schemas,
        0,
        "Database must contain no application schemas",
      );
      await transaction(async (client) => {
        for (const migration of migrations) await client.query(migration);
        await seed(client);
      });
      reader = new Client({
        connectionString: url.toString(),
        connectionTimeoutMillis: 2000,
        statement_timeout: 5000,
        query_timeout: 6000,
        application_name: "metagraphed-test-serving",
      });
      await reader.connect();
      await reader.query("SET ROLE metagraphed_serve");
      assert.equal(
        (await reader.query("SELECT current_user AS name")).rows[0].name,
        "metagraphed_serve",
      );
      servingPool = new Pool({
        connectionString: url.toString(),
        max: 2,
        connectionTimeoutMillis: 2000,
        statement_timeout: 5000,
        query_timeout: 6000,
        application_name: "metagraphed-test-serving-pool",
      });
      const pool = servingPool;
      app = createModernApplication(
        {
          query: async (sql, values) => {
            const connection = await pool.connect();
            let qualified = false;
            try {
              // Qualify every borrowed connection before application SQL. Await
              // session authorization rather than racing an async connect event.
              await connection.query(
                "SET SESSION AUTHORIZATION metagraphed_serve",
              );
              assert.deepEqual(
                (
                  await connection.query(
                    "SELECT current_user AS name, session_user AS session_name",
                  )
                ).rows,
                [
                  {
                    name: "metagraphed_serve",
                    session_name: "metagraphed_serve",
                  },
                ],
              );
              qualified = true;
              calls.push({ sql, values });
              return await connection.query(sql, values);
            } finally {
              // Destroy a connection whose serving identity was not established.
              connection.release(!qualified);
            }
          },
        },
        { origin, now: () => new Date(at) },
      );
    });

    after(async () => {
      try {
        if (app && mcpSession) {
          const response = await app.fetch(
            new Request(origin + "/mcp", {
              method: "DELETE",
              headers: {
                "mcp-session-id": mcpSession,
                "mcp-protocol-version": "2025-11-25",
              },
            }),
          );
          assert.equal(response.status, 200);
        }
      } finally {
        await app?.close();
        await servingPool?.end();
        await reader?.end();
        await admin?.end();
      }
      // The caller owns the disposable database lifecycle and any failure evidence.
    });

    it("balance reads preserve exact observations and serving denials through PostgreSQL", async () => {
      assert.ok(admin);
      assert.ok(reader);
      const network = "balance-fixture",
        account = `0x${"a".repeat(64)}`,
        absent = `0x${"b".repeat(64)}`,
        unknown = `0x${"c".repeat(64)}`;
      const captured = digest("balance-execution-original"),
        replayed = digest("balance-execution-replay"),
        raw = digest("balance-controlled-raw");
      const primary = digest("balance-primary"),
        other = digest("balance-other-account"),
        latest = digest("balance-latest");
      const specimen = modernAccountBalanceRow(account);
      await transaction(async (connection) => {
        await connection.query(
          `INSERT INTO chain.networks(network_id,genesis_hash,finalized_observed_height,finalized_observed_hash,finalized_observed_at)
          VALUES($1,$2,123,$3,$4)`,
          [network, specimen.network.genesis_hash, hash(123), at],
        );
        await connection.query(
          "INSERT INTO chain.runtime_metadata VALUES($1,$2,'0x00')",
          [network, specimen.snapshot.metadata_digest],
        );
        await connection.query(
          `INSERT INTO chain.raw_objects(digest,kind,content_digest,stored_digest,object_key,byte_length,stored_byte_length,compression,integrity_verified)
          VALUES($1,'opaque',$1,$1,$2,3,3,'none',true)`,
          [raw, raw + ".raw"],
        );
        for (const [id, revision] of [
          [captured, "a".repeat(40)],
          [replayed, "b".repeat(40)],
        ]) {
          await connection.query(
            `INSERT INTO ops.publications(publication_id,network_id,first_block,last_block,scope,stage,producer_revision,observed_at,published_at)
            VALUES($1,$2,123,123,'blocks','published',$3,$4,$4)`,
            [id, network, revision, at],
          );
          if (id === captured)
            await connection.query(
              `INSERT INTO chain.blocks
            (network_id,block_number,block_hash,parent_hash,metadata_digest,spec_version,transaction_version,raw_digest,producer_revision,observed_at,event_count,extrinsic_count,publication_id)
            VALUES($1,123,$2,$3,$4,486,1,$5,$6,$7,0,0,$8)`,
              [
                network,
                hash(123),
                hash(122),
                specimen.snapshot.metadata_digest,
                raw,
                revision,
                at,
                id,
              ],
            );
          await connection.query(
            "INSERT INTO chain.block_publications VALUES($1,$2,123)",
            [id, network],
          );
        }
        await connection.query(
          "UPDATE chain.blocks SET publication_id=$1,producer_revision=$2 WHERE network_id=$3",
          [replayed, "b".repeat(40), network],
        );
        await connection.query(
          "INSERT INTO ops.checkpoints VALUES($1,'blocks',123,123,$2,$3)",
          [network, hash(123), replayed],
        );
      });
      const install = async (
        id: string,
        owner: string,
        status: "stored" | "not_stored",
        amount = "9007199254740993",
      ) =>
        transaction(async (connection) => {
          await connection.query(
            `INSERT INTO ops.publications(publication_id,network_id,first_block,last_block,scope,stage,producer_revision,observed_at,published_at)
          VALUES($1,$2,123,123,'account_balance','published',$3,$4,$4)`,
            [id, network, "c".repeat(40), at],
          );
          const info = {
            account_id: owner,
            nonce: status === "stored" ? "42" : "0",
            consumers: status === "stored" ? "2" : "0",
            providers: status === "stored" ? "3" : "0",
            sufficients: status === "stored" ? "4" : "0",
            free_rao: status === "stored" ? amount : "0",
            reserved_rao: status === "stored" ? "7" : "0",
            frozen_rao: status === "stored" ? "3" : "0",
            flags: "170141183460469231731687303715884105728",
          };
          await connection.query(
            `INSERT INTO chain.fixture_account_balance_admissions
          (publication_id,network_id,account_id,request_id,observation_id,snapshot_id,block_number,block_publication_id,block_capture_digest,block_metadata_digest,block_parent_hash,
           decoder_revision,profile_revision,upstream_revision,projection_contract,status,account_info,state_block_hash,state_metadata_digest,state_spec_version,state_transaction_version,state_producer_revision,fixture_eligible)
          VALUES($1,$2,$3,$4,$5,$6,123,$7,$8,$9,$10,$11,$12,$13,1,$14,$15::jsonb,$16,$17,488,1,$18,true)`,
            [
              id,
              network,
              owner,
              digest("request-" + id),
              digest("point-" + id),
              digest("state-" + id),
              captured,
              raw,
              specimen.snapshot.metadata_digest,
              hash(122),
              "c".repeat(40),
              specimen.balance.profile_revision,
              specimen.balance.upstream_revision,
              status,
              JSON.stringify(info),
              hash(123),
              specimen.balance.state.metadata_digest,
              "d".repeat(40),
            ],
          );
        });
      const response = (owner = account, pin?: string) =>
        application().fetch(
          new Request(
            `${origin}/api/v2/networks/${network}/accounts/${owner}/balance${pin ? "?publication_id=" + pin : ""}`,
          ),
        );
      const read = async (owner = account, pin?: string) => {
        const result = await response(owner, pin);
        assert.equal(result.status, 200);
        return V2AccountBalanceSchema.parse(await result.json());
      };
      const refused = async (owner = account, pin?: string) => {
        const result = await response(owner, pin);
        assert.equal(result.status, 503);
        assert.equal(
          errorResponse.parse(await result.json()).error.code,
          "data_unavailable",
        );
      };
      await install(primary, account, "stored");
      await install(other, absent, "not_stored");
      const first = await read();
      assert.equal(
        first.balance.publication_id,
        primary,
        "newest publication for another account cannot mask this point",
      );
      assert.equal(first.snapshot.publication_id, captured);
      assert.equal(first.snapshot.producer_revision, "a".repeat(40));
      assert.equal(first.snapshot.spec_version, 486);
      assert.equal(first.balance.state.spec_version, 488);
      assert.notEqual(
        first.snapshot.metadata_digest,
        first.balance.state.metadata_digest,
      );
      assert.equal(first.freshness.status, "current");
      assert.equal(first.balance.unit, "rao");
      assert.equal(first.result.status, "stored");
      if (first.result.status === "stored") {
        assert.equal(first.result.account.free_rao, "9007199254740993");
        assert.equal(first.result.account.reserved_rao, "7");
        assert.equal(first.result.account.frozen_rao, "3");
      }
      const missing = await read(absent);
      assert.equal(missing.result.status, "not_stored");
      if (missing.result.status === "not_stored") {
        assert.equal(missing.result.runtime_default.free_rao, "0");
        assert.equal(
          missing.result.runtime_default.flags,
          "170141183460469231731687303715884105728",
        );
      }
      await refused(unknown);
      await refused(account, other);
      const selected = {
        network,
        account_id: account,
        publication_id: primary,
      };
      const client = createV2ReadClient({
        origin,
        fetch: (url, init) => application().fetch(new Request(url, init)),
      });
      assert.deepEqual(
        await client.read("get_account_balance", selected, {
          expectedGenesisHash: specimen.network.genesis_hash,
        }),
        first,
      );
      assert.deepEqual(
        (await tool("get_account_balance", selected, V2AccountBalanceSchema))
          .result.structuredContent,
        first,
      );
      const graph = await application().fetch(
        post("/graphql", {
          query: `{ get_account_balance(input:{network:"${network}",account_id:"${account}",publication_id:"${primary}"}) { account_id result balance { publication_id unit } } }`,
        }),
      );
      assert.deepEqual(await graph.json(), {
        data: {
          get_account_balance: {
            account_id: account,
            result: first.result,
            balance: { publication_id: primary, unit: "rao" },
          },
        },
      });
      await install(latest, account, "stored", "0");
      const newest = await read();
      assert.equal(newest.balance.publication_id, latest);
      assert.equal(newest.result.status, "stored");
      if (newest.result.status === "stored")
        assert.equal(newest.result.account.free_rao, "0");
      assert.deepEqual(await read(account, primary), first);
      await admin.query(
        "UPDATE chain.fixture_account_balance_admissions SET fixture_eligible=false WHERE publication_id=$1",
        [latest],
      );
      try {
        await refused(account, latest);
        assert.deepEqual(await read(), first);
      } finally {
        await admin.query(
          "UPDATE chain.fixture_account_balance_admissions SET fixture_eligible=true WHERE publication_id=$1",
          [latest],
        );
      }
      await admin.query(
        "UPDATE chain.raw_objects SET integrity_verified=false WHERE digest=$1",
        [raw],
      );
      try {
        await refused(account, primary);
        await refused(absent, other);
      } finally {
        await admin.query(
          "UPDATE chain.raw_objects SET integrity_verified=true WHERE digest=$1",
          [raw],
        );
      }
      await admin.query(
        "INSERT INTO ops.gaps(network_id,family,start_block,end_block,reason) VALUES($1,'blocks',123,123,'controlled balance coverage')",
        [network],
      );
      try {
        await refused(account, primary);
      } finally {
        await admin.query(
          "DELETE FROM ops.gaps WHERE network_id=$1 AND family='blocks' AND start_block=123 AND end_block=123",
          [network],
        );
      }
      for (const sql of [
        "SELECT * FROM chain.fixture_account_balance_admissions",
        "UPDATE chain.fixture_account_balance_admissions SET fixture_eligible=true",
        "DELETE FROM chain.fixture_account_balance_admissions",
      ])
        await assert.rejects(
          reader.query(sql),
          (error: unknown) =>
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "42501",
        );
      const before = calls.length;
      assert.equal(
        (
          await application().fetch(
            new Request(
              `${origin}/api/v2/networks/${network}/accounts/${account}/balance?limit=1`,
            ),
          )
        ).status,
        400,
      );
      assert.equal(calls.length, before);
    });

    it("stake reads page indexed positions and claim-only rights through the actual PostgreSQL serving contract", async () => {
      assert.ok(admin);
      assert.ok(servingPool);
      const account = `0x${"a".repeat(64)}`,
        claimOnly = `0x${"b".repeat(64)}`,
        empty = `0x${"c".repeat(64)}`;
      const stakeId = digest("controlled-stake-publication"),
        stateId = digest("controlled-stake-state"),
        stateMetadata = digest("controlled-stake-metadata");
      const entriesFor = (owner: string) =>
        modernAccountStakeRow(owner).entries.map((entry) => {
          if (entry.kind === "position")
            entry.position.asset.genesis_hash = hash(1);
          else {
            entry.entitlement.snapshot_id = stateId;
            if (entry.entitlement.outcome.status === "assessed")
              Object.assign(entry.entitlement.outcome.value, {
                layout_snapshot_id: stateId,
                at_hash: hash(123),
                state_metadata_sha256: stateMetadata,
              });
          }
          return entry;
        });
      const install = async (connection: Client, id: string) => {
        await connection.query(
          `INSERT INTO ops.publications(publication_id,network_id,first_block,last_block,scope,stage,producer_revision,observed_at,published_at)
          VALUES($1,'fixture',123,123,'stake','published',$2,$3,$3)`,
          [id, "b".repeat(64), at],
        );
        await connection.query(
          `INSERT INTO chain.fixture_stake_admissions
          (publication_id,source_id,root_candidate_id,request_id,stake_candidate_id,ecosystem_candidate_id,snapshot_id,network_id,
           block_number,block_publication_id,block_capture_digest,block_metadata_digest,block_parent_hash,state_block_hash,state_metadata_digest,
           state_spec_version,state_transaction_version,state_producer_revision,member_count,claimant_count,projection_contract,fixture_eligible)
          VALUES($1,$2,$3,$4,$5,$6,$7,'fixture',123,$8,$9,$10,$11,$12,$13,488,1,$14,2,2,1,true)`,
          [
            id,
            digest("source-" + id),
            digest("root-" + id),
            digest("request-" + id),
            digest("join-" + id),
            digest("ecosystem-" + id),
            stateId,
            oldPublication,
            digest("raw"),
            digest("metadata"),
            hash(122),
            hash(123),
            stateMetadata,
            "d".repeat(40),
          ],
        );
        for (const owner of [account, claimOnly])
          for (const entry of entriesFor(owner)) {
            if (entry.kind === "position")
              await connection.query(
                `INSERT INTO chain.fixture_stake_positions VALUES($1,$2,$3,$4,$5::jsonb)`,
                [
                  id,
                  owner,
                  entry.position.hotkey,
                  entry.position.netuid,
                  JSON.stringify(entry.position),
                ],
              );
            else
              await connection.query(
                `INSERT INTO chain.fixture_root_entitlements VALUES($1,decode(substring($2::text FROM 3),'hex'),decode(substring($3::text FROM 3),'hex'),$4::jsonb)`,
                [
                  id,
                  owner,
                  entry.entitlement.key.hotkey,
                  JSON.stringify(entry.entitlement),
                ],
              );
          }
      };
      await transaction((connection) => install(connection, stakeId));
      const read = async (
        owner = account,
        cursor?: string,
        limit = 1,
        selected?: string,
      ) => {
        const query = new URLSearchParams({ limit: String(limit) });
        if (cursor !== undefined) query.set("cursor", cursor);
        if (selected !== undefined) query.set("publication_id", selected);
        const response = await application().fetch(
          new Request(
            `${origin}/api/v2/networks/fixture/accounts/${owner}/stake?${query}`,
          ),
        );
        assert.equal(response.status, 200);
        return V2AccountStakeSchema.parse(await response.json());
      };
      const first = await read();
      assert.equal(first.stake.publication_id, stakeId);
      assert.ok(first.next_cursor);
      assert.equal(first.snapshot.publication_id, oldPublication);
      assert.equal(first.snapshot.producer_revision, "a".repeat(40));
      assert.equal(first.snapshot.spec_version, 486);
      assert.equal(first.stake.state.spec_version, 488);
      assert.notEqual(
        first.snapshot.metadata_digest,
        first.stake.state.metadata_digest,
      );
      assert.equal(first.entries[0].kind, "position");
      const second = await read(account, first.next_cursor);
      assert.ok(second.next_cursor);
      assert.equal(second.entries[0].kind, "root_entitlement");
      const third = await read(account, second.next_cursor);
      assert.equal(third.entries[0].kind, "position");
      assert.equal(third.next_cursor, null);
      assert.deepEqual(
        [first.entries[0], second.entries[0], third.entries[0]],
        entriesFor(account),
      );
      const rights = await read(claimOnly, undefined, 10);
      assert.equal(rights.entries.length, 1);
      const entry = rights.entries[0];
      assert.ok(entry.kind === "root_entitlement");
      assert.ok(entry.entitlement.outcome.status === "assessed");
      assert.deepEqual(entry.entitlement.principal, {
        status: "absent_in_complete_join",
      });
      assert.equal(entry.entitlement.outcome.value.deferred_cash_rao, "9");
      const none = await read(empty);
      assert.equal(none.stake.census_complete, true);
      assert.deepEqual(none.entries, []);
      const all = await read(account, undefined, 10);
      const client = createV2ReadClient({
        origin,
        fetch: (url, init) => application().fetch(new Request(url, init)),
      });
      assert.deepEqual(
        await client.read("list_account_stake", {
          network: "fixture",
          account_id: account,
          publication_id: stakeId,
          limit: 10,
        }),
        all,
      );
      assert.deepEqual(
        (
          await tool(
            "list_account_stake",
            {
              network: "fixture",
              account_id: account,
              publication_id: stakeId,
              limit: 10,
            },
            V2AccountStakeSchema,
          )
        ).result.structuredContent,
        all,
      );
      const graph = await application().fetch(
        post("/graphql", {
          query: `{ list_account_stake(input:{network:"fixture",account_id:"${account}",limit:10,publication_id:"${stakeId}"}) { account_id entries next_cursor stake { publication_id } } }`,
        }),
      );
      assert.deepEqual(await graph.json(), {
        data: {
          list_account_stake: {
            account_id: account,
            entries: all.entries,
            next_cursor: null,
            stake: { publication_id: stakeId },
          },
        },
      });
      // A new publication at the same height wins new reads; old continuations
      // retain their original complete population and exact metadata.
      const laterId = digest("later-controlled-stake-publication");
      await transaction(async (connection) => {
        await install(connection, laterId);
        await connection.query(
          `UPDATE chain.fixture_root_entitlements
          SET entitlement=jsonb_set(entitlement,'{outcome,value,deferred_cash_rao}','"50"'::jsonb)
          WHERE publication_id=$1 AND coldkey_bytes=decode(substring($2::text FROM 3),'hex')`,
          [laterId, account],
        );
      });
      const latest = await read(account, undefined, 10);
      assert.equal(latest.stake.publication_id, laterId);
      const newestRight = latest.entries[1];
      assert.ok(
        newestRight.kind === "root_entitlement" &&
          newestRight.entitlement.outcome.status === "assessed",
      );
      assert.equal(
        newestRight.entitlement.outcome.value.deferred_cash_rao,
        "50",
      );
      const continued = await read(account, first.next_cursor);
      assert.equal(continued.stake.publication_id, stakeId);
      assert.equal(continued.stake.source_id, first.stake.source_id);
      assert.deepEqual(
        continued.entries,
        second.entries,
        "old cursor retains original claimant body",
      );
      assert.notDeepEqual(continued.entries, [newestRight]);
      const unavailable = async () => {
        const response = await application().fetch(
          new Request(
            `${origin}/api/v2/networks/fixture/accounts/${account}/stake?publication_id=${stakeId}&limit=1`,
          ),
        );
        assert.equal(response.status, 503);
        assert.equal(
          errorResponse.parse(await response.json()).error.code,
          "data_unavailable",
        );
      };
      await admin.query(
        "UPDATE chain.fixture_stake_admissions SET fixture_eligible=false WHERE publication_id=$1",
        [stakeId],
      );
      try {
        await unavailable();
      } finally {
        await admin.query(
          "UPDATE chain.fixture_stake_admissions SET fixture_eligible=true WHERE publication_id=$1",
          [stakeId],
        );
      }
      await admin.query(
        "UPDATE chain.raw_objects SET integrity_verified=false WHERE digest=$1",
        [digest("raw")],
      );
      try {
        await unavailable();
      } finally {
        await admin.query(
          "UPDATE chain.raw_objects SET integrity_verified=true WHERE digest=$1",
          [digest("raw")],
        );
      }
      await admin.query(
        "INSERT INTO ops.gaps(network_id,family,start_block,end_block,reason) VALUES('fixture','blocks',123,123,'controlled stake read gap')",
      );
      try {
        await unavailable();
      } finally {
        await admin.query(
          "DELETE FROM ops.gaps WHERE network_id='fixture' AND family='blocks' AND start_block=123 AND end_block=123",
        );
      }
      const lastPosition = entriesFor(account).at(-1);
      assert.ok(lastPosition?.kind === "position");
      const original = JSON.stringify(lastPosition.position);
      await admin.query(
        `UPDATE chain.fixture_stake_positions SET position=position||jsonb_build_object('oversized',$4::text)
        WHERE publication_id=$1 AND coldkey=$2 AND hotkey=$3`,
        [stakeId, account, lastPosition.position.hotkey, "x".repeat(140000)],
      );
      try {
        // A large off-page body is never fetched into the first page's JSON.
        assert.equal(
          (await read(account, undefined, 1, stakeId)).entries.length,
          1,
        );
        const response = await application().fetch(
          new Request(
            `${origin}/api/v2/networks/fixture/accounts/${account}/stake?limit=1&cursor=${second.next_cursor}`,
          ),
        );
        assert.equal(response.status, 503);
      } finally {
        await admin.query(
          "UPDATE chain.fixture_stake_positions SET position=$4::jsonb WHERE publication_id=$1 AND coldkey=$2 AND hotkey=$3",
          [stakeId, account, lastPosition.position.hotkey, original],
        );
      }
      await admin.query(
        `UPDATE chain.fixture_stake_positions SET position=jsonb_set(position,'{quote,atomic_units}','9007199254740993'::jsonb)
        WHERE publication_id=$1 AND coldkey=$2 AND hotkey=$3`,
        [stakeId, account, `0x${"0".repeat(64)}`],
      );
      try {
        await unavailable();
      } finally {
        const value = entriesFor(account)[0];
        assert.ok(value.kind === "position");
        await admin.query(
          "UPDATE chain.fixture_stake_positions SET position=$4::jsonb WHERE publication_id=$1 AND coldkey=$2 AND hotkey=$3",
          [
            stakeId,
            account,
            value.position.hotkey,
            JSON.stringify(value.position),
          ],
        );
      }
      // Observe the actual plan under the serving session. These small fixture
      // plans prove query execution/limits, not production capacity or latency.
      await read(account, undefined, 10, stakeId);
      const call = calls.findLast((call) =>
        call.sql.includes("FROM chain.eligible_stake_publications e"),
      );
      assert.ok(call);
      const connection = await servingPool.connect();
      try {
        await connection.query("SET SESSION AUTHORIZATION metagraphed_serve");
        assert.deepEqual(
          (
            await connection.query(
              "SELECT current_user::text,session_user::text",
            )
          ).rows,
          [
            {
              current_user: "metagraphed_serve",
              session_user: "metagraphed_serve",
            },
          ],
        );
        for (const table of [
          "chain.fixture_stake_admissions",
          "chain.fixture_stake_positions",
          "chain.fixture_root_entitlements",
        ])
          await assert.rejects(
            connection.query(`SELECT * FROM ${table} LIMIT 1`),
            (error: unknown) =>
              error !== null &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "42501",
          );
        const explained = await connection.query(
          "EXPLAIN (ANALYZE,FORMAT JSON,TIMING OFF) " + call.sql,
          call.values,
        );
        const plan = z
          .array(z.record(z.string(), z.unknown()))
          .parse(explained.rows[0]["QUERY PLAN"]);
        const rootPlan = z.record(z.string(), z.unknown()).parse(plan[0].Plan);
        const nodes: Record<string, unknown>[] = [];
        const pending = [rootPlan];
        while (pending.length > 0) {
          const node = pending.pop()!;
          nodes.push(node);
          if (node.Plans !== undefined)
            pending.push(
              ...z.array(z.record(z.string(), z.unknown())).parse(node.Plans),
            );
        }
        // Verify the actual separately materialized key and body stages. A
        // generic Limit elsewhere (for example chosen's LIMIT 1) is insufficient.
        for (const name of ["position_keys", "root_keys", "keys", "page"]) {
          const materialized = nodes.filter(
            (node) => node["Subplan Name"] === `CTE ${name}`,
          );
          assert.equal(
            materialized.length,
            1,
            `${name} has one actual materialized producer`,
          );
          const actual = materialized[0];
          const maximum = name === "page" ? 10 : 11;
          assert.ok(
            typeof actual["Actual Rows"] === "number" &&
              actual["Actual Rows"] <= maximum,
            `${name} output respects the requested page bound`,
          );
          assert.equal(actual["Actual Loops"], 1, `${name} is evaluated once`);
          if (name !== "page")
            assert.equal(
              actual["Node Type"],
              "Limit",
              `${name} owns its limit`,
            );
        }
      } finally {
        connection.release(true);
      }
    });

    it("account activity deduplicates typed appearances and fences overlapping replay in PostgreSQL", async () => {
      assert.ok(admin);
      const account = hash(700);
      const other = hash(701);
      const raw = digest("activity-raw");
      const pub = (height: number) => digest(`activity-${height}`);
      const addEvent = async (
        connection: Client,
        height: number,
        index: number,
        publicationId = pub(height),
      ) => {
        await connection.query(
          `INSERT INTO chain.events
          (publication_id,network_id,block_number,event_index,pallet,variant,fields,phase,extrinsic_index,topics)
          VALUES($1,'activity',$2,$3,'Controlled','Observed',$4::jsonb,'Finalization',NULL,'{}')`,
          [
            publicationId,
            height,
            index,
            JSON.stringify({
              account_id: account,
              amount: "18446744073709551615",
            }),
          ],
        );
        if (height === 123 && index === 0) return; // A hash-shaped field is not a typed participant.
        const appearances =
          height === 123 && index === 2
            ? [account, other, account]
            : [height === 121 ? other : account];
        for (const [position, id] of appearances.entries())
          await connection.query(
            `INSERT INTO chain.event_participants VALUES($1,'activity',$2,$3,$4,$5,$6)`,
            [publicationId, height, index, position, id, `field_${position}`],
          );
      };
      const addPublication = async (
        connection: Client,
        height: number,
        id = pub(height),
      ) => {
        await connection.query(
          `INSERT INTO ops.publications
          (publication_id,network_id,first_block,last_block,scope,stage,producer_revision,observed_at,published_at)
          VALUES($1,'activity',$2,$2,'blocks','published',$3,$4,$4)`,
          [id, height, "c".repeat(40), at],
        );
      };
      const addBlock = async (connection: Client, height: number) => {
        await addPublication(connection, height);
        const count =
          height === 123 ? 3 : height === 121 || height === 122 ? 1 : 0;
        await connection.query(
          `INSERT INTO chain.blocks
          (network_id,block_number,block_hash,parent_hash,metadata_digest,spec_version,transaction_version,
            raw_digest,producer_revision,observed_at,event_count,extrinsic_count,publication_id)
          VALUES('activity',$1,$2,$3,$4,488,1,$5,$6,$7,$8,0,$9)`,
          [
            height,
            hash(height),
            hash(height - 1),
            digest("metadata"),
            raw,
            "c".repeat(40),
            at,
            count,
            pub(height),
          ],
        );
        await connection.query(
          `INSERT INTO chain.block_publications VALUES($1,'activity',$2)`,
          [pub(height), height],
        );
        for (let index = 0; index < count; index++)
          await addEvent(connection, height, index);
      };
      await transaction(async (connection) => {
        await connection.query(
          `INSERT INTO chain.networks
          (network_id,genesis_hash,finalized_observed_height,finalized_observed_hash,finalized_observed_at)
          VALUES('activity',$1,123,$2,$3)`,
          [hash(42), hash(123), at],
        );
        await connection.query(
          `INSERT INTO chain.runtime_metadata VALUES('activity',$1,'0x00')`,
          [digest("metadata")],
        );
        await connection.query(
          `INSERT INTO chain.raw_objects
          (digest,kind,content_digest,stored_digest,object_key,byte_length,stored_byte_length,compression,integrity_verified)
          VALUES($1,'opaque',$1,$1,$2,3,3,'none',true)`,
          [raw, `${raw}.raw`],
        );
        for (const height of [120, 121, 122, 123])
          await addBlock(connection, height);
        await connection.query(
          `INSERT INTO ops.checkpoints VALUES('activity','blocks',120,123,$1,$2)`,
          [hash(123), pub(123)],
        );
      });
      const client = createV2ReadClient({
        origin,
        fetch: (url, init) => application().fetch(new Request(url, init)),
      });
      const input = { network: "activity", account_id: account, limit: 1 };
      const startCalls = calls.length;
      const first = await client.read("list_account_events", input);
      assert.equal(
        calls.length,
        startCalls + 1,
        "one statement supplies all page evidence",
      );
      assert.equal(first.events[0].event.event_index, 2);
      assert.deepEqual(
        first.events[0].matching_participants.map((p) => p.participant_index),
        [0, 2],
      );
      assert.deepEqual(first.events[0].event.fields, {
        account_id: account,
        amount: "18446744073709551615",
      });
      assert.ok(first.next_cursor);
      const second = await client.read("list_account_events", {
        ...input,
        cursor: first.next_cursor,
      });
      assert.equal(second.events[0].event.event_index, 1);
      assert.ok(second.next_cursor);
      const third = await client.read("list_account_events", {
        ...input,
        cursor: second.next_cursor,
      });
      assert.equal(third.events[0].snapshot.block_number, "122");
      assert.equal(third.next_cursor, null);
      const empty = await client.read("list_account_events", {
        ...input,
        account_id: hash(702),
      });
      assert.deepEqual(empty.events, []);
      assert.deepEqual(empty.coverage, {
        from_block: "120",
        through_block: "123",
        contiguous: true,
      });
      const mcp = await tool(
        "list_account_events",
        input,
        V2AccountEventsSchema,
      );
      assert.deepEqual(mcp.result.structuredContent, first);
      const graph = graphResponse.parse(
        await (
          await application().fetch(
            post("/graphql", {
              query: `{ list_account_events(input:{network:"activity",account_id:"${account}",limit:1}) { account_id events { event { event_index } matching_participants { participant_index } } } }`,
            }),
          )
        ).json(),
      );
      assert.equal(graph.errors, undefined);
      assert.deepEqual(graph.data.list_account_events, {
        account_id: account,
        events: [
          {
            event: { event_index: 2 },
            matching_participants: [
              { participant_index: 0 },
              { participant_index: 2 },
            ],
          },
        ],
      });
      const unavailable = async (selectedAccount = account) => {
        const response = await application().fetch(
          new Request(
            `${origin}/api/v2/networks/activity/accounts/${selectedAccount}/events?limit=1`,
          ),
        );
        assert.equal(response.status, 503);
        assert.equal(
          errorResponse.parse(await response.json()).error.code,
          "data_unavailable",
        );
      };
      // Off-page/nonmatching body absence still invalidates even an empty account read.
      await transaction(async (connection) => {
        await connection.query(
          `DELETE FROM chain.event_participants WHERE network_id='activity' AND block_number=121`,
        );
        await connection.query(
          `DELETE FROM chain.events WHERE network_id='activity' AND block_number=121`,
        );
      });
      try {
        await unavailable();
        await unavailable(hash(702));
      } finally {
        await transaction((connection) => addEvent(connection, 121, 0));
      }
      await admin.query(
        `UPDATE chain.blocks SET parent_hash=$1 WHERE network_id='activity' AND block_number=122`,
        [hash(999)],
      );
      try {
        await unavailable();
      } finally {
        await admin.query(
          `UPDATE chain.blocks SET parent_hash=$1 WHERE network_id='activity' AND block_number=122`,
          [hash(121)],
        );
      }
      await admin.query(
        `UPDATE chain.raw_objects SET integrity_verified=false WHERE digest=$1`,
        [raw],
      );
      try {
        await unavailable();
      } finally {
        await admin.query(
          `UPDATE chain.raw_objects SET integrity_verified=true WHERE digest=$1`,
          [raw],
        );
      }
      await admin.query(`INSERT INTO ops.gaps(network_id,family,start_block,end_block,reason)
        VALUES('activity','blocks',121,121,'controlled missing evidence')`);
      try {
        await unavailable();
      } finally {
        await admin.query(`DELETE FROM ops.gaps WHERE network_id='activity'`);
      }
      for (const fields of [
        '{"amount":1.00000000000000001}',
        '{"amount":9007199254740992}',
        JSON.stringify({ text: "x".repeat(262145) }),
        JSON.stringify(Array.from({ length: 16385 }, () => null)),
      ]) {
        await admin.query(
          `UPDATE chain.events SET fields=$1::jsonb WHERE network_id='activity' AND block_number=123 AND event_index=2`,
          [fields],
        );
        try {
          await unavailable();
        } finally {
          await admin.query(
            `UPDATE chain.events SET fields=$1::jsonb WHERE network_id='activity' AND block_number=123 AND event_index=2`,
            [JSON.stringify(first.events[0].event.fields)],
          );
        }
      }
      // Growth above the anchor and a lower nonoverlapping publication preserve the cursor.
      await transaction(async (connection) => {
        await addBlock(connection, 124);
        await addBlock(connection, 119);
        await connection.query(
          `UPDATE ops.checkpoints SET complete_from=119,complete_through=124,block_hash=$1,publication_id=$2 WHERE network_id='activity'`,
          [hash(124), pub(124)],
        );
        await connection.query(
          `UPDATE chain.networks SET finalized_observed_height=124,finalized_observed_hash=$1 WHERE network_id='activity'`,
          [hash(124)],
        );
      });
      const continued = await client.read("list_account_events", {
        ...input,
        cursor: first.next_cursor,
      });
      assert.equal(continued.snapshot.block_number, "123");
      assert.equal(continued.coverage.from_block, "120");
      assert.equal(continued.events[0].event.event_index, 1);
      // Replay a nonmatching historical block while retaining tip/hash and old versions.
      const replay = digest("activity-replay-121");
      await transaction(async (connection) => {
        await addPublication(connection, 121, replay);
        await connection.query(
          `INSERT INTO chain.block_publications VALUES($1,'activity',121)`,
          [replay],
        );
        await addEvent(connection, 121, 0, replay);
        await connection.query(
          `UPDATE chain.blocks SET publication_id=$1 WHERE network_id='activity' AND block_number=121`,
          [replay],
        );
      });
      await assert.rejects(
        client.read("list_account_events", {
          ...input,
          cursor: first.next_cursor,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "serverCode" in error &&
          error.serverCode === "data_unavailable",
      );
      const refreshed = await client.read("list_account_events", input);
      assert.equal(refreshed.snapshot.block_number, "124");
      assert.notEqual(
        refreshed.revision.publication_id,
        first.revision.publication_id,
      );
    });

    it("walks published blocks and both pinned body pages against the serving role", async () => {
      const raw = digest("explorer-raw");
      const publicationFor = (height: number) =>
        digest(`explorer-publication-${height}`);
      const addBlock = async (client: Client, height: number) => {
        const count = height === 123 ? 3 : 0;
        await client.query(
          `INSERT INTO ops.publications (publication_id,network_id,first_block,last_block,scope,stage,producer_revision,observed_at,published_at)
          VALUES($1,'explorer',$2,$2,'blocks','published',$3,$4,$4)`,
          [publicationFor(height), height, "c".repeat(40), at],
        );
        await client.query(
          `INSERT INTO chain.blocks (network_id,block_number,block_hash,parent_hash,metadata_digest,spec_version,transaction_version,raw_digest,producer_revision,observed_at,event_count,extrinsic_count,publication_id)
          VALUES('explorer',$1,$2,$3,$4,488,1,$5,$6,$7,$8,$8,$9)`,
          [
            height,
            hash(height),
            hash(height - 1),
            digest("metadata"),
            raw,
            "c".repeat(40),
            at,
            count,
            publicationFor(height),
          ],
        );
        await client.query(
          `INSERT INTO chain.block_publications VALUES($1,'explorer',$2)`,
          [publicationFor(height), height],
        );
      };
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO chain.networks(network_id,genesis_hash,finalized_observed_height,finalized_observed_hash,finalized_observed_at) VALUES('explorer',$1,123,$2,$3)`,
          [hash(42), hash(123), at],
        );
        await client.query(
          `INSERT INTO chain.runtime_metadata VALUES('explorer',$1,'0x00')`,
          [digest("metadata")],
        );
        await client.query(
          `INSERT INTO chain.raw_objects(digest,kind,content_digest,stored_digest,object_key,byte_length,stored_byte_length,compression,integrity_verified) VALUES($1,'opaque',$1,$1,$2,3,3,'none',true)`,
          [raw, `${raw}.raw`],
        );
        for (const height of [120, 121, 122, 123])
          await addBlock(client, height);
        await client.query(
          `INSERT INTO ops.checkpoints VALUES('explorer','blocks',120,123,$1,$2)`,
          [hash(123), publicationFor(123)],
        );
        for (const index of [0, 1, 2]) {
          await client.query(
            `INSERT INTO chain.extrinsics(publication_id,network_id,block_number,extrinsic_index,extrinsic_hash,raw_hex,pallet,call,fields,is_signed,signer)
            VALUES($1,'explorer',123,$2,$3,'0x00','Balances','transfer_keep_alive',$4,true,$5)`,
            [
              publicationFor(123),
              index,
              hash(300 + index),
              JSON.stringify({ amount_rao: "18446744073709551615" }),
              JSON.stringify({ account_id: hash(700) }),
            ],
          );
          await client.query(
            `INSERT INTO chain.events(publication_id,network_id,block_number,event_index,pallet,variant,fields,phase,extrinsic_index,topics)
            VALUES($1,'explorer',123,$2,'Balances','Transfer',$3,'ApplyExtrinsic',$2,$4)`,
            [
              publicationFor(123),
              index,
              JSON.stringify({ amount_rao: "18446744073709551615" }),
              [hash(800 + index)],
            ],
          );
        }
        await client.query(
          `INSERT INTO chain.event_participants VALUES($1,'explorer',123,0,0,$2,'sender')`,
          [publicationFor(123), hash(700)],
        );
      });
      const client = createV2ReadClient({
        origin,
        fetch: (input, init) => application().fetch(new Request(input, init)),
      });
      const first = await client.read(
        "list_blocks",
        { network: "explorer", limit: 2 },
        { expectedGenesisHash: hash(42) },
      );
      assert.deepEqual(
        first.blocks.map((block) => block.snapshot.block_number),
        ["123", "122"],
      );
      assert.equal(
        first.blocks[0].snapshot.publication_id,
        publicationFor(123),
      );
      assert.equal(
        first.blocks[1].snapshot.publication_id,
        publicationFor(122),
      );
      const mcp = await tool(
        "list_blocks",
        { network: "explorer", limit: 2 },
        V2BlockListSchema,
      );
      assert.deepEqual(mcp.result.structuredContent, first);
      const pins = {
        block_hash: hash(123),
        publication_id: publicationFor(123),
      };
      const block = await client.read("get_block", {
        network: "explorer",
        height: "123",
        ...pins,
        limit: 1,
        extrinsic_limit: 1,
      });
      assert.equal(block.source_capture_digest, raw);
      assert.equal(block.next_event_index, 0);
      assert.equal(block.next_extrinsic_index, 0);
      assert.deepEqual(block.events[0].fields, {
        amount_rao: "18446744073709551615",
      });
      assert.deepEqual(block.events[0].participants, [
        { participant_index: 0, account_id: hash(700), role: "sender" },
      ]);
      const events = await client.read("get_block", {
        network: "explorer",
        height: "123",
        ...pins,
        after_event_index: 0,
        extrinsic_limit: 1,
      });
      const extrinsics = await client.read("get_block", {
        network: "explorer",
        height: "123",
        ...pins,
        after_extrinsic_index: 0,
        limit: 1,
      });
      assert.deepEqual(
        events.events.map((event) => event.event_index),
        [1, 2],
      );
      assert.deepEqual(
        extrinsics.extrinsics.map((extrinsic) => extrinsic.extrinsic_index),
        [1, 2],
      );
      assert.equal(events.extrinsics[0].extrinsic_index, 0);
      assert.equal(extrinsics.events[0].event_index, 0);
      const mcpBlock = await tool(
        "get_block",
        {
          network: "explorer",
          height: "123",
          ...pins,
          limit: 1,
          extrinsic_limit: 1,
        },
        V2BlockSchema,
      );
      assert.deepEqual(mcpBlock.result.structuredContent, block);
      const graph = await application().fetch(
        post("/graphql", {
          query: `{ get_block(input: { network:"explorer",height:"123",block_hash:"${pins.block_hash}",publication_id:"${pins.publication_id}",limit:1,extrinsic_limit:1 }) { source_capture_digest events { fields phase extrinsic_index topics participants { account_id role } } extrinsics { fields signer } } }`,
        }),
      );
      const graphValue = graphResponse.parse(await graph.json());
      assert.equal(graphValue.errors, undefined);
      assert.deepEqual(graphValue.data.get_block, {
        source_capture_digest: raw,
        events: [
          {
            fields: block.events[0].fields,
            phase: "ApplyExtrinsic",
            extrinsic_index: 0,
            topics: [hash(800)],
            participants: [{ account_id: hash(700), role: "sender" }],
          },
        ],
        extrinsics: [
          {
            fields: block.extrinsics[0].fields,
            signer: block.extrinsics[0].signer,
          },
        ],
      });
      await transaction(async (connection) => {
        await addBlock(connection, 124);
        await connection.query(
          `UPDATE ops.checkpoints SET complete_through=124,block_hash=$1,publication_id=$2 WHERE network_id='explorer'`,
          [hash(124), publicationFor(124)],
        );
        await connection.query(
          `UPDATE chain.networks SET finalized_observed_height=124,finalized_observed_hash=$1 WHERE network_id='explorer'`,
          [hash(124)],
        );
      });
      const older = await client.read("list_blocks", {
        network: "explorer",
        anchor_height: first.snapshot.block_number,
        anchor_hash: first.snapshot.block_hash,
        anchor_publication_id: first.snapshot.publication_id,
        from_block: first.coverage.from_block,
        before: first.next_before!,
        limit: 2,
      });
      assert.deepEqual(
        older.blocks.map((entry) => entry.snapshot.block_number),
        ["121", "120"],
      );
      assert.equal(older.snapshot.block_number, "123");
      assert.equal(older.next_before, null);
      const path = `${origin}/api/v2/networks/explorer/blocks/123?block_hash=${pins.block_hash}&publication_id=${pins.publication_id}`;
      const unavailable = async () => {
        const response = await application().fetch(new Request(path));
        assert.equal(response.status, 503);
        const value = z
          .object({ error: z.object({ code: z.string() }) })
          .parse(await response.json());
        assert.equal(value.error.code, "data_unavailable");
      };
      assert.ok(admin);
      await admin.query(
        `UPDATE chain.event_participants SET participant_index=2 WHERE network_id='explorer'`,
      );
      try {
        await unavailable();
      } finally {
        await admin.query(
          `UPDATE chain.event_participants SET participant_index=0 WHERE network_id='explorer'`,
        );
      }
      await admin.query(
        `UPDATE chain.events SET event_index=3 WHERE network_id='explorer' AND event_index=2`,
      );
      try {
        await unavailable();
      } finally {
        await admin.query(
          `UPDATE chain.events SET event_index=2 WHERE network_id='explorer' AND event_index=3`,
        );
      }
      await admin.query(
        `UPDATE chain.events SET fields=jsonb_build_object('payload',repeat('x',262145)) WHERE network_id='explorer' AND event_index=0`,
      );
      try {
        await unavailable();
      } finally {
        await admin.query(
          `UPDATE chain.events SET fields=$1::jsonb WHERE network_id='explorer' AND event_index=0`,
          [JSON.stringify(block.events[0].fields)],
        );
      }
      await admin.query(
        `UPDATE chain.events SET topics=ARRAY[repeat('x',1000000)] WHERE network_id='explorer' AND event_index=0`,
      );
      try {
        await unavailable();
      } finally {
        await admin.query(
          `UPDATE chain.events SET topics=$1 WHERE network_id='explorer' AND event_index=0`,
          [[hash(800)]],
        );
      }
      const exactFields = JSON.stringify(block.events[0].fields);
      await admin.query(
        `UPDATE chain.events SET fields=$1::jsonb WHERE network_id='explorer' AND event_index=0`,
        [
          '{"minimum":-9007199254740991,"maximum":9007199254740991,"whole":1.0000}',
        ],
      );
      try {
        const exact = await client.read("get_block", {
          network: "explorer",
          height: "123",
          ...pins,
          limit: 1,
          extrinsic_limit: 1,
        });
        assert.deepEqual(exact.events[0].fields, {
          minimum: -9007199254740991,
          maximum: 9007199254740991,
          whole: 1,
        });
      } finally {
        await admin.query(
          `UPDATE chain.events SET fields=$1::jsonb WHERE network_id='explorer' AND event_index=0`,
          [exactFields],
        );
      }
      for (const invalid of [
        '{"amount":1.00000000000000001}',
        '{"amount":9007199254740991.1}',
        '{"nested":[{"amount":9007199254740992}]}',
      ]) {
        for (const target of ["event", "extrinsic", "signer"] as const) {
          const table = target === "event" ? "events" : "extrinsics";
          const column = target === "signer" ? "signer" : "fields";
          const indexColumn =
            target === "event" ? "event_index" : "extrinsic_index";
          const original =
            target === "signer"
              ? JSON.stringify(block.extrinsics[0].signer)
              : exactFields;
          await admin.query(
            `UPDATE chain.${table} SET ${column}=$1::jsonb WHERE network_id='explorer' AND ${indexColumn}=0`,
            [invalid],
          );
          try {
            await unavailable();
          } finally {
            await admin.query(
              `UPDATE chain.${table} SET ${column}=$1::jsonb WHERE network_id='explorer' AND ${indexColumn}=0`,
              [original],
            );
          }
        }
      }
      await admin.query(
        `UPDATE chain.raw_objects SET integrity_verified=false WHERE digest=$1`,
        [raw],
      );
      try {
        await unavailable();
        assert.equal(
          (
            await application().fetch(
              new Request(`${origin}/api/v2/networks/explorer/blocks`),
            )
          ).status,
          503,
        );
      } finally {
        await admin.query(
          `UPDATE chain.raw_objects SET integrity_verified=true WHERE digest=$1`,
          [raw],
        );
      }
      const replacement = digest("explorer-replacement");
      await transaction(async (connection) => {
        await connection.query(
          `INSERT INTO ops.publications(publication_id,network_id,first_block,last_block,scope,stage,producer_revision,observed_at,published_at) VALUES($1,'explorer',123,123,'blocks','published',$2,$3,$3)`,
          [replacement, "e".repeat(40), at],
        );
        await connection.query(
          `INSERT INTO chain.block_publications VALUES($1,'explorer',123)`,
          [replacement],
        );
        await connection.query(
          `UPDATE chain.blocks SET publication_id=$1 WHERE network_id='explorer' AND block_number=123`,
          [replacement],
        );
      });
      await unavailable();
      assert.equal(
        (
          await application().fetch(
            new Request(`${origin}/api/v2/networks/explorer/blocks/999`),
          )
        ).status,
        404,
      );
    });

    it("serves the latest same-block and same-time generations over REST, MCP and GraphQL", async () => {
      const rest = await application().fetch(
        new Request(`${origin}/api/v2/networks/fixture/subnets/200/services`),
      );
      assert.equal(rest.status, 200);
      const value = V2SubnetServicesSchema.parse(await rest.json());
      assert.equal(value.snapshot.publication_id, oldPublication);
      assert.equal(value.ecosystem.publication_id, ecosystemPublication);
      assert.equal(
        value.ecosystem.state.metadata_digest,
        digest("state-metadata"),
      );
      assert.equal(
        value.subnet.generation.registration_counter,
        currentCounter,
      );
      assert.equal(value.catalog.catalog_id, catalog);
      assert.equal(value.catalog.generation, "2");
      assert.equal(value.services[0].name, "Current image inference");
      const verification = value.services[0].verification;
      assert.ok(verification);
      assert.equal(verification.status, "verified");
      assert.equal(verification.generation, "2");
      const mcp = await tool(
        "list_subnet_apis",
        { network: "fixture", netuid: 200 },
        V2SubnetServicesSchema,
      );
      assert.deepEqual(mcp.result.structuredContent, value);
      const response = await application().fetch(
        post("/graphql", {
          query: `{ list_subnet_apis(input: {network:"fixture",netuid:200}) {
      snapshot { publication_id } catalog { catalog_id generation } services { name verification { status generation } }
    } }`,
        }),
      );
      assert.equal(response.status, 200);
      const graphql = graphResponse.parse(await response.json());
      assert.equal(graphql.errors, undefined);
      assert.deepEqual(graphql.data.list_subnet_apis, {
        snapshot: { publication_id: oldPublication },
        catalog: { catalog_id: catalog, generation: "2" },
        services: [
          {
            name: "Current image inference",
            verification: { status: "verified", generation: "2" },
          },
        ],
      });
    });

    it("refuses a head whose retained input is withdrawn and recovers the exact publication", async () => {
      assert.ok(admin);
      const path = `${origin}/api/v2/networks/fixture/head`;
      const original = await application().fetch(new Request(path));
      assert.equal(original.status, 200);
      const expected = V2HeadSchema.parse(await original.json());
      const recorded = (
        await admin.query(
          "SELECT integrity_verified FROM chain.raw_objects WHERE digest=$1",
          [digest("raw")],
        )
      ).rows;
      assert.deepEqual(recorded, [{ integrity_verified: true }]);
      try {
        await admin.query(
          "UPDATE chain.raw_objects SET integrity_verified=false WHERE digest=$1",
          [digest("raw")],
        );
        const before = calls.length;
        const unavailable = await application().fetch(new Request(path));
        assert.equal(unavailable.status, 503);
        const error = await unavailable.json();
        assert.ok(
          error !== null && typeof error === "object" && !Array.isArray(error),
        );
        assert.equal(errorResponse.parse(error).error.code, "data_unavailable");
        assert.equal(Object.hasOwn(error, "snapshot"), false);
        assert.equal(calls.length, before + 1);
      } finally {
        await admin.query(
          "UPDATE chain.raw_objects SET integrity_verified=$2 WHERE digest=$1",
          [digest("raw"), recorded[0].integrity_verified],
        );
      }
      const recovered = await application().fetch(new Request(path));
      assert.equal(recovered.status, 200);
      assert.deepEqual(V2HeadSchema.parse(await recovered.json()), expected);
    });

    it("preserves canonical identities, root defaults and unavailable cleanup mechanisms", async () => {
      const response = await application().fetch(
        new Request(
          `${origin}/api/v2/networks/fixture/subnets?publication_id=${ecosystemPublication}`,
        ),
      );
      assert.equal(response.status, 200);
      const value = V2SubnetListSchema.parse(await response.json());
      assert.equal(value.snapshot.publication_id, oldPublication);
      assert.equal(value.snapshot.spec_version, 486);
      assert.equal(value.snapshot.transaction_version, 1);
      assert.equal(value.snapshot.metadata_digest, digest("metadata"));
      assert.equal(value.ecosystem.publication_id, ecosystemPublication);
      assert.equal(value.ecosystem.block_publication_id, oldPublication);
      assert.equal(
        value.ecosystem.source_id,
        digest(`source-${ecosystemPublication}`),
      );
      assert.equal(
        value.ecosystem.candidate_id,
        digest(`candidate-${ecosystemPublication}`),
      );
      assert.equal(
        value.ecosystem.state.snapshot_id,
        digest(`snapshot-${ecosystemPublication}`),
      );
      assert.equal(
        value.ecosystem.state.metadata_digest,
        digest("state-metadata"),
      );
      assert.equal(value.ecosystem.state.spec_version, 488);
      assert.equal(value.ecosystem.state.transaction_version, 2);
      assert.equal(value.ecosystem.state_proof_verified, false);
      assert.equal(value.ecosystem.runtime_semantics_attested, false);
      assert.equal(value.ecosystem.reportable_mechanisms_complete, false);
      assert.deepEqual(value.ecosystem.operational_netuids, [0, 200]);
      assert.deepEqual(value.ecosystem.residual_storage_netuids, [4094]);
      assert.equal(value.freshness.target_seconds, 900);
      assert.equal(value.freshness.target_blocks, null);
      assert.equal(value.coverage.reportable_subnets, 3);
      assert.equal(value.coverage.operational_subnets, 2);
      const [root, cleanup, current] = value.subnets;
      assert.deepEqual(root, {
        ...canonicalSubnet({
          netuid: 0,
          counter: "0",
          registrationBlock: 0,
          mechanismCount: 1,
        }),
        counter_source: "runtime_default",
        current_registration_block: { value: 0, source: "runtime_default" },
        pricing_mode_code: { value: 0, source: "runtime_default" },
        mechanism_count: { value: 1, source: "runtime_default" },
      });
      assert.deepEqual(
        cleanup,
        canonicalSubnet({
          netuid: 128,
          counter: "0",
          registrationBlock: 30,
          lifecycle: "dissolving",
          mechanismCount: null,
        }),
      );
      assert.equal(current.generation.registration_counter, currentCounter);
      assert.equal(current.current_registration_block.value, 40);
      assert.notEqual(
        current.generation.registration_counter,
        String(current.current_registration_block.value),
      );
      assert.ok(reader);
      assert.equal(
        (
          await reader.query(
            "SELECT publication_id FROM chain.blocks WHERE network_id='fixture' AND block_number=123",
          )
        ).rows[0].publication_id,
        publication,
        "Decoder replay may advance the block pointer without rewriting an ecosystem selection",
      );
      const fromTool = await tool(
        "list_subnets",
        { network: "fixture", publication_id: ecosystemPublication },
        V2SubnetListSchema,
      );
      assert.deepEqual(fromTool.result.structuredContent, value);
    });

    it("pins a 406-registration directory across REST, MCP and GraphQL while a newer generation appears", async () => {
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO chain.networks(network_id,genesis_hash,finalized_observed_height,finalized_observed_hash,finalized_observed_at)
          VALUES('directory',$1,123,$2,$3)`,
          [hash(7), hash(123), at],
        );
        await client.query(
          `INSERT INTO chain.runtime_metadata VALUES('directory',$1,'0x00')`,
          [digest("metadata")],
        );
        await client.query(
          `INSERT INTO chain.raw_objects(digest,kind,content_digest,stored_digest,object_key,byte_length,stored_byte_length,compression,integrity_verified)
          VALUES($1,'opaque',$1,$1,$2,3,3,'none',true)`,
          [digest("directory-raw"), `${digest("directory-raw")}.raw`],
        );
        await addDirectoryPublication(
          client,
          directoryPublication,
          directoryNetuids,
        );
      });
      const response = await application().fetch(
        new Request(`${origin}/api/v2/networks/directory/subnets?limit=200`),
      );
      assert.equal(response.status, 200);
      const first = V2SubnetListSchema.parse(await response.json());
      assert.equal(first.snapshot.publication_id, directoryBlockPublication);
      assert.equal(first.ecosystem.publication_id, directoryPublication);
      assert.equal(first.subnets[0].generation.netuid, 0);
      assert.equal(first.coverage.reportable_subnets, 406);
      assert.equal(first.next_after, 199);

      await transaction((client) =>
        addDirectoryPublication(client, newerDirectoryPublication, [0, 1000]),
      );
      const second = (
        await tool(
          "list_subnets",
          {
            network: "directory",
            publication_id: first.ecosystem.publication_id,
            after: first.next_after,
            limit: 200,
          },
          V2SubnetListSchema,
        )
      ).result.structuredContent;
      assert.equal(second.snapshot.publication_id, directoryBlockPublication);
      assert.deepEqual(second.ecosystem, first.ecosystem);
      assert.deepEqual(second.coverage, first.coverage);
      assert.equal(second.next_after, 399);
      assert.ok(
        second.subnets.every(
          (subnet) => subnet.generation.netuid > first.next_after!,
        ),
      );

      const graph = await application().fetch(
        post("/graphql", {
          query: `query Page($input: Input_list_subnets!) {
          list_subnets(input: $input) {
            snapshot { publication_id }
            ecosystem { publication_id }
            coverage { registry_complete reportable_subnets operational_subnets }
            subnets { generation { netuid } }
            next_after
          }
        }`,
          variables: {
            input: {
              network: "directory",
              publication_id: first.ecosystem.publication_id,
              after: second.next_after,
              limit: 200,
            },
          },
        }),
      );
      assert.equal(graph.status, 200);
      const third = z
        .object({
          data: z.object({
            list_subnets: z.object({
              snapshot: z.object({
                publication_id: z.literal(directoryBlockPublication),
              }),
              ecosystem: z.object({
                publication_id: z.literal(directoryPublication),
              }),
              coverage: V2SubnetListSchema.shape.coverage,
              subnets: z.array(
                z.object({
                  generation: z.object({ netuid: z.number().int() }),
                }),
              ),
              next_after: z.null(),
            }),
          }),
        })
        .strict()
        .parse(await graph.json()).data.list_subnets;
      assert.deepEqual(third.coverage, first.coverage);
      assert.equal(
        third.ecosystem.publication_id,
        first.ecosystem.publication_id,
      );
      assert.ok(
        third.subnets.every(
          (subnet) => subnet.generation.netuid > second.next_after!,
        ),
      );
      const ids = [...first.subnets, ...second.subnets, ...third.subnets].map(
        (subnet) => subnet.generation.netuid,
      );
      assert.deepEqual(ids, directoryNetuids);
      assert.equal(new Set(ids).size, 406);

      const pinned = await application().fetch(
        new Request(
          `${origin}/api/v2/networks/directory/subnets/405?publication_id=${directoryPublication}`,
        ),
      );
      assert.equal(pinned.status, 200);
      assert.equal(
        V2SubnetResultSchema.parse(await pinned.json()).subnet.generation
          .netuid,
        405,
      );
      const current = await application().fetch(
        new Request(`${origin}/api/v2/networks/directory/subnets?limit=200`),
      );
      const latest = V2SubnetListSchema.parse(await current.json());
      assert.equal(latest.snapshot.publication_id, directoryBlockPublication);
      assert.equal(latest.ecosystem.publication_id, newerDirectoryPublication);
      assert.deepEqual(
        latest.subnets.map((subnet) => subnet.generation.netuid),
        [0, 1000],
      );

      for (const [after, expected] of [
        [0, [1]],
        [405, []],
      ] as const) {
        const page = await application().fetch(
          new Request(
            `${origin}/api/v2/networks/directory/subnets?publication_id=${directoryPublication}&after=${after}&limit=1`,
          ),
        );
        assert.equal(page.status, 200);
        const value = V2SubnetListSchema.parse(await page.json());
        assert.deepEqual(
          value.subnets.map((subnet) => subnet.generation.netuid),
          expected,
        );
        assert.equal(value.next_after, after === 0 ? 1 : null);
      }
    });

    it("refuses unbound cursors before reads across all transports", async () => {
      const before = calls.length;
      const rest = await application().fetch(
        new Request(`${origin}/api/v2/networks/fixture/subnets?after=0`),
      );
      assert.equal(rest.status, 400);
      assert.equal(
        errorResponse.parse(await rest.json()).error.code,
        "invalid_input",
      );
      const mcp = await mcpRequest({
        jsonrpc: "2.0",
        id: ++mcpRequestId,
        method: "tools/call",
        params: {
          name: "list_subnets",
          arguments: { network: "fixture", after: 0 },
        },
      });
      assert.equal(mcp.status, 200);
      assert.equal(
        z
          .object({ result: z.object({ isError: z.literal(true) }) })
          .parse(await mcp.json()).result.isError,
        true,
      );
      const graphql = await application().fetch(
        post("/graphql", {
          query: `{ list_subnets(input:{network:"fixture",after:0}) { next_after } }`,
        }),
      );
      assert.equal(graphql.status, 200);
      assert.ok(graphResponse.parse(await graphql.json()).errors?.length);
      assert.equal(calls.length, before);
    });

    it("never falls back from unavailable, incomplete or raw-ineligible exact publications", async () => {
      assert.ok(admin);
      const url = (id: string) =>
        `${origin}/api/v2/networks/directory/subnets?publication_id=${id}&after=0`;
      const missing = await application().fetch(
        new Request(url("9".repeat(64))),
      );
      assert.equal(missing.status, 503);
      assert.equal(
        errorResponse.parse(await missing.json()).error.code,
        "data_unavailable",
      );
      for (const fault of [
        "incomplete",
        "raw_ineligible",
        "coverage",
      ] as const) {
        try {
          await transaction(async (client) => {
            if (fault === "incomplete")
              await client.query(
                "UPDATE registry.fixture_ecosystem_admissions SET fixture_eligible=false WHERE publication_id=$1",
                [directoryPublication],
              );
            else if (fault === "raw_ineligible")
              await client.query(
                "UPDATE chain.raw_objects SET integrity_verified=false WHERE digest=$1",
                [digest("directory-raw")],
              );
            else
              await client.query(
                "UPDATE ops.publications SET registry_expected_netuids=ARRAY[0,1] WHERE publication_id=$1",
                [directoryPublication],
              );
          });
          const before = calls.length;
          const response = await application().fetch(
            new Request(url(directoryPublication)),
          );
          assert.equal(response.status, 503);
          assert.equal(
            calls.length,
            before + 1,
            "No page read or latest-publication retry is permitted",
          );
          assert.deepEqual(calls.at(-1)!.values, [
            "directory",
            directoryPublication,
          ]);
        } finally {
          await transaction(async (client) => {
            await client.query(
              "UPDATE ops.publications SET registry_expected_netuids=$2::integer[] WHERE publication_id=$1",
              [directoryPublication, directoryNetuids],
            );
            await client.query(
              "UPDATE registry.fixture_ecosystem_admissions SET fixture_eligible=true WHERE publication_id=$1",
              [directoryPublication],
            );
            await client.query(
              "UPDATE chain.raw_objects SET integrity_verified=true WHERE digest=$1",
              [digest("directory-raw")],
            );
          });
        }
      }
    });

    it("executes actual keyword discovery, exact schema retrieval and effect-aware instructions", async () => {
      const search = await application().fetch(
        new Request(
          `${origin}/api/v2/networks/fixture/services/search?task=image&limit=5`,
        ),
      );
      assert.equal(search.status, 200);
      const found = V2ServiceDiscoverySchema.parse(await search.json());
      assert.equal(found.coverage.reportable_subnets, 3);
      assert.equal(found.coverage.observed_subnets, 1);
      assert.equal(found.results.length, 1);
      assert.equal(found.results[0].subnet.generation.netuid, 200);
      assert.equal(found.results[0].service.name, "Current image inference");
      const captured = await tool(
        "get_api_schema",
        { network: "fixture", netuid: 200, service_id: "inference" },
        V2CapturedServiceSchema,
      );
      assert.equal(captured.result.structuredContent.document_json, schemaJson);
      assert.equal(
        captured.result.structuredContent.digest,
        digest(schemaJson),
      );
      const instructions = await tool(
        "how_do_i_call",
        { network: "fixture", netuid: 200 },
        V2CallInstructionsSchema,
      );
      assert.deepEqual(
        instructions.result.structuredContent.instructions.map(
          (entry: { automatic_verification_allowed: boolean }) =>
            entry.automatic_verification_allowed,
        ),
        [true, false],
      );
      const unknown = await application().fetch(
        new Request(`${origin}/api/v2/networks/fixture/subnets/0/services`),
      );
      assert.equal(unknown.status, 200);
      assert.equal(
        V2SubnetServicesSchema.parse(await unknown.json()).catalog.status,
        "unobserved",
      );
    });

    it("proves the serving role cannot write or elevate and preserves records after denial", async () => {
      assert.ok(reader);
      // A superuser session can SET ROLE despite its current effective role. Pin
      // session authorization too before checking the standalone serving identity.
      await reader.query("SET SESSION AUTHORIZATION metagraphed_serve");
      for (const sql of [
        "DELETE FROM registry.service_catalogs",
        "UPDATE chain.networks SET genesis_hash=genesis_hash",
        "SET ROLE metagraphed_ingest",
        "SET ROLE metagraphed_owner",
        "SELECT * FROM registry.fixture_ecosystem_admissions",
        "UPDATE registry.fixture_ecosystem_admissions SET fixture_eligible=true",
        "SELECT pg_read_file('/etc/passwd')",
      ])
        await assert.rejects(reader.query(sql), { code: "42501" });
      assert.equal(
        (
          await reader.query(
            "SELECT count(*)::integer AS count FROM registry.service_catalogs",
          )
        ).rows[0].count,
        2,
      );
    });

    it("rejects an oversized catalog before the JSON aggregate executes", async () => {
      await transaction(async (client) => {
        const id = "3".repeat(64);
        await client.query(
          `INSERT INTO registry.service_catalogs
        (catalog_id,network_id,netuid,registered_at_block,registration_counter,chain_publication_id,observed_at,published_at,expires_at,producer_revision,expected_service_ids)
        VALUES($1,'fixture',200,40,$5,$2,$3,$3,$3::timestamptz+interval '1 day',$4,
          ARRAY(SELECT 'service-'||lpad(n::text,3,'0') FROM generate_series(1,16) n))`,
          [id, ecosystemPublication, at, "d".repeat(40), currentCounter],
        );
        const oversizedOperations = Array.from({ length: 4 }, (_, i) => ({
          ...operations[0],
          operation_id: `read-${i}`,
          example_json: JSON.stringify({ value: "x".repeat(12000) }),
        }));
        const definition = await addDefinition(client, {
          ...serviceContent("Large service"),
          description: "Image inference",
          base_url: "https://example.com",
          operations: oversizedOperations,
        });
        await client.query(
          `INSERT INTO registry.service_versions
        (catalog_id,network_id,netuid,registered_at_block,registration_counter,service_id,definition_id,schema_capture_id,public_safe)
        SELECT $1,'fixture',200,40,$3,'service-'||lpad(n::text,3,'0'),$2,NULL,true
        FROM generate_series(1,16) n`,
          [id, definition, currentCounter],
        );
        const stored = await client.query(
          `SELECT count(*)::integer AS memberships,count(DISTINCT definition_id)::integer AS definitions
          FROM registry.service_versions WHERE catalog_id=$1`,
          [id],
        );
        assert.deepEqual(stored.rows, [{ memberships: 16, definitions: 1 }]);
      });
      const response = await application().fetch(
        new Request(`${origin}/api/v2/networks/fixture/subnets/200/services`),
      );
      assert.equal(response.status, 503);
      assert.equal(
        errorResponse.parse(await response.json()).error.code,
        "data_unavailable",
      );
      const captured = calls.findLast((call) =>
        call.sql.startsWith("WITH selected_catalog AS MATERIALIZED"),
      );
      assert.ok(captured, "The actual catalog SQL must execute");
      assert.ok(admin);
      const explained = await admin.query(
        `EXPLAIN (ANALYZE,VERBOSE,FORMAT JSON) ${captured.sql}`,
        captured.values,
      );
      const nodes: Record<string, unknown>[] = [];
      const pending: unknown[] = [explained.rows[0]["QUERY PLAN"]];
      while (pending.length) {
        const item = pending.pop();
        if (Array.isArray(item)) pending.push(...item);
        else if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          nodes.push(record);
          pending.push(...Object.values(record));
        }
      }
      const aggregates = nodes.filter(
        (node) =>
          node["Node Type"] === "Aggregate" &&
          Array.isArray(node.Output) &&
          node.Output.some((output) => String(output).includes("jsonb_agg")),
      );
      assert.ok(
        aggregates.length > 0,
        "Explain must expose the payload aggregation plan",
      );
      assert.ok(
        aggregates.every((node) => node["Actual Loops"] === 0),
        "Oversized payload aggregation must never execute",
      );
    });

    it("pins discovery, catalogs, instructions and schemas across same-netuid re-registration", async () => {
      const replacementPublication = digest(
        "replacement-directory-publication",
      );
      const originalCatalog = digest("original-directory-catalog");
      const replacementCatalog = digest("replacement-directory-catalog");
      await transaction(async (client) => {
        await addDirectoryPublication(
          client,
          replacementPublication,
          [0, 200, 4095],
          42,
          "7",
        );
        for (const [
          selectedPublication,
          selectedCatalog,
          registration,
          registrationCounter,
          name,
        ] of [
          [
            directoryPublication,
            originalCatalog,
            0,
            "0",
            "Original registration inference",
          ],
          [
            replacementPublication,
            replacementCatalog,
            42,
            "7",
            "Replacement registration inference",
          ],
        ] as const) {
          const selectedCapture = digest(
            `directory-capture-${registrationCounter}`,
          );
          await client.query(
            `INSERT INTO registry.schema_captures
            (capture_id,network_id,netuid,registered_at_block,registration_counter,service_id,digest,source_url,observed_at,public_safe)
            VALUES($1,'directory',200,$2,$5,'inference',$3,'https://example.com/openapi.json',$4,true)`,
            [
              selectedCapture,
              registration,
              digest(schemaJson),
              at,
              registrationCounter,
            ],
          );
          await client.query(
            `INSERT INTO registry.service_catalogs
            (catalog_id,network_id,netuid,registered_at_block,registration_counter,chain_publication_id,observed_at,published_at,expires_at,producer_revision,expected_service_ids)
            VALUES($1,'directory',200,$2,$6,$3,$4,$4,$4::timestamptz+interval '1 day',$5,ARRAY['inference'])`,
            [
              selectedCatalog,
              registration,
              selectedPublication,
              at,
              "c".repeat(40),
              registrationCounter,
            ],
          );
          const definition = await addDefinition(client, serviceContent(name));
          await client.query(
            `INSERT INTO registry.service_versions
            (catalog_id,network_id,netuid,registered_at_block,registration_counter,service_id,definition_id,schema_capture_id,public_safe)
            VALUES($1,'directory',200,$2,$5,'inference',$3,$4,true)`,
            [
              selectedCatalog,
              registration,
              definition,
              selectedCapture,
              registrationCounter,
            ],
          );
          await client.query(
            `INSERT INTO registry.service_verifications
            (verification_id,catalog_id,service_id,operation_id,status,observed_at,expires_at)
            VALUES($1,$2,'inference','models','verified',$3,$3::timestamptz+interval '1 day')`,
            [
              digest(`directory-verification-${registration}`),
              selectedCatalog,
              at,
            ],
          );
        }
      });
      const pinned = `publication_id=${directoryPublication}&catalog_id=${originalCatalog}`;
      const selected = {
        network: "directory",
        netuid: 200,
        publication_id: directoryPublication,
        catalog_id: originalCatalog,
      };
      const journeys = [
        {
          name: "list_subnet_apis",
          path: `/subnets/200/services?${pinned}`,
          args: selected,
          schema: V2SubnetServicesSchema,
        },
        {
          name: "how_do_i_call",
          path: `/subnets/200/instructions?${pinned}`,
          args: selected,
          schema: V2CallInstructionsSchema,
        },
        {
          name: "get_api_schema",
          path: `/subnets/200/services/inference/schema?${pinned}`,
          args: { ...selected, service_id: "inference" },
          schema: V2CapturedServiceSchema,
        },
      ] as const;
      for (const journey of journeys) {
        const response = await application().fetch(
          new Request(`${origin}/api/v2/networks/directory${journey.path}`),
        );
        assert.equal(response.status, 200);
        const value = journey.schema.parse(await response.json());
        assert.equal(value.snapshot.publication_id, directoryBlockPublication);
        assert.equal(value.ecosystem.publication_id, directoryPublication);
        assert.equal(value.subnet.generation.registration_counter, "0");
        assert.equal(value.catalog.catalog_id, originalCatalog);
        const fromTool = await tool(journey.name, journey.args, journey.schema);
        assert.deepEqual(fromTool.result.structuredContent, value);
      }
      const searchPath = `/api/v2/networks/directory/services/search?task=inference&publication_id=${directoryPublication}`;
      const searchResponse = await application().fetch(
        new Request(origin + searchPath),
      );
      assert.equal(searchResponse.status, 200);
      const found = V2ServiceDiscoverySchema.parse(await searchResponse.json());
      assert.equal(found.snapshot.publication_id, directoryBlockPublication);
      assert.equal(found.ecosystem.publication_id, directoryPublication);
      assert.equal(found.coverage.reportable_subnets, 406);
      assert.equal(found.results.length, 1);
      assert.equal(
        found.results[0].subnet.generation.registration_counter,
        "0",
      );
      assert.equal(found.results[0].catalog.catalog_id, originalCatalog);
      assert.equal(
        found.results[0].service.name,
        "Original registration inference",
      );
      assert.equal(
        found.results[0].service.verification?.verification_id,
        digest("directory-verification-0"),
      );
      const verification = found.results[0].service.verification;
      assert.ok(verification);
      assert.equal(Date.parse(verification.observed_at), Date.parse(at));
      const toolSearch = await tool(
        "find_subnet_for_task",
        {
          network: "directory",
          task: "inference",
          publication_id: directoryPublication,
        },
        V2ServiceDiscoverySchema,
      );
      assert.deepEqual(toolSearch.result.structuredContent, found);
      const graph = await application().fetch(
        post("/api/v2/graphql", {
          query: `{
        list_subnet_apis(input:{network:"directory",netuid:200,publication_id:"${directoryPublication}",catalog_id:"${originalCatalog}"}) { snapshot { publication_id } subnet { generation { registration_counter } } catalog { catalog_id } }
        how_do_i_call(input:{network:"directory",netuid:200,publication_id:"${directoryPublication}",catalog_id:"${originalCatalog}"}) { snapshot { publication_id } catalog { catalog_id } instructions { authorization_required } }
        get_api_schema(input:{network:"directory",netuid:200,service_id:"inference",publication_id:"${directoryPublication}",catalog_id:"${originalCatalog}"}) { snapshot { publication_id } catalog { catalog_id } document_json }
        find_subnet_for_task(input:{network:"directory",task:"inference",publication_id:"${directoryPublication}"}) { snapshot { publication_id } results { subnet { generation { registration_counter } } catalog { catalog_id } } }
      }`,
        }),
      );
      assert.equal(graph.status, 200);
      const graphBody = graphResponse.parse(await graph.json());
      assert.equal(graphBody.errors, undefined);
      assert.deepEqual(graphBody.data.list_subnet_apis, {
        snapshot: { publication_id: directoryBlockPublication },
        subnet: { generation: { registration_counter: "0" } },
        catalog: { catalog_id: originalCatalog },
      });
      assert.deepEqual(graphBody.data.how_do_i_call, {
        snapshot: { publication_id: directoryBlockPublication },
        catalog: { catalog_id: originalCatalog },
        instructions: [
          { authorization_required: false },
          { authorization_required: true },
        ],
      });
      assert.deepEqual(graphBody.data.get_api_schema, {
        snapshot: { publication_id: directoryBlockPublication },
        catalog: { catalog_id: originalCatalog },
        document_json: schemaJson,
      });
      assert.deepEqual(graphBody.data.find_subnet_for_task, {
        snapshot: { publication_id: directoryBlockPublication },
        results: [
          {
            subnet: { generation: { registration_counter: "0" } },
            catalog: { catalog_id: originalCatalog },
          },
        ],
      });
      const latest = await application().fetch(
        new Request(`${origin}/api/v2/networks/directory/subnets/200/services`),
      );
      const current = V2SubnetServicesSchema.parse(await latest.json());
      assert.equal(current.snapshot.publication_id, directoryBlockPublication);
      assert.equal(current.ecosystem.publication_id, replacementPublication);
      assert.equal(current.subnet.generation.registration_counter, "7");
      assert.equal(current.subnet.current_registration_block.value, 42);
      assert.equal(current.catalog.catalog_id, replacementCatalog);
      for (const netuid of [0, 4095]) {
        const response = await application().fetch(
          new Request(
            `${origin}/api/v2/networks/directory/subnets/${netuid}/services?publication_id=${replacementPublication}`,
          ),
        );
        assert.equal(response.status, 200);
        const value = V2SubnetServicesSchema.parse(await response.json());
        assert.equal(value.subnet.generation.netuid, netuid);
        assert.equal(value.catalog.status, "unobserved");
        if (netuid === 4095) {
          assert.equal(
            value.subnet.generation.registration_counter,
            "18446744073709551614",
          );
          assert.equal(value.subnet.lifecycle, "dissolving");
          assert.equal(value.subnet.operational, false);
          assert.equal(value.subnet.mechanism_availability, "current");
          assert.deepEqual(value.subnet.mechanism_count, {
            value: 16,
            source: "stored",
          });
          assert.deepEqual(value.subnet.mechanisms.at(-1), {
            mechanism_id: 15,
            storage_index: 65535,
          });
        }
      }
      for (const journey of journeys) {
        const mixed = await application().fetch(
          new Request(
            `${origin}/api/v2/networks/directory${journey.path.replace(originalCatalog, replacementCatalog)}`,
          ),
        );
        assert.equal(mixed.status, 404);
        assert.equal(
          errorResponse.parse(await mixed.json()).error.code,
          "not_found",
        );
      }
      for (const path of [
        searchPath,
        ...journeys.map(
          (journey) => `/api/v2/networks/directory${journey.path}`,
        ),
      ]) {
        const before = calls.length;
        const bad = await application().fetch(
          new Request(origin + path.replace(directoryPublication, "bad")),
        );
        assert.equal(bad.status, 400);
        assert.equal(calls.length, before);
        const missing = await application().fetch(
          new Request(
            origin +
              path.replace(
                directoryPublication,
                digest("missing-directory-publication"),
              ),
          ),
        );
        assert.equal(missing.status, 503);
        assert.equal(calls.length, before + 1);
      }
      try {
        await transaction((client) =>
          client
            .query(
              "UPDATE registry.fixture_ecosystem_admissions SET fixture_eligible=false WHERE publication_id=$1",
              [directoryPublication],
            )
            .then(() => {}),
        );
        for (const path of [
          searchPath,
          ...journeys.map(
            (journey) => `/api/v2/networks/directory${journey.path}`,
          ),
        ]) {
          const before = calls.length;
          const unavailable = await application().fetch(
            new Request(origin + path),
          );
          assert.equal(unavailable.status, 503);
          assert.equal(calls.length, before + 1);
          assert.deepEqual(calls.at(-1)!.values, [
            "directory",
            directoryPublication,
          ]);
        }
      } finally {
        await transaction(async (client) => {
          await client.query(
            "UPDATE ops.publications SET registry_expected_netuids=$2::integer[] WHERE publication_id=$1",
            [directoryPublication, directoryNetuids],
          );
          await client.query(
            "UPDATE registry.fixture_ecosystem_admissions SET fixture_eligible=true WHERE publication_id=$1",
            [directoryPublication],
          );
        });
      }
    });

    it("never borrows an old catalog for a new ecosystem with the same baseline counter and height", async () => {
      const selectedPublication = digest("same-baseline-new-ecosystem");
      const originalCatalog = digest("original-directory-catalog");
      await transaction((client) =>
        addDirectoryPublication(client, selectedPublication, [0, 200], 0, "0"),
      );
      try {
        const path = `${origin}/api/v2/networks/directory/subnets/200/services`;
        const response = await application().fetch(
          new Request(`${path}?publication_id=${selectedPublication}`),
        );
        assert.equal(response.status, 200);
        const selected = V2SubnetServicesSchema.parse(await response.json());
        assert.equal(selected.ecosystem.publication_id, selectedPublication);
        assert.equal(selected.subnet.generation.registration_counter, "0");
        assert.equal(selected.subnet.current_registration_block.value, 0);
        assert.equal(selected.subnet.baseline_history_unqualified, true);
        assert.equal(selected.catalog.status, "unobserved");
        assert.deepEqual(selected.services, []);
        const fromTool = await tool(
          "list_subnet_apis",
          {
            network: "directory",
            netuid: 200,
            publication_id: selectedPublication,
          },
          V2SubnetServicesSchema,
        );
        assert.deepEqual(fromTool.result.structuredContent, selected);
        const mixed = await application().fetch(
          new Request(
            `${path}?publication_id=${selectedPublication}&catalog_id=${originalCatalog}`,
          ),
        );
        assert.equal(mixed.status, 404);
        assert.equal(
          errorResponse.parse(await mixed.json()).error.code,
          "not_found",
        );
        const original = await application().fetch(
          new Request(
            `${path}?publication_id=${directoryPublication}&catalog_id=${originalCatalog}`,
          ),
        );
        assert.equal(original.status, 200);
        const preserved = V2SubnetServicesSchema.parse(await original.json());
        assert.deepEqual(preserved.subnet, selected.subnet);
        assert.equal(preserved.ecosystem.publication_id, directoryPublication);
        assert.equal(preserved.catalog.catalog_id, originalCatalog);
        assert.equal(
          preserved.services[0].name,
          "Original registration inference",
        );
      } finally {
        await transaction(async (client) => {
          await client.query(
            "UPDATE registry.fixture_ecosystem_admissions SET fixture_eligible=false WHERE publication_id=$1",
            [selectedPublication],
          );
        });
      }
    });

    it("never hides archival memberships while qualifying a normalized catalog", async () => {
      const archived = digest("archival-definition");
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO registry.service_definitions
          (definition_id,encoding,name,description,kind,base_url,source_urls,authentication,operations)
          SELECT $1,'legacy-membership-v1',name,description,kind,base_url,source_urls,authentication,operations
          FROM registry.service_definitions WHERE definition_id=$2`,
          [
            archived,
            serviceDefinitionDigest(serviceContent("Current image inference")),
          ],
        );
      });
      const inventories = [
        [],
        ["inference"],
        ["inference", "legacy"],
        ["legacy"],
      ];
      for (const [index, expected] of inventories.entries()) {
        const id = digest(`archival-membership-${index}`);
        await transaction(async (client) => {
          await client.query(
            `INSERT INTO registry.service_catalogs
            (catalog_id,network_id,netuid,registered_at_block,registration_counter,chain_publication_id,observed_at,published_at,expires_at,producer_revision,expected_service_ids)
            VALUES($1,'fixture',200,40,$2,$3,$4,$4,$4::timestamptz+interval '1 day',$5,$6::text[])`,
            [
              id,
              currentCounter,
              ecosystemPublication,
              at,
              "c".repeat(40),
              expected,
            ],
          );
          if (expected.includes("inference"))
            await addService(client, id, "Current image inference");
          await client.query(
            `INSERT INTO registry.service_versions
            (catalog_id,network_id,netuid,registered_at_block,registration_counter,service_id,definition_id,schema_capture_id,public_safe)
            VALUES($1,'fixture',200,40,$2,'legacy',$3,NULL,true)`,
            [id, currentCounter, archived],
          );
        });
        const response = await application().fetch(
          new Request(
            `${origin}/api/v2/networks/fixture/subnets/200/services?catalog_id=${id}`,
          ),
        );
        assert.equal(response.status, 503, `unsupported inventory ${index}`);
        assert.equal(
          errorResponse.parse(await response.json()).error.code,
          "data_unavailable",
        );
        const discovery = (
          await tool(
            "find_subnet_for_task",
            { network: "fixture", task: "inference" },
            V2ServiceDiscoverySchema,
          )
        ).result.structuredContent;
        assert.equal(discovery.coverage.observed_subnets, 1);
        assert.equal(discovery.coverage.complete_subnets, 0);
        assert.equal(discovery.coverage.subnets_with_services, 0);
        assert.deepEqual(discovery.results, []);
      }
      const empty = digest("explicit-empty-normalized-catalog");
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO registry.service_catalogs
          (catalog_id,network_id,netuid,registered_at_block,registration_counter,chain_publication_id,observed_at,published_at,expires_at,producer_revision,expected_service_ids)
          VALUES($1,'fixture',200,40,$2,$3,$4,$4,$4::timestamptz+interval '1 day',$5,ARRAY[]::text[])`,
          [empty, currentCounter, ecosystemPublication, at, "c".repeat(40)],
        );
      });
      const response = await application().fetch(
        new Request(
          `${origin}/api/v2/networks/fixture/subnets/200/services?catalog_id=${empty}`,
        ),
      );
      assert.equal(response.status, 200);
      const observed = V2SubnetServicesSchema.parse(await response.json());
      assert.equal(observed.catalog.status, "current");
      assert.deepEqual(observed.services, []);
      assert.ok(admin);
      const documents = await admin.query(
        "SELECT count(*)::integer AS documents FROM registry.schema_documents WHERE digest=$1",
        [digest(schemaJson)],
      );
      assert.equal(documents.rows[0].documents, 1);
      const captures = await admin.query(
        "SELECT count(*)::integer AS captures FROM registry.schema_captures WHERE digest=$1",
        [digest(schemaJson)],
      );
      assert.ok(captures.rows[0].captures >= 2);
    });
  },
);
