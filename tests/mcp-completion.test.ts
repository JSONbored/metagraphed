// completion/complete — argument autocompletion (#9686).
//
// Before this, an agent filling in `netuid` on a prompt, or `{slug}` on
// metagraph://provider/{slug}, had to guess or call a list tool and read the
// result. The server already knows the answer; this is it saying so.
//
// WHAT THESE TESTS ARE CAREFUL ABOUT. Completion returns a list, and an empty
// list is a valid answer for an argument we cannot complete — which means a
// broken implementation that returns nothing for EVERYTHING also passes every
// "did it refuse?" assertion. So each completable case asserts real values
// came back, and the not-completable cases assert emptiness separately.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest, MCP_CAPABILITIES } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

/** Registry fixtures, injected the way the artifact readers expect. */
const SUBNETS = {
  subnets: [
    { netuid: 1, name: "Apex" },
    { netuid: 6, name: "Infinite Games" },
    { netuid: 64, name: "Chutes" },
    { netuid: 65, name: "Sixty-five" },
  ],
};
const PROVIDERS = {
  // The last row has no slug, for the same reason the schemas fixture has a
  // row with no id: these are generated artifacts, and a row that identifies
  // nothing must contribute nothing rather than an empty-string suggestion.
  providers: [
    { slug: "chutes" },
    { slug: "chutes-labs" },
    { slug: "opentensor" },
    { name: "Unslugged Provider" },
  ],
};
const SCHEMAS = {
  // The third row has NEITHER key. The index is a generated artifact, so a row
  // that identifies nothing is a real possibility, and completing to an empty
  // string would offer the caller a value that resolves to no resource.
  schemas: [
    { surface_id: "sn-64-chutes-openapi" },
    { id: "sn-6-openapi" },
    { content_type: "application/json" },
  ],
};

const deps = {
  readArtifact: async (_env: unknown, path: string) => {
    if (path.includes("subnets.json")) return { ok: true, data: SUBNETS };
    if (path.includes("providers.json")) return { ok: true, data: PROVIDERS };
    if (path.includes("schemas/index.json")) return { ok: true, data: SCHEMAS };
    return null;
  },
};

/** Drive one JSON-RPC message against the served path. */
async function rpc(body: unknown, injected: Row = deps) {
  const res = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    }),
    {} as unknown as Env,
    injected,
  );
  return (await res.json()) as Row;
}

/** Complete against a specific injected registry — used for the degraded cases. */
async function completeWith(ref: Row, name: string, injected: Row) {
  const body = await rpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "completion/complete",
      params: { ref, argument: { name, value: "" } },
    },
    injected,
  );
  assert.ok(!body.error, `completion errored: ${JSON.stringify(body.error)}`);
  return (body.result as Row).completion as Row;
}

async function complete(ref: Row, name: string, value = "") {
  const res = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "completion/complete",
        params: { ref, argument: { name, value } },
      }),
    }),
    {} as unknown as Env,
    deps,
  );
  const body = (await res.json()) as Row;
  assert.ok(!body.error, `completion errored: ${JSON.stringify(body.error)}`);
  return (body.result as Row).completion as Row;
}

