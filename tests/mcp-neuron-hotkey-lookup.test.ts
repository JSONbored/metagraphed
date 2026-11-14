// get_neuron by hotkey, and get_subnet_metagraph row selection (#9872).
//
// Driven through the real MCP dispatch rather than by calling handlers
// directly, because half of what is under test IS the dispatch path: the
// arguments a caller sends arrive as raw JSON, and the "exactly one of
// uid/hotkey" rule is enforced in the handler by design (#8942).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const HOTKEY_A = "5GP7c3fFazW9GXK8Up3qgu2DJBk8inu4aK9TZy3RuoSWVCMi";
const HOTKEY_B = "5CDYzuoN75FE8fBEJ3A587zsra9ee7xBLEwxrSgSpB3s4nsp";
const HOTKEY_ABSENT = "5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV";

function snapshotRows(): Row[] {
  return [
    { uid: 0, hotkey: HOTKEY_A, active: true, incentive: 0, stake_tao: 5 },
    { uid: 1, hotkey: HOTKEY_B, active: true, incentive: 0.5, stake_tao: 1 },
    { uid: 2, hotkey: null, active: false, incentive: 0.9, stake_tao: 3 },
  ];
}

// The neurons tier answering /metagraph and /neurons/{uid}, the two paths
// these tools reach through tryDataApiTier.
function neuronsTierEnv() {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_NEURONS_SOURCE: "data-api",
    DATA_API: {
      async fetch(input: Request | string) {
        const url = new URL(typeof input === "string" ? input : input.url);
        const neuronMatch = url.pathname.match(/\/neurons\/(\d+)$/);
        if (neuronMatch) {
          const uid = Number(neuronMatch[1]);
          return Response.json({
            schema_version: 1,
            netuid: 53,
            captured_at: "2026-08-07T16:18:31.183Z",
            block_number: 8793568,
            neuron: snapshotRows().find((row) => row.uid === uid) ?? null,
          });
        }
        return Response.json({
          schema_version: 1,
          netuid: 53,
          neuron_count: 3,
          captured_at: "2026-08-07T16:18:31.183Z",
          block_number: 8793568,
          neurons: snapshotRows(),
        });
      },
    },
  };
}

