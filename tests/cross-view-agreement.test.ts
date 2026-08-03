// Two views of one stream must not be able to disagree (#9260, #9263).
//
// Both defects this file guards were found the same way: one route answered
// with rows while another route over the SAME underlying stream answered
// empty, and nothing in the suite noticed because each route's own tests
// asserted only that route's shape. A schema-stable empty is indistinguishable
// from a measured zero, so "the payload is well-formed" was never the property
// that mattered -- agreement between the views was.
//
// These tests therefore assert ACROSS routes, deliberately, and are the only
// tests in the suite that do so for these two pairs:
//
//   /blocks/{n}          event_count > 0   vs  /blocks/{n}/chain-events
//   /accounts/{ss58}     the summary card  vs  /accounts/{ss58}/events
//
// A view is allowed to DECLINE (503). What it may not do is claim a tier
// answered and hand back nothing while its twin hands back rows.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";
import { resetDecodeWatermarkCache } from "../src/decode-watermark.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { jsonBody } from "./row-type.ts";

const SEAM = DEFAULT_BLOCKS_SEAM; // 8_759_336
/** A block in the ~8.76M-block range that answered `events: []` for all of
 * history: below the decode seam, so the lakehouse owns it outright. */
const HISTORIC = 1_000;
const SS58 = "5Fv5t8frGG3MKtahp4WafKPmT5xZDbqWf8aFZpXyvjHTgzzx";

beforeEach(() => resetDecodeWatermarkCache());

/** The 21 events block 1,000's own header advertises, in read order. */
const CHAIN_EVENTS = Array.from({ length: 21 }, (_, index) => ({
  block_number: HISTORIC,
  event_index: index,
  pallet: "System",
  method: index === 0 ? "ExtrinsicSuccess" : "NewAccount",
  args: JSON.stringify({ index }),
  phase: "ApplyExtrinsic",
  extrinsic_index: 0,
  observed_at: 1_679_350_140_004,
}));

const ACCOUNT_EVENT = {
  block_number: 8_763_529,
  event_index: 213,
  extrinsic_index: 22,
  event_kind: "TimelockedWeightsCommitted",
  hotkey: SS58,
  coldkey: null,
  netuid: 46,
  uid: null,
  amount_tao: null,
  alpha_amount: null,
  observed_at: 1_785_759_000_000,
};

/**
 * ONE lakehouse behind every route in a test, answering by query shape.
 *
 * Sharing the engine across both views is the point: a stub that fed the two
 * routes different rows could not detect a disagreement, only assert one.
 */
function lakehouse() {
  const queries: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const sql = JSON.parse(String(init.body)).query as string;
    queries.push(sql);
    let rows: Record<string, unknown>[] = [];
    if (sql.includes("FROM chain.blocks")) {
      rows = [
        {
          block_number: HISTORIC,
          block_hash: `0x${"a5".repeat(32)}`,
          parent_hash: `0x${"e1".repeat(32)}`,
          author: null,
          extrinsic_count: 8,
          // The header the route has always published for this block, and the
          // number the body contradicted.
          event_count: 21,
          spec_version: 102,
          observed_at: 1_679_350_140_004,
        },
      ];
    } else if (sql.includes("FROM chain.chain_events")) {
      rows = CHAIN_EVENTS;
    } else if (sql.includes("GROUP BY event_kind")) {
      rows = [{ kind: "TimelockedWeightsCommitted", count: 100 }];
    } else if (sql.includes("count(DISTINCT netuid)")) {
      rows = [
        {
          c: 100,
          sc: 1,
          fb: 8_700_000,
          lb: 8_763_529,
          fo: 1_785_000_000_000,
          lo: 1_785_759_000_000,
        },
      ];
    } else if (sql.includes("count(*) AS c FROM (")) {
      rows = [{ c: 100 }];
    } else if (sql.includes("FROM chain.account_events")) {
      rows = [ACCOUNT_EVENT];
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

/** An env with a lakehouse, an empty hot tier, and a D1 holding one neuron. */
function env() {
  return {
    [R2_SQL_TOKEN_ENV]: "cfut_test",
    METAGRAPH_HEALTH_DB: {
      prepare(raw: string) {
        const sql = raw.replace(/\s+/g, " ").trim();
        return {
          bind(...params: unknown[]) {
            return {
              async all() {
                if (sql.includes("FROM neurons"))
                  return {
                    results: [
                      {
                        netuid: 46,
                        uid: 232,
                        stake_tao: "54085.698671464",
                        validator_permit: 1,
                        active: 1,
                      },
                    ],
                  };
                if (sql.startsWith("SELECT MIN(block_number)"))
                  return {
                    results: [{ floor: null, head: null, observed: null }],
                  };
                void params;
                return { results: [] };
              },
            };
          },
        };
      },
    },
  } as never;
}

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

/** One GraphQL POST against the same env the REST assertions use. */
async function gql(query: string, environment: unknown) {
  const res = await handleGraphQLRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
    environment as Env,
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      data: Record<string, unknown>;
      errors?: { extensions?: { code?: string } }[];
    },
  };
}