describe("completion/complete (#9686)", () => {
  test("the capability is declared, so clients know to offer it", () => {
    assert.deepEqual((MCP_CAPABILITIES as Row).completions, {});
  });

  test("a prompt's netuid argument completes from the registry", async () => {
    const c = await complete(
      { type: "ref/prompt", name: "integrate_with_subnet" },
      "netuid",
    );
    assert.deepEqual(c.values, ["1", "6", "64", "65"]);
    assert.equal(c.total, 4);
    assert.equal(c.hasMore, false);
  });

  // The case that makes completion worth having: a caller who has typed "6"
  // should see 6 and 64 and 65, not all 129 subnets.
  test("typing narrows by prefix", async () => {
    const c = await complete(
      { type: "ref/prompt", name: "integrate_with_subnet" },
      "netuid",
      "6",
    );
    assert.deepEqual(c.values, ["6", "64", "65"]);
    assert.equal(c.total, 3);
  });

  test("a resource template's netuid variable completes the same way", async () => {
    for (const uri of [
      "metagraph://subnet/{netuid}",
      "metagraph://subnet/{netuid}/status",
    ]) {
      const c = await complete({ type: "ref/resource", uri }, "netuid");
      assert.deepEqual(c.values, ["1", "6", "64", "65"], uri);
    }
  });

  test("provider slugs complete, case-insensitively", async () => {
    const c = await complete(
      { type: "ref/resource", uri: "metagraph://provider/{slug}" },
      "slug",
      "CHUT",
    );
    assert.deepEqual(c.values, ["chutes", "chutes-labs"]);
  });

  test("a provider row with no slug is dropped, not offered as empty", async () => {
    const c = await complete(
      { type: "ref/resource", uri: "metagraph://provider/{slug}" },
      "slug",
    );
    assert.deepEqual(c.values, ["chutes", "chutes-labs", "opentensor"]);
    assert.equal(c.total, 3, "the slugless row did not become a value");
  });

  // The schemas index uses `surface_id` on some rows and `id` on others; the
  // resource list already tolerates both, so completion must too or it would
  // silently omit half the catalogue.
  test("surface ids complete from either key, and an id-less row is dropped", async () => {
    const c = await complete(
      { type: "ref/resource", uri: "metagraph://schema/{surface_id}" },
      "surface_id",
    );
    // Both keyed rows present; the third fixture row (neither key) contributes
    // nothing rather than an empty-string suggestion that resolves to no
    // resource. `total` is the assertion that proves it was dropped and not
    // merely sorted to the front.
    assert.deepEqual(c.values.sort(), ["sn-6-openapi", "sn-64-chutes-openapi"]);
    assert.equal(c.total, 2, "the row with neither key did not become a value");
  });

  describe("arguments with no meaningful completion answer empty", () => {
    for (const [label, ref, name] of [
      [
        "free-text task",
        { type: "ref/prompt", name: "find_subnet_for_task" },
        "task",
      ],
      [
        "an ss58 address",
        { type: "ref/prompt", name: "audit_account_history" },
        "ss58",
      ],
      [
        "an unknown ref type",
        { type: "ref/tool", name: "get_subnet" },
        "netuid",
      ],
      [
        "an unknown resource",
        { type: "ref/resource", uri: "metagraph://nope/{x}" },
        "x",
      ],
    ] as Array<[string, Row, string]>) {
      test(label, async () => {
        const c = await complete(ref, name);
        assert.deepEqual(c.values, []);
        assert.equal(c.total, 0);
        assert.equal(c.hasMore, false);
      });
    }
  });

  test("a prefix that matches nothing is empty, not an error", async () => {
    const c = await complete(
      { type: "ref/prompt", name: "integrate_with_subnet" },
      "netuid",
      "zzz",
    );
    assert.deepEqual(c.values, []);
    assert.equal(c.total, 0);
  });

  // The spec caps a completion response at 100 values. Beyond that the count
  // has to ride on `total`/`hasMore`, or a client paging through them cannot
  // tell a full page from the end of the list.
  test("more than 100 matches are capped, with the real count on total", async () => {
    const many = {
      providers: Array.from({ length: 150 }, (_, i) => ({ slug: `p${i}` })),
    };
    const res = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "completion/complete",
          params: {
            ref: { type: "ref/resource", uri: "metagraph://provider/{slug}" },
            argument: { name: "slug", value: "p" },
          },
        }),
      }),
      {} as unknown as Env,
      { readArtifact: async () => ({ ok: true, data: many }) },
    );
    const c = ((await res.json()) as Row).result.completion as Row;
    assert.equal((c.values as string[]).length, 100);
    assert.equal(c.total, 150);
    assert.equal(c.hasMore, true);
  });

  // EVERY SOURCE HAS ITS OWN READ, so every source has its own failure path.
  // The netuid case below is not evidence about the other two: they call
  // different artifacts through different `.catch` handlers, and an
  // autocomplete that 500s on a cold providers.json is exactly as broken as
  // one that 500s on subnets.json.
  describe("a degraded registry completes to nothing, per source", () => {
    const cases: Array<[string, Row, string]> = [
      [
        "netuid",
        { type: "ref/prompt", name: "integrate_with_subnet" },
        "netuid",
      ],
      [
        "slug",
        { type: "ref/resource", uri: "metagraph://provider/{slug}" },
        "slug",
      ],
      [
        "surface_id",
        { type: "ref/resource", uri: "metagraph://schema/{surface_id}" },
        "surface_id",
      ],
    ];

    for (const [label, ref, name] of cases) {
      test(`${label}: the read throws`, async () => {
        const c = await completeWith(ref, name, {
          readArtifact: async () => {
            throw new Error("R2 is down");
          },
        });
        assert.deepEqual(c.values, []);
      });

      test(`${label}: the artifact is unreadable`, async () => {
        const c = await completeWith(ref, name, {
          readArtifact: async () => ({
            ok: false,
            code: "artifact_unavailable",
          }),
        });
        assert.deepEqual(c.values, []);
      });

      // A published artifact whose collection key is absent — the shape the
      // `|| []` fallback exists for. Without it this would throw on .map.
      test(`${label}: the artifact has no rows`, async () => {
        const c = await completeWith(ref, name, {
          readArtifact: async () => ({ ok: true, data: {} }),
        });
        assert.deepEqual(c.values, []);
      });
    }
  });

  // Malformed-but-parseable params. A client that omits a field should get an
  // empty completion, never a crash — completion sits in an editor's keystroke
  // path, so it is called with half-built input by construction.
  describe("incomplete params complete to nothing", () => {
    for (const [label, params] of [
      ["no params at all", undefined],
      ["no ref", { argument: { name: "netuid", value: "6" } }],
      [
        "a resource ref with no uri",
        { ref: { type: "ref/resource" }, argument: { name: "netuid" } },
      ],
      [
        "no argument",
        { ref: { type: "ref/prompt", name: "integrate_with_subnet" } },
      ],
      [
        "an argument with no name",
        {
          ref: { type: "ref/prompt", name: "integrate_with_subnet" },
          argument: {},
        },
      ],
    ] as Array<[string, Row | undefined]>) {
      test(label, async () => {
        const body = await rpc({
          jsonrpc: "2.0",
          id: 1,
          method: "completion/complete",
          ...(params ? { params } : {}),
        });
        assert.ok(!body.error, label);
        assert.deepEqual((body.result.completion as Row).values, []);
      });
    }

    // An argument with a name but no `value` is the very first keystroke —
    // it must list everything, not nothing.
    test("an argument with no value lists every candidate", async () => {
      const body = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "completion/complete",
        params: {
          ref: { type: "ref/prompt", name: "integrate_with_subnet" },
          argument: { name: "netuid" },
        },
      });
      assert.deepEqual((body.result.completion as Row).values, [
        "1",
        "6",
        "64",
        "65",
      ]);
    });
  });

  // Sent without an id. A conforming client always sends one, but the dispatch
  // loop treats every method uniformly and this is the branch that says so.
  test("as a notification it is answered 202 with no body", async () => {
    const res = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "completion/complete",
          params: {
            ref: { type: "ref/prompt", name: "integrate_with_subnet" },
            argument: { name: "netuid", value: "" },
          },
        }),
      }),
      {} as unknown as Env,
      deps,
    );
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
  });

  // A registry read that fails must not take the method down with it — an
  // autocomplete that 500s is worse than one that returns nothing.
  test("an unreadable registry completes to nothing rather than erroring", async () => {
    const res = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "completion/complete",
          params: {
            ref: { type: "ref/prompt", name: "integrate_with_subnet" },
            argument: { name: "netuid", value: "" },
          },
        }),
      }),
      {} as unknown as Env,
      {
        readArtifact: async () => {
          throw new Error("R2 is down");
        },
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.ok(!body.error);
    assert.deepEqual((body.result.completion as Row).values, []);
  });
});
