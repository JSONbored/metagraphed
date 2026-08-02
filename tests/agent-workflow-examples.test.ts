// #9091: execute the examples in public/agent-workflows.md instead of trusting
// them.
//
// That page is the front door -- the discovery -> schema -> call recipe an
// agent follows first -- and it carried 14 runnable curl blocks that nothing
// ran. One had already rotted: `get_api_schema` on `allways-api-health`
// returned not_found, because that surface has a fixture but no captured
// OpenAPI schema, so the recipe's own step 3 dead-ended on the id it used to
// demonstrate step 3.
//
// ── What this asserts, and what it refuses to ───────────────────────────────
//
// Not "every documented call returns data". It cannot: a good number of MCP
// tools need live bindings (tests/mcp-schema-enforcement.test.ts skips 74 of
// 210 for that reason), and asserting on live values would make this suite
// depend on production. So an environment-dependent failure is ALLOWED, by an
// explicit code list -- and every other failure is a real one.
//
// What it does assert is exactly what rots: the tool still exists, the
// arguments are still accepted, the route is still registered. A rename lands
// here before it lands on the page an agent reads.
//
// The markdown IS the fixture. An example added tomorrow is executed tomorrow,
// with nothing to register anywhere.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const DOC_PATH = "public/agent-workflows.md";
const doc = readFileSync(DOC_PATH, "utf8");
const env = createLocalArtifactEnv() as unknown as Env;
const TOOL_NAMES = new Set(
  listToolDefinitions().map((tool) => tool.name as string),
);

/**
 * Every surface in the committed registry, and the subset that publishes a
 * machine-readable contract.
 *
 * The REGISTRY, not `public/metagraph/schemas/index.json`. That index is a
 * network-capture cache the build reconciles in place, so a surface can drop
 * out of it because one probe failed -- an assertion against it would go red
 * for reasons that have nothing to do with this page. `kind: "openapi"` is
 * committed truth and is exactly the property `get_api_schema` needs.
 */
function registrySurfaces(): { all: Set<string>; schemaBacked: Set<string> } {
  const all = new Set<string>();
  const schemaBacked = new Set<string>();
  for (const file of readdirSync("registry/subnets")) {
    if (!file.endsWith(".json")) continue;
    const manifest = JSON.parse(
      readFileSync(`registry/subnets/${file}`, "utf8"),
    ) as { surfaces?: { id?: string; kind?: string }[] };
    for (const surface of manifest.surfaces ?? []) {
      if (!surface.id) continue;
      all.add(surface.id);
      if (surface.kind === "openapi") schemaBacked.add(surface.id);
    }
  }
  return { all, schemaBacked };
}

const SURFACES = registrySurfaces();

/** Tools whose `surface_id` argument must name a schema-publishing surface. */
const SCHEMA_REQUIRING_TOOLS = new Set(["get_api_schema"]);

/**
 * The one tool-error code that is always the page's fault.
 *
 * Inverted on purpose. Most MCP tools cannot complete without live bindings
 * and report `internal_error` here, so an allowlist of "acceptable" codes would
 * have to include that and would then excuse almost everything. The property
 * that survives a binding-less environment is narrower and is exactly the one
 * that rots: the server got as far as REJECTING THE ARGUMENTS. That only
 * happens when a parameter was renamed, dropped, or given a narrower enum --
 * i.e. when the documented call is wrong.
 *
 * Tool-name rot is caught separately, and deterministically, against the
 * registry itself.
 */
const DOCUMENTATION_ERROR_CODE = "invalid_params";