describe("a block's header and its chain-event body agree", () => {
  test("a header with event_count 21 is not answered by an empty body", async () => {
    // #9260 exactly: /blocks/1000 advertised event_count 21 while
    // /blocks/1000/chain-events served `count: 0` with `ok: true`.
    lakehouse();
    const header = await jsonBody(
      await handleRequest(
        req(`/api/v1/blocks/${HISTORIC}`),
        env(),
        {} as never,
      ),
    );
    const advertised = header.data.block.event_count as number;
    assert.ok(advertised > 0, "fixture must model a block that HAD events");

    const res = await handleRequest(
      req(`/api/v1/blocks/${HISTORIC}/chain-events`),
      env(),
      {} as never,
    );
    const body = await jsonBody(res);
    if (res.status !== 200) {
      // Declining is allowed. Claiming to have answered is not.
      assert.equal(body.ok, false);
      return;
    }
    assert.notEqual(
      body.data.count,
      0,
      `header advertises ${advertised} events; the body must not serve 0 ` +
        `from a tier that reports it answered (source ${body.meta.source})`,
    );
    assert.equal(body.data.count, advertised);
    // And it must say which store served, not inherit the hot tier's label.
    assert.equal(body.meta.source, "lakehouse-cold-tier");
  });

  test("the MCP tool over the same block sees the same rows", async () => {
    // GraphQL's block_chain_events resolver reuses this loader unchanged, so
    // one assertion covers both agent-facing surfaces.
    lakehouse();
    const tool = MCP_TOOLS.find((t) => t.name === "get_block_chain_events");
    assert.ok(tool);
    const out = (await tool.handler(
      { block_number: HISTORIC } as never,
      {
        env: env(),
      } as never,
    )) as Record<string, unknown>;
    assert.equal(out.event_count, 21);
    assert.equal((out.events as unknown[]).length, 21);
  });

  test("a block genuinely without chain events still answers zero", async () => {
    // The property is agreement, not "never empty" -- a measured zero must
    // still be servable, or the fix would just move the lie.
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const sql = JSON.parse(String(init.body)).query as string;
      const rows = sql.includes("FROM chain.blocks")
        ? [{ block_number: SEAM - 5, event_count: 0, extrinsic_count: 0 }]
        : [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const res = await handleRequest(
      req(`/api/v1/blocks/${SEAM - 5}/chain-events`),
      env(),
      {} as never,
    );
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.data.count, 0);
    assert.equal(body.meta.source, "lakehouse-cold-tier");
  });
});