async function callTool(name: string, args: Row, env = neuronsTierEnv()) {
  const res = await handleMcpRequest(
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
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
  return (await res.json()) as Row;
}

function structured(body: Row): Row {
  return (body.result as Row)?.structuredContent as Row;
}

function errorText(body: Row): string {
  const content = ((body.result as Row)?.content ?? []) as Row[];
  return String(content[0]?.text ?? "");
}

describe("get_neuron accepts a hotkey (#9872)", () => {
  test("a hotkey returns that neuron, with the snapshot's own stamp", async () => {
    const body = await callTool("get_neuron", { netuid: 53, hotkey: HOTKEY_B });
    const data = structured(body);
    assert.equal((data.neuron as Row).uid, 1);
    assert.equal((data.neuron as Row).hotkey, HOTKEY_B);
    assert.equal(data.netuid, 53);
    // captured_at/block_number must come from the snapshot, not be invented:
    // an agent comparing this against an off-chain source needs to know when
    // WE sampled (#9871).
    assert.equal(data.captured_at, "2026-08-07T16:18:31.183Z");
    assert.equal(data.block_number, 8793568);
  });

  test("a hotkey that holds no UID here answers neuron: null, not an error", async () => {
    const body = await callTool("get_neuron", {
      netuid: 53,
      hotkey: HOTKEY_ABSENT,
    });
    assert.equal(body.error, undefined);
    assert.equal(structured(body).neuron, null);
  });

  test("uid still works and is unchanged", async () => {
    const body = await callTool("get_neuron", { netuid: 53, uid: 0 });
    assert.equal((structured(body).neuron as Row).hotkey, HOTKEY_A);
  });

  test("neither identifier is rejected, naming both options", async () => {
    const body = await callTool("get_neuron", { netuid: 53 });
    const text = errorText(body);
    assert.match(text, /invalid_params/);
    assert.match(text, /uid/);
    assert.match(text, /hotkey/);
  });

  test("both identifiers are rejected rather than one silently winning", async () => {
    const body = await callTool("get_neuron", {
      netuid: 53,
      uid: 0,
      hotkey: HOTKEY_B,
    });
    assert.match(errorText(body), /invalid_params/);
  });

  test("a malformed hotkey is invalid_params, not an empty result", async () => {
    // The distinction matters: an empty result reads as "not registered",
    // which is a wrong answer to a typo.
    const body = await callTool("get_neuron", {
      netuid: 53,
      hotkey: "not-an-ss58",
    });
    assert.match(errorText(body), /invalid_params/);
  });

  test("`fields` still projects the row it returns", async () => {
    const body = await callTool("get_neuron", {
      netuid: 53,
      hotkey: HOTKEY_B,
      fields: ["uid", "incentive"],
    });
    assert.deepEqual(Object.keys(structured(body).neuron as Row).sort(), [
      "incentive",
      "uid",
    ]);
  });

  test("a cold tier answers neuron: null with a null stamp, never a stale one", async () => {
    // No METAGRAPH_NEURONS_SOURCE, so tryDataApiTier declines and the empty
    // snapshot builder answers. The stamp must come back null rather than
    // being invented: "we have no snapshot" and "the snapshot says no" are
    // different answers and a caller has to be able to tell them apart.
    const body = await callTool(
      "get_neuron",
      { netuid: 53, hotkey: HOTKEY_B },
      createLocalArtifactEnv() as never,
    );
    const data = structured(body);
    assert.equal(data.neuron, null);
    assert.equal(data.captured_at, null);
    assert.equal(data.block_number, null);
  });

  test("a tier payload missing neurons/stamp degrades instead of throwing", async () => {
    // The tier is a separate service; a shape it has never returned is still
    // a shape this handler can be handed. It must not throw a 500 at an agent
    // for it.
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_NEURONS_SOURCE: "data-api",
      DATA_API: {
        async fetch() {
          return Response.json({});
        },
      },
    };
    const data = structured(
      await callTool(
        "get_neuron",
        { netuid: 53, hotkey: HOTKEY_B },
        env as never,
      ),
    );
    assert.equal(data.neuron, null);
    assert.equal(data.schema_version, 1);
    assert.equal(data.captured_at, null);
    assert.equal(data.block_number, null);
  });

  test("the published schema states the choice, so a client can enforce it", async () => {
    const def = listToolDefinitions().find(
      (tool) => (tool as Row).name === "get_neuron",
    ) as Row;
    const input = def.inputSchema as Row;
    // Not merely described in prose: `oneOf` of two `required` branches is
    // exactly-one, because passing both matches both and matching two fails.
    assert.deepEqual(input.oneOf, [
      { required: ["uid"] },
      { required: ["hotkey"] },
    ]);
    // `context` rides every advertised required list (unenforced — see
    // withAdvertisedRequiredIntent); the tool's own requirement is netuid.
    assert.deepEqual(input.required, ["netuid", "context"]);
  });
});

describe("get_subnet_metagraph row selection (#9872)", () => {
  test("hotkeys narrows to those rows and reports the pre-filter total", async () => {
    const data = structured(
      await callTool("get_subnet_metagraph", {
        netuid: 53,
        hotkeys: [HOTKEY_B],
      }),
    );
    assert.equal((data.neurons as Row[]).length, 1);
    assert.equal(data.neuron_count, 1);
    assert.equal(data.total_neuron_count, 3);
  });

  test("an unfiltered call is unchanged, including no total_neuron_count", async () => {
    const data = structured(
      await callTool("get_subnet_metagraph", { netuid: 53 }),
    );
    assert.equal(data.neuron_count, 3);
    assert.equal(Object.hasOwn(data, "total_neuron_count"), false);
  });

  test("sort_by + limit answers a leaderboard question", async () => {
    const data = structured(
      await callTool("get_subnet_metagraph", {
        netuid: 53,
        sort_by: "incentive",
        limit: 2,
      }),
    );
    assert.deepEqual(
      (data.neurons as Row[]).map((row) => row.uid),
      [2, 1],
    );
  });

  test("a sort_by that is not a numeric field is rejected", async () => {
    // `hotkey` is a real Neuron field, so this proves the SORT vocabulary is
    // enforced separately from the projection vocabulary rather than both
    // falling back to NeuronSchema's full key set.
    const body = await callTool("get_subnet_metagraph", {
      netuid: 53,
      sort_by: "hotkey",
    });
    assert.match(errorText(body), /invalid_params/);
  });

  test("a bad hotkey in the array is rejected before the fetch", async () => {
    const body = await callTool("get_subnet_metagraph", {
      netuid: 53,
      hotkeys: [HOTKEY_B, "nope"],
    });
    assert.match(errorText(body), /invalid_params/);
  });

  test("an empty hotkeys array is rejected rather than treated as no filter", async () => {
    const body = await callTool("get_subnet_metagraph", {
      netuid: 53,
      hotkeys: [],
    });
    assert.match(errorText(body), /invalid_params/);
  });

  test("active:false selects the inactive rows, not 'no filter'", async () => {
    const data = structured(
      await callTool("get_subnet_metagraph", { netuid: 53, active: false }),
    );
    assert.deepEqual(
      (data.neurons as Row[]).map((row) => row.uid),
      [2],
    );
  });

  test("min_incentive drops the rows below the floor", async () => {
    const data = structured(
      await callTool("get_subnet_metagraph", {
        netuid: 53,
        min_incentive: 0.5,
      }),
    );
    assert.deepEqual(
      (data.neurons as Row[]).map((row) => row.uid),
      [1, 2],
    );
    assert.equal(data.total_neuron_count, 3);
  });

  test("a negative min_incentive is rejected", async () => {
    const body = await callTool("get_subnet_metagraph", {
      netuid: 53,
      min_incentive: -1,
    });
    assert.match(errorText(body), /invalid_params/);
  });

  test("limit:0 is rejected — an explicit cap of nothing is a mistake, not a request", async () => {
    const body = await callTool("get_subnet_metagraph", {
      netuid: 53,
      limit: 0,
    });
    assert.match(errorText(body), /invalid_params/);
  });

  test("selection runs before projection, so a filter does not need its column asked for", async () => {
    // min_incentive filters on `incentive` while the caller asks only for
    // `uid`: if projection ran first the filter would see no incentive at all
    // and drop every row.
    const data = structured(
      await callTool("get_subnet_metagraph", {
        netuid: 53,
        min_incentive: 0.5,
        fields: ["uid"],
      }),
    );
    assert.deepEqual(data.neurons, [{ uid: 1 }, { uid: 2 }]);
  });
});