/** A parsed `curl` invocation from a documented shell block. */
interface DocumentedCall {
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * Pull every curl invocation out of the page's ```bash blocks.
 *
 * Line continuations are joined first so a multi-line curl is one command;
 * commands are then split on the `curl ` boundary, since a single block can
 * hold several (the schema/fixture pair does).
 */
function documentedCalls(markdown: string): DocumentedCall[] {
  const blocks = [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map(
    (match) => match[1].replace(/\\\n\s*/g, " "),
  );
  const calls: DocumentedCall[] = [];
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("curl ")) continue;
      const url = trimmed.match(/curl[^']*'([^']+)'/)?.[1];
      if (!url) continue;
      const headers: Record<string, string> = {};
      for (const [, header] of trimmed.matchAll(/-H '([^']+)'/g)) {
        const [name, ...rest] = header.split(":");
        headers[name.trim().toLowerCase()] = rest.join(":").trim();
      }
      calls.push({
        url,
        headers,
        body: trimmed.match(/-d '([\s\S]+?)'(?:\s|$)/)?.[1] ?? null,
      });
    }
  }
  return calls;
}

/**
 * A documented URL carrying a `{placeholder}` is a template, not a command.
 *
 * The ONLY skip rule, and the count is asserted below: a genuinely broken
 * command must not be able to hide behind "it's just an illustration".
 */
function isTemplate(call: DocumentedCall): boolean {
  return /\{[a-z_]+\}/.test(call.url);
}

const ALL_CALLS = documentedCalls(doc);
const TEMPLATE_CALLS = ALL_CALLS.filter(isTemplate);
const RUNNABLE_CALLS = ALL_CALLS.filter((call) => !isTemplate(call));
const MCP_CALLS = RUNNABLE_CALLS.filter((call) =>
  new URL(call.url).pathname.startsWith("/mcp"),
);
const REST_CALLS = RUNNABLE_CALLS.filter(
  (call) => !new URL(call.url).pathname.startsWith("/mcp"),
);

/**
 * The error code the Worker returns when NO ROUTE MATCHED — as opposed to
 * `artifact_not_found`, which means the route exists and this environment has
 * no data behind it.
 *
 * Both are 404, which is why the assertion below reads the code rather than
 * the status. Getting that wrong makes the test order-dependent: the local
 * artifact tier under `dist/metagraph-r2/` is populated as a side effect of
 * `tests/artifacts.test.ts`, this file sorts before it, and vitest runs files
 * in parallel anyway -- so a status-only check passes or fails depending on
 * which file won the race. Measured: with the tier absent,
 * `/api/v1/agent-catalog` 404s with `artifact_not_found`, while a genuinely
 * retired route 404s with `not_found`. Only the second is this page's problem.
 */
const NO_ROUTE_MATCHED_CODE = "not_found";

/** Statuses that mean the environment is degraded, never that the page is wrong. */
const ENVIRONMENT_STATUSES = new Set([500, 502, 503, 504]);

describe(`the examples in ${DOC_PATH} are executed, not assumed (#9091)`, () => {
  test("the page still carries runnable examples at all", () => {
    // A parser that silently matched nothing would make every assertion below
    // vacuously pass -- the classic way a docs test stops testing.
    assert.ok(
      RUNNABLE_CALLS.length >= 10,
      `expected the page to carry runnable curl examples, found ${RUNNABLE_CALLS.length}`,
    );
    assert.ok(MCP_CALLS.length >= 4);
    assert.ok(REST_CALLS.length >= 4);
  });

  test("only placeholder templates are skipped, and only the known ones", () => {
    // Pinned, so a new skip cannot appear without this line changing: the two
    // {surface_id} artifact-path illustrations.
    assert.deepEqual(TEMPLATE_CALLS.map((call) => call.url).sort(), [
      "https://api.metagraph.sh/metagraph/fixtures/{surface_id}.json",
      "https://api.metagraph.sh/metagraph/schemas/{surface_id}.json",
    ]);
  });

  describe("documented MCP calls", () => {
    for (const call of MCP_CALLS) {
      const request = JSON.parse(call.body ?? "{}") as Row;
      const name = ((request.params as Row)?.name ?? "<none>") as string;

      test(`${name} is a real tool whose documented arguments are accepted`, async () => {
        // Env-independent: a renamed or retired tool fails here whether or not
        // anything in this environment can actually run it.
        assert.ok(
          TOOL_NAMES.has(name),
          `${DOC_PATH} documents the MCP tool \`${name}\`, which the registry does not have`,
        );
        assert.equal(
          call.headers["content-type"],
          "application/json",
          "a documented MCP call must send content-type: application/json",
        );
        // Deterministic, from the committed registry -- this is the half the
        // dispatch below cannot check, because a binding-less environment
        // reports a missing surface and a missing artifact identically.
        const surfaceId = ((request.params as Row)?.arguments as Row)
          ?.surface_id as string | undefined;
        if (surfaceId) {
          assert.ok(
            SURFACES.all.has(surfaceId),
            `${DOC_PATH} names the surface \`${surfaceId}\`, which is not in the registry`,
          );
          if (SCHEMA_REQUIRING_TOOLS.has(name)) {
            // The exact defect that motivated #9091: the page demonstrated
            // get_api_schema on a subnet-api surface, which publishes no
            // contract, so the recipe's own step 3 returned not_found.
            assert.ok(
              SURFACES.schemaBacked.has(surfaceId),
              `${DOC_PATH} demonstrates \`${name}\` on \`${surfaceId}\`, which publishes no machine-readable contract (not an \`openapi\` surface) -- it will return not_found`,
            );
          }
        }
        const response = await handleMcpRequest(
          new Request(call.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: call.body as string,
          }),
          env,
          {},
        );
        const body = (await response.json()) as Row;
        // A transport-level error means the method or the envelope is wrong,
        // which no environment can excuse.
        assert.equal(
          body.error,
          undefined,
          `JSON-RPC error for ${name}: ${JSON.stringify(body.error)}`,
        );
        const result = body.result as Row;
        if (!result?.isError) return;
        const code = ((result.structuredContent as Row)?.error as Row)
          ?.code as string;
        assert.notEqual(
          code,
          DOCUMENTATION_ERROR_CODE,
          `${DOC_PATH} documents \`${name}\` with arguments the server rejects: ${JSON.stringify(result.content)}`,
        );
      });
    }
  });

  // Dispatched through the Worker rather than checked against API_ROUTES.
  // Serving is what the page promises, and three documented AI-native routes
  // (/ask, /search/semantic, /surfaces/{id}/verify) are served but not
  // registered in the contract at all -- a real defect, filed as #9092, and
  // not one this page's examples should be blamed for.
  describe("documented REST paths", () => {
    for (const call of REST_CALLS) {
      const { pathname, search } = new URL(call.url);

      test(`${pathname}${search} is served`, async () => {
        const response = await handleRequest(
          new Request(call.url, {
            method: call.body ? "POST" : "GET",
            headers: call.headers,
            ...(call.body ? { body: call.body } : {}),
          }),
          env,
          {},
        );
        if (ENVIRONMENT_STATUSES.has(response.status)) return;
        if (response.status < 400) return;
        const code = ((await response.json()) as Row)?.error as Row;
        assert.notEqual(
          code?.code,
          NO_ROUTE_MATCHED_CODE,
          `${DOC_PATH} documents ${pathname}${search}, which matches no API route (${response.status})`,
        );
      });
    }
  });
});
