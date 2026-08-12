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
