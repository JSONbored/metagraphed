import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  CONTRACTS_ARTIFACT,
  GET_CONTRACTS_INSTRUCTIONS,
  GET_CONTRACTS_MCP_TOOL,
  GET_CONTRACTS_OUTPUT_SCHEMA,
  contractsToolError,
  loadContracts,
} from "../src/contracts-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { assertValid } from "./helpers/assert-valid.ts";

type ReadArtifact = (env: Env, path: string) => Promise<StorageReadResult>;

const SAMPLE_CONTRACTS = {
  schema_version: 1,
  contract_version: "2026-07-03.2",
  generated_at: "2026-07-01T00:00:00.000Z",
  name: "Metagraphed public backend artifact contract",
  base_path: "/metagraph",
  primary_domain: "api.metagraph.sh",
  openapi_url: "/metagraph/openapi.json",
  type_definitions_url: "/metagraph/types.d.ts",
  notes: ["Native Bittensor chain data is canonical."],
  status_domain: null,
  // A REAL captured row for each (#10790): /api/v1/contracts has always served
  // `feeds` and `networks`, and `ContractsArtifactSchema` declared neither --
  // so this fixture, captured from production, was missing them too. One feed
  // is enough to exercise the entry shape.
  feeds: [
    {
      content_types: [
        "application/rss+xml",
        "application/atom+xml",
        "application/feed+json",
      ],
      description:
        'The site-wide "what changed" feed: subnets, surfaces, and coverage added, removed, renamed, or updated in the metagraphed registry, plus Bittensor runtime upgrade activity (#8702). Served as RSS 2.0, Atom 1.0, or JSON Feed 1.1 \u2014 append `.rss`/`.atom`/`.json`, or negotiate with the `Accept` header on the bare path. Use `?tag=upgrade` to narrow to runtime upgrades alone.',
      formats: ["rss", "atom", "json"],
      id: "feed-registry",
      kind: "registry",
      method: "GET",
      path: "/api/v1/feeds/registry",
      path_parameters: [],
      public: true,
      query_parameters: [
        {
          description:
            "Return only items carrying this tag (e.g. `upgrade`, `incident`, `subnet`). Exact match against the item's `tags` array.",
          name: "tag",
          schema: {
            maxLength: 100,
            type: "string",
          },
        },
        {
          description:
            "Inclusive lower bound on item timestamps, as an ISO-8601 date (`2026-06-01`, a whole UTC day) or date-time with an explicit offset. Malformed values are a 400, never silently ignored. Must not be later than the range's upper bound.",
          name: "since",
          schema: {
            type: "string",
          },
        },
        {
          description:
            "Inclusive upper bound, same format as `since`. A bare date covers the whole named UTC day. Must not be earlier than the range's lower bound.",
          name: "until",
          schema: {
            type: "string",
          },
        },
        {
          description: "Maximum items to return (1-50). Defaults to 50.",
          name: "limit",
          schema: {
            default: 50,
            maximum: 50,
            minimum: 1,
            type: "integer",
            "x-serving-bound": true,
          },
        },
      ],
    },
  ],
  networks: {
    aliases: ["finney", "local", "mainnet", "test", "testnet"],
    data_aliases: ["finney", "mainnet", "test", "testnet"],
    default: "mainnet",
    mainnet_only_route_count: 168,
    note: "Omit the network segment for mainnet. `finney` aliases `mainnet` and `test` aliases `testnet`. `local` is served but hosts no registry data \u2014 it returns a setup pointer for a self-run node.",
    path_form: "/api/v1/{network}/...",
  },
  // A real captured /api/v1/contracts row. #9796 derived get_contracts's
  // outputSchema from ContractsArtifactSchema, which types every entry; the
  // three-key stub only ever satisfied the open object the copy published.
  artifacts: [
    {
      content_type: "application/json",
      contract_version: "2026-07-03.2",
      description:
        "Public artifact contract metadata for metagraph.sh consumers.",
      id: "contracts",
      path: "/metagraph/contracts.json",
      retirement: null,
      schema_ref: "#/components/schemas/ContractsArtifact",
      status: "live",
      storage_tier: "dual",
    },
  ],
};

