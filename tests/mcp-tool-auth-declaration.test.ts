// #9070: the published "this tool needs authentication" flag must equal what
// the server actually does — proven by probing every tool anonymously, not by
// reading the list.
//
// ADR 0027 clause 3 said authentication buys throughput, not reach. #9009 made
// that partly false: the credential store's three tools need an identity to
// bind a stored secret to. Until this landed, the requirement lived only inside
// `requireCredentialStore`, so a client could only discover it by calling a
// tool and being refused — and an agent that has to fail to learn a
// precondition usually just stops rather than going to authenticate.
//
// The declaration is a hand-written set of three names, which is the honest
// shape: "does this code path eventually reach an auth check" is not something
// to derive from a function body and then publish as a contract. What makes it
// safe is that it cannot go stale — this file fails if the declared set and the
// enforced set differ in EITHER direction:
//
//   * a tool that refuses anonymous callers but is not declared -> clients
//     cannot discover a real precondition;
//   * a tool that is declared but serves anonymous callers -> the server card
//     tells clients to authenticate for nothing, which is the same class of
//     defect as the `authentication: "none"` drift ADR 0027 was written about.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  AUTH_REQUIRED_TOOL_NAMES,
  handleMcpRequest,
  listToolDefinitions,
} from "../src/mcp-server.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

// The credential store needs BOTH halves provisioned, or it refuses every
// caller with `surface_credential_store_unavailable` regardless of identity —
// which would make an anonymous probe indistinguishable from an authenticated
// one. Provisioning it is what isolates the auth check as the thing under test.
function envWithCredentialStore() {
  const store = new Map<string, string>();
  return {
    ...(createLocalArtifactEnv() as unknown as Record<string, unknown>),
    METAGRAPH_CONTROL: {
      get: async (key: string) => {
        const raw = store.get(key);
        return raw ? JSON.parse(raw) : null;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async () => ({ keys: [], list_complete: true }),
    },
    MCP_SURFACE_CREDENTIAL_SECRET: "test-secret",
  } as unknown as Env;
}

async function anonymousErrorCode(
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const response = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    envWithCredentialStore(),
    // No executionCtx.props => no OAuth identity, and no Authorization header
    // => no mg_ key. This is exactly an anonymous caller.
    {},
  );
  const body = (await response.json()) as Row;
  return ((body?.result?.structuredContent as Row)?.error as Row)?.code ?? null;
}

/** Minimal arguments satisfying the tool's `required` keys, so the probe is
 * refused for lack of identity rather than for a missing argument. */
function minimalArgs(schema: Row): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of (schema?.required as string[]) ?? []) {
    const prop = (schema?.properties as Row)?.[key] as Row | undefined;
    const type = Array.isArray(prop?.type) ? prop?.type[0] : prop?.type;
    // A shape-valid surface id, so the probe reaches the auth gate rather than
    // stopping at the id-format check.
    args[key] = key.includes("surface_id")
      ? "sn-1-example-subnet-api"
      : type === "string"
        ? "x"
        : type === "object"
          ? { a: "b" }
          : 1;
  }
  return args;
}

describe("published auth requirement matches enforcement (#9070)", () => {
  test("every declared tool actually refuses an anonymous caller", async () => {
    assert.ok(AUTH_REQUIRED_TOOL_NAMES.size > 0, "nothing declared");
    const byName = new Map(
      (listToolDefinitions() as Row[]).map((def) => [def.name as string, def]),
    );

    for (const name of AUTH_REQUIRED_TOOL_NAMES) {
      const def = byName.get(name);
      assert.ok(def, `${name} is declared auth-required but is not registered`);
      const code = await anonymousErrorCode(
        name,
        minimalArgs(def.inputSchema as Row),
      );
      assert.equal(
        code,
        "auth_required",
        `${name} is published as auth-required but served an anonymous caller ` +
          `(got ${code ?? "success"}) — the declaration is telling clients to ` +
          `authenticate for nothing`,
      );
    }
  }, 60_000);

  test("no undeclared tool refuses an anonymous caller", async () => {
    const undeclared: string[] = [];

    for (const def of listToolDefinitions() as Row[]) {
      const name = def.name as string;
      if (AUTH_REQUIRED_TOOL_NAMES.has(name)) continue;
      const code = await anonymousErrorCode(
        name,
        minimalArgs(def.inputSchema as Row),
      );
      // `auth_required` from an UNDECLARED tool means a real precondition that
      // no client can discover without failing first.
      if (code === "auth_required") undeclared.push(name);
    }

    assert.deepEqual(
      undeclared,
      [],
      "these tools refuse anonymous callers but do not publish it, so the only " +
        "way to find out is to call one and be refused — add them to " +
        "AUTH_REQUIRED_TOOL_NAMES:\n" +
        undeclared.join("\n"),
    );
  }, 120_000);

  test("the flag rides in _meta, not in the spec's fixed annotation vocabulary", () => {
    for (const def of listToolDefinitions() as Row[]) {
      const declared = AUTH_REQUIRED_TOOL_NAMES.has(def.name as string);
      const meta = def._meta as Row | undefined;
      assert.equal(
        meta?.["metagraph.sh/auth_required"] === true,
        declared,
        `${def.name}: _meta auth flag disagrees with the declaration`,
      );
      // `annotations` is the MCP spec's own closed vocabulary; inventing a key
      // inside it would be publishing a claim the spec does not define.
      assert.ok(
        !Object.hasOwn(def.annotations as Row, "auth_required"),
        `${def.name}: auth belongs in _meta, not annotations`,
      );
    }
  });
});