// The mechanism (mechid) scope on the three mirrored tools (#13162). MCP
// dispatch does not validate against the published Zod input schema, so the
// bound-to-0 posture (mechidSchema) is enforced in the handlers via
// optionalMechanismScope, with the shared MECHANISM_SCOPE_MESSAGE sentence.
describe("mechanism scope (#13162)", () => {
  test("get_subnet_metagraph mechid: 0 stamps the snapshot and every row", async () => {
    const data = structured(
      await callTool("get_subnet_metagraph", { netuid: 53, mechid: 0 }),
    );
    assert.equal(data.mechid, 0);
    for (const row of data.neurons as Row[]) assert.equal(row.mechid, 0);
  });

  test("omitting mechid leaves the snapshot unstamped", async () => {
    const data = structured(
      await callTool("get_subnet_metagraph", { netuid: 53 }),
    );
    assert.equal("mechid" in data, false);
    assert.equal("mechid" in (data.neurons as Row[])[0], false);
  });

  test("get_neuron mechid: 0 stamps both the uid and the hotkey path", async () => {
    const byUid = structured(
      await callTool("get_neuron", { netuid: 53, uid: 0, mechid: 0 }),
    );
    assert.equal(byUid.mechid, 0);
    assert.equal((byUid.neuron as Row).mechid, 0);

    const byHotkey = structured(
      await callTool("get_neuron", {
        netuid: 53,
        hotkey: HOTKEY_B,
        mechid: 0,
      }),
    );
    assert.equal(byHotkey.mechid, 0);
    assert.equal((byHotkey.neuron as Row).mechid, 0);
  });

  test("get_subnet_weights mechid: 0 echoes the scope on the card", async () => {
    const data = structured(
      await callTool(
        "get_subnet_weights",
        { netuid: 5, mechid: 0 },
        createLocalArtifactEnv() as unknown as ReturnType<
          typeof neuronsTierEnv
        >,
      ),
    );
    assert.equal(data.mechid, 0);
    assert.equal(data.weight_sets, 0);
  });

  test("a scope above 0 -- or a non-number -- is invalid_params on all three tools", async () => {
    for (const [name, args] of [
      ["get_subnet_metagraph", { netuid: 53, mechid: 1 }],
      ["get_neuron", { netuid: 53, uid: 0, mechid: 1 }],
      ["get_subnet_weights", { netuid: 5, mechid: 1 }],
      ["get_subnet_metagraph", { netuid: 53, mechid: "0" }],
    ] as const) {
      const body = await callTool(name, args as unknown as Row);
      const text = errorText(body);
      assert.match(text, /invalid_params/, name);
      assert.match(text, /mechid must be 0/, name);
    }
  });
});