describe("contracts-mcp", () => {
  test("contractsToolError is shaped for MCP toolError handling", () => {
    const err = contractsToolError("not_found", "missing");
    assert.equal(err.code, "not_found");
    assert.equal(err.toolError, true);
    assert.equal(err.message, "missing");
  });

  test("loadContracts returns the baked artifact payload", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async (_env: Env, path: string) => ({
        ok: true,
        data: path === CONTRACTS_ARTIFACT ? SAMPLE_CONTRACTS : null,
      })) as ReadArtifact,
    };
    const out = (await loadContracts(ctx)) as Row;
    assert.equal(out.schema_version, 1);
    assert.equal(out.artifacts.length, 1);
    assert.equal(out.artifacts[0].id, "contracts");
  });

  test("loadContracts uses an injected readArtifact dep", async () => {
    const out = (await loadContracts(
      {
        env: mockEnv(),
        readArtifact: (async () => ({ ok: false })) as unknown as ReadArtifact,
      },
      {
        readArtifact: (async () => ({
          ok: true,
          data: { schema_version: 1, artifacts: [] },
        })) as unknown as ReadArtifact,
      },
    )) as Row;
    assert.deepEqual(out.artifacts, []);
  });

  test("loadContracts maps artifact_not_found to not_found", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({
        ok: false,
        code: "artifact_not_found",
      })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadContracts(ctx),
      (err: Row) =>
        err.code === "not_found" &&
        err.toolError === true &&
        /unavailable in this environment/.test(err.message),
    );
  });

  test("loadContracts surfaces other artifact failures with the path", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({
        ok: false,
        code: "artifact_timeout",
      })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadContracts(ctx),
      (err: Row) =>
        err.code === "artifact_timeout" && /contracts\.json/.test(err.message),
    );
  });

  test("loadContracts defaults code when the read result is bare", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({ ok: false })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadContracts(ctx),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(GET_CONTRACTS_MCP_TOOL.name, "get_contracts");
    assert.match(GET_CONTRACTS_INSTRUCTIONS, /get_contracts/);
    assert.deepEqual(
      // z.toJSONSchema()'s return type declares `properties` as optional (#8075).
      Object.keys(GET_CONTRACTS_MCP_TOOL.inputSchema.properties ?? {}),
      // The page its route publishes (#10605). This used to pin `[]`, from when
      // the tool took no arguments at all and the route it mirrors had no page
      // either; #10599 gave the route one, and the tool now passes it.
      ["limit", "cursor", "sort", "order"],
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(GET_CONTRACTS_OUTPUT_SCHEMA),
    );
  });

  test("the TOOL'S OWN RESPONSE validates against GET_CONTRACTS_OUTPUT_SCHEMA", () => {
    // The tool's answer, not the artifact behind it (#10790). `loadContracts`
    // returns the stored document and the MCP layer pages it, so the output
    // schema declares a `total`/`returned`/`limit`/`cursor`/`next_cursor` block
    // the artifact does not carry -- and validating the raw fixture against the
    // tool's schema asserted a shape no caller ever receives.
    const validate = new Ajv2020({ strict: false }).compile(
      GET_CONTRACTS_OUTPUT_SCHEMA,
    );
    assertValid(validate, {
      ...SAMPLE_CONTRACTS,
      total: SAMPLE_CONTRACTS.artifacts.length,
      returned: SAMPLE_CONTRACTS.artifacts.length,
      limit: 20,
      cursor: 0,
      next_cursor: null,
    });
  });

  test("MCP server exports wire get_contracts", () => {
    assert.match(MCP_INSTRUCTIONS, /get_contracts/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_contracts");
    assert.ok(tool);
    assert.equal(tool.title, GET_CONTRACTS_MCP_TOOL.title);
  });
});
