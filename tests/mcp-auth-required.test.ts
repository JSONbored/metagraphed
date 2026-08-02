// #9072: the auth precondition published in tools/list must equal the one the
// handlers actually enforce.
//
// Three tools refuse anonymous callers (the #9009 surface-credential store,
// which needs an identity to bind a stored secret to). Before #9072 nothing
// published that, so a client could only discover it by calling a tool and
// being refused -- and an agent that has to fail to learn a precondition
// usually just stops rather than going off to authenticate.
//
// The declaration in src/mcp-server.ts is a hand-written set of names, which is
// the honest shape: "does this code path eventually reach an auth check" is not
// a property to infer from a function body and then publish as a contract. What
// makes that safe is THIS file. It does not read the declaration and check it
// against another list -- it PROBES every advertised tool anonymously and
// compares what the server actually did against what it advertised, in both
// directions:
//
//   - enforced but not declared -> a real precondition no client can discover;
//   - declared but not enforced -> the card tells clients to authenticate for
//     nothing, which is the ADR 0027 defect (a discovery document that
//     disagrees with the endpoint) in miniature.
//
// Either direction fails the build.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  AUTH_REQUIRED_TOOL_NAMES,
  MCP_AUTH_REQUIRED_META_KEY,
  handleMcpRequest,
  listToolDefinitions,
} from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

// A deployment with the credential store PROVISIONED but the caller anonymous.
// That distinction is the whole point: requireCredentialStore checks identity
// first and only then whether the store is configured, so an unprovisioned env
// would fail with `surface_credential_store_unavailable` and hide the auth
// requirement this test exists to detect.
const ENV = {
  SURFACE_CREDENTIALS: {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [] }),
  },
  SURFACE_CREDENTIAL_ENCRYPTION_KEY: "0".repeat(64),
} as unknown as Row;

/** Call one tool with NO Authorization and no executionCtx props, i.e. as a
 * fully anonymous caller, and return its error code (or null on success). */
async function anonymousErrorCode(name: string): Promise<string | null> {
  const originalFetch = globalThis.fetch;
  // Nothing may leave the process during a 200-plus-tool sweep. Any tool that
  // does reach for the network gets a benign JSON 200 rather than a real call.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  try {
    const response = await handleMcpRequest(
      new Request("https://metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          // Empty arguments on purpose: this asks "what does the server do
          // BEFORE it has anything to work with", which is exactly where an
          // auth gate belongs. requireCredentialStore is the first statement
          // in each credential handler, so it is reached here.
          params: { name, arguments: {} },
        }),
      }),
      ENV as unknown as Env,
      { executionCtx: undefined },
    );
    const body = (await response.json()) as Row;
    const result = body.result as Row | undefined;
    const structured = result?.structuredContent as Row | undefined;
    const error = structured?.error as Row | undefined;
    const code = error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    // A tool that throws for an unrelated reason (missing binding, bad args)
    // is simply not an auth refusal.
    return null;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("MCP auth requirement: declared == enforced (#9072)", () => {
  test("every tool that refuses anonymous callers is declared, and vice versa", async () => {
    const advertised = listToolDefinitions();
    assert.ok(advertised.length > 100, "expected the full tool catalogue");

    const enforced = new Set<string>();
    for (const tool of advertised) {
      if ((await anonymousErrorCode(tool.name as string)) === "auth_required") {
        enforced.add(tool.name as string);
      }
    }

    const declared = new Set(AUTH_REQUIRED_TOOL_NAMES);
    const enforcedNotDeclared = [...enforced].filter((n) => !declared.has(n));
    const declaredNotEnforced = [...declared].filter((n) => !enforced.has(n));

    assert.deepEqual(
      enforcedNotDeclared,
      [],
      "these tools refuse anonymous callers but tools/list does not say so, " +
        "so a client can only discover the precondition by being refused",
    );
    assert.deepEqual(
      declaredNotEnforced,
      [],
      "these tools are advertised as requiring auth but serve anonymous " +
        "callers, so the card tells clients to authenticate for nothing",
    );
    // Guards against the whole sweep silently degrading to "nothing enforces
    // auth", which would make both assertions above pass vacuously.
    assert.ok(enforced.size > 0, "no tool enforced auth -- probe is broken");
  });

  test("tools/list publishes the flag under _meta, never inside annotations", async () => {
    const advertised = listToolDefinitions();
    const flagged = advertised.filter(
      (tool) =>
        ((tool as Row)._meta as Row | undefined)?.[
          MCP_AUTH_REQUIRED_META_KEY
        ] === true,
    );
    assert.deepEqual(
      new Set(flagged.map((t) => t.name)),
      new Set(AUTH_REQUIRED_TOOL_NAMES),
    );

    for (const tool of advertised) {
      // `annotations` is the MCP spec's CLOSED vocabulary. Publishing our own
      // key inside it would be asserting something the spec does not define.
      assert.deepEqual(
        Object.keys(tool.annotations as Row).sort(),
        [
          "destructiveHint",
          "idempotentHint",
          "openWorldHint",
          "readOnlyHint",
        ].sort(),
        `${tool.name} annotations must stay the spec's closed vocabulary`,
      );
      // A public tool carries no flag at all -- an absent key is the natural
      // "no requirement", rather than `false` on 200-plus tools.
      if (!AUTH_REQUIRED_TOOL_NAMES.has(tool.name as string)) {
        assert.equal(
          (tool as Row)._meta,
          undefined,
          `${tool.name} should not carry an auth _meta block`,
        );
      }
    }
  });
});