// The get_subnet_mechanisms tool (#13162): same loader/builder as the REST
// route and the GraphQL field, so the decline and the registry match exactly.
describe("get_subnet_mechanisms (#13162)", () => {
  test("no bound store answers the schema-stable decline", async () => {
    const data = structured(
      await callTool(
        "get_subnet_mechanisms",
        { netuid: 64 },
        createLocalArtifactEnv() as unknown as ReturnType<
          typeof neuronsTierEnv
        >,
      ),
    );
    assert.deepEqual(data, {
      schema_version: 1,
      netuid: 64,
      mechanism_count: null,
      captured_at: null,
      mechanisms: [],
    });
  });

  test("a bound store serves the registry", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      SUBNET_MECHANISMS_STORE: {
        rows: async () => [
          {
            mechid: 0,
            emission_split: 0.75,
            consensus_mode: "Yuma3",
            captured_at: 1_763_000_000_000,
          },
        ],
      },
    };
    const data = structured(
      await callTool(
        "get_subnet_mechanisms",
        { netuid: 64 },
        env as unknown as ReturnType<typeof neuronsTierEnv>,
      ),
    );
    assert.equal(data.mechanism_count, 1);
    assert.equal((data.mechanisms as Row[])[0].mechid, 0);
  });

  test("a missing netuid is invalid_params", async () => {
    const body = await callTool("get_subnet_mechanisms", {});
    assert.match(errorText(body), /invalid_params/);
    assert.match(errorText(body), /netuid/);
  });
});

// The get_subnet_alpha_dividends tool (#13163): same loader/builder as the
// REST route and the GraphQL field, so the decline and the accruals match
// exactly.
describe("get_subnet_alpha_dividends (#13163)", () => {
  test("no bound store answers the schema-stable decline", async () => {
    const data = structured(
      await callTool(
        "get_subnet_alpha_dividends",
        { netuid: 64 },
        createLocalArtifactEnv() as unknown as ReturnType<
          typeof neuronsTierEnv
        >,
      ),
    );
    assert.deepEqual(data, {
      schema_version: 1,
      netuid: 64,
      hotkey_count: null,
      captured_at: null,
      dividends: [],
    });
  });

  test("a bound store serves the accruals", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      SUBNET_ALPHA_DIVIDENDS_STORE: {
        rows: async () => [
          {
            hotkey: "5Hotkey_one",
            alpha_divs: "12500",
            root_alpha_divs: "300",
            captured_at: 1_763_000_000_000,
          },
        ],
      },
    };
    const data = structured(
      await callTool(
        "get_subnet_alpha_dividends",
        { netuid: 64 },
        env as unknown as ReturnType<typeof neuronsTierEnv>,
      ),
    );
    assert.equal(data.hotkey_count, 1);
    assert.equal((data.dividends as Row[])[0].alpha_divs, "12500");
  });

  test("a missing netuid is invalid_params", async () => {
    const body = await callTool("get_subnet_alpha_dividends", {});
    assert.match(errorText(body), /invalid_params/);
    assert.match(errorText(body), /netuid/);
  });
});

// The get_account_locks tool (#13163): same loader/builder as the REST route
// and the GraphQL field, so the decline and the locks match exactly.
describe("get_account_locks (#13163)", () => {
  const COLDKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  test("no bound store answers the schema-stable decline", async () => {
    const data = structured(
      await callTool(
        "get_account_locks",
        { ss58: COLDKEY },
        createLocalArtifactEnv() as unknown as ReturnType<
          typeof neuronsTierEnv
        >,
      ),
    );
    assert.deepEqual(data, {
      schema_version: 1,
      ss58: COLDKEY,
      lock_count: null,
      captured_at: null,
      locks: [],
    });
  });

  test("a bound store serves the locks", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      ACCOUNT_LOCKS_STORE: {
        rows: async () => [
          {
            hotkey: "5Hotkey_one",
            netuid: 7,
            kind: "Lock",
            amount: "5000000000",
            maturity_block: 9_000_000,
            captured_at: 1_763_000_000_000,
          },
        ],
      },
    };
    const data = structured(
      await callTool(
        "get_account_locks",
        { ss58: COLDKEY },
        env as unknown as ReturnType<typeof neuronsTierEnv>,
      ),
    );
    assert.equal(data.lock_count, 1);
    assert.equal((data.locks as Row[])[0].kind, "Lock");
  });

  test("an invalid ss58 is invalid_params", async () => {
    const body = await callTool("get_account_locks", { ss58: "nope" });
    assert.match(errorText(body), /invalid_params/);
    assert.match(errorText(body), /ss58/);
  });
});