describe("an account's summary card and its event feed agree", () => {
  test("a summary is not empty for an account whose /events returns rows", async () => {
    // #9263 exactly: /events returned 100 while the summary reported
    // recent_events 0, event_kinds 0 and registrations 0.
    lakehouse();
    const feed = await jsonBody(
      await handleRequest(
        req(`/api/v1/accounts/${SS58}/events?limit=10`),
        env(),
        {} as never,
      ),
    );
    const kinds = new Set(
      (feed.data.events as Record<string, unknown>[]).map((e) => e.event_kind),
    );
    assert.ok(kinds.size > 0, "fixture must model an account WITH events");

    const res = await handleRequest(
      req(`/api/v1/accounts/${SS58}`),
      env(),
      {} as never,
    );
    assert.equal(res.status, 200);
    const card = (await jsonBody(res)).data;
    assert.notEqual(
      (card.recent_events as unknown[]).length,
      0,
      "the feed returned events; the card must not claim there are none",
    );
    // The card's kind breakdown must COVER what the feed serves -- a kind the
    // feed reports and the card omits is the same disagreement in miniature.
    const cardKinds = new Set(
      (card.event_kinds as Record<string, unknown>[]).map((k) => k.kind),
    );
    for (const kind of kinds) {
      assert.ok(
        cardKinds.has(kind),
        `card omits event kind ${String(kind)} that /events reports`,
      );
    }
  });

  test("the card's registrations match what /subnets serves for the same hotkey", async () => {
    // The leg that was STILL missing after #9257 wired the event half.
    lakehouse();
    const card = (
      await jsonBody(
        await handleRequest(
          req(`/api/v1/accounts/${SS58}`),
          env(),
          {} as never,
        ),
      )
    ).data;
    assert.deepEqual(card.registrations, [
      {
        netuid: 46,
        uid: 232,
        stake_tao: 54085.698671464,
        validator_permit: true,
        active: true,
      },
    ]);
  });

  test("a lakehouse that cannot answer DECLINES with a typed 503", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
      }) as unknown as Response) as unknown as typeof fetch;
    const res = await handleRequest(
      req(`/api/v1/accounts/${SS58}`),
      env(),
      {} as never,
    );
    assert.equal(res.status, 503);
    assert.equal(
      res.headers.get("x-metagraph-error-code"),
      "account_summary_unavailable",
    );
    const body = await jsonBody(res);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /not an account without activity/);
    assert.equal(body.meta.ss58, SS58);
  });

  test("the MCP tool declines the same failure rather than zeroing the card", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
      }) as unknown as Response) as unknown as typeof fetch;
    const tool = MCP_TOOLS.find((t) => t.name === "get_account");
    assert.ok(tool);
    await assert.rejects(
      tool.handler(
        { ss58: SS58 } as never,
        {
          env: env(),
          readArtifact: async () => ({ ok: false }),
        } as never,
      ),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "account_summary_unavailable");
        return true;
      },
    );
  });

  test("the MCP tool serves the SAME card REST does when the tiers answer", async () => {
    lakehouse();
    const tool = MCP_TOOLS.find((t) => t.name === "get_account");
    assert.ok(tool);
    const card = (await tool.handler(
      { ss58: SS58 } as never,
      { env: env(), readArtifact: async () => ({ ok: false }) } as never,
    )) as Record<string, unknown>;
    assert.equal(card.event_count, 100);
    assert.equal((card.recent_events as unknown[]).length, 1);
    assert.equal((card.registrations as unknown[]).length, 1);
    // The entity-label join is unchanged and tier-independent; with no
    // entities artifact it is legitimately empty, on every surface.
    assert.deepEqual(card.labels, []);
  });

  test("GraphQL answers with the same card, and raises on the same failure", async () => {
    lakehouse();
    const query =
      `{ account(ss58: "${SS58}") { ss58 event_count ` +
      `event_kinds { kind count } recent_events { block_number } ` +
      `registrations { netuid uid validator_permit } } }`;
    const ok = await gql(query, env());
    assert.equal(ok.status, 200);
    const card = ok.body.data.account as Record<string, unknown>;
    assert.equal(card.event_count, 100);
    assert.equal((card.recent_events as unknown[]).length, 1);
    assert.deepEqual(card.registrations, [
      { netuid: 46, uid: 232, validator_permit: true },
    ]);

    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
      }) as unknown as Response) as unknown as typeof fetch;
    const failed = await gql(query, env());
    // A nullable field, so the error nulls just this field -- but it IS an
    // error, not a zeroed card presented as an answer.
    assert.equal(failed.body.data.account, null);
    assert.ok(
      failed.body.errors?.find(
        (e) => e.extensions?.code === "account_summary_unavailable",
      ),
      "GraphQL must raise rather than resolve an all-zero summary",
    );
  });
});
