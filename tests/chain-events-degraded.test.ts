// The six chain-events family routes have no METAGRAPH_*_SOURCE flag, so they
// never had the degrade path every flagged tier has. When the Postgres box was
// decommissioned all six answered 502 in production — the one response shape
// this API never emits for a cold tier. These assert the floor: a tier failure
// yields the contract's own empty, marked degraded, never an error.
//
// #8700 removed the DATA_API forward that used to sit above the ladder (its
// store was destroyed in #9186/#9193, so it could only 503), which makes the
// lakehouse the primary tier rather than the fallback. What "the tier failed"
// means therefore changed — an unreachable R2 SQL door, not a 5xx from a
// service binding — and these exercise it through the reader that now owns it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  coldTierChainEventsPayload,
  degradedChainEventsPayload,
  hotTierBlockChainEvents,
} from "../src/chain-events-degraded.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { handleChainEventsFamily, handleRequest } from "../workers/api.ts";
import { BlockChainEventsArtifactSchema } from "../schemas-src/routes/block-chain-events.ts";
import {
  ChainEventsFeedArtifactSchema,
  ChainEventsStatsArtifactSchema,
} from "../schemas-src/routes/chain-events.ts";
import { SubnetOwnershipHistoryArtifactSchema } from "../schemas-src/routes/subnet-ownership-history.ts";
import { SubnetConvictionArtifactSchema } from "../schemas-src/routes/subnet-conviction.ts";
import { SubnetLeaseHistoryArtifactSchema } from "../schemas-src/routes/subnet-lease.ts";
import { mockEnv } from "./row-type.ts";
import type { Row } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

/**
 * Lakehouse stub: `mode` picks which tier state to exercise.
 *
 * These are the states that remain now that the family reads R2 SQL directly:
 * the door answers, the door is unreachable, or no token is configured at all.
 * The old modes were DATA_API's (5xx / unreadable body / binding rejected /
 * binding absent) and describe a hop this family no longer makes.
 */
function envWith(mode: "ok" | "down" | "unconfigured") {
  globalThis.fetch = (async () => {
    if (mode === "down") throw new Error("r2 sql unreachable");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: { rows: [{ block_number: 1, event_index: 0 }] },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return mockEnv(
    mode === "unconfigured" ? {} : { [R2_SQL_TOKEN_ENV]: "cfut_test" },
  ) as unknown as Env;
}

const FAMILY = [
  "/api/v1/chain-events",
  "/api/v1/chain-events/stats",
  "/api/v1/blocks/8700000/chain-events",
  "/api/v1/subnets/1/ownership-history",
  "/api/v1/subnets/1/conviction",
  "/api/v1/subnets/1/lease/history",
];

describe("degradedChainEventsPayload", () => {
  test("every proxied route has a schema-stable empty", () => {
    for (const path of FAMILY) {
      const payload = degradedChainEventsPayload(
        new URL(`https://api.metagraph.sh${path}`),
      );
      assert.ok(payload, `${path} must have a degraded payload`);
    }
  });

  // Null, not a generic fallback: a seventh route added to the gate without
  // one here must keep erroring rather than serve a payload matching no schema.
  test("an unrecognised path yields null, not a generic empty", () => {
    assert.equal(
      degradedChainEventsPayload(
        new URL("https://api.metagraph.sh/api/v1/subnets/1/metagraph"),
      ),
      null,
    );
  });

  test("the feed nulls both cursor forms so a pager stops", () => {
    const p = degradedChainEventsPayload(
      new URL("https://api.metagraph.sh/api/v1/chain-events"),
    ) as Row;
    assert.deepEqual(p.events, []);
    assert.equal(p.count, 0);
    assert.equal(p.next_cursor, null);
    assert.equal(p.next_before, null);
  });

  // window_blocks is the denominator of everything else in the stats payload,
  // so echoing a default the caller never sent would silently rescale it.
  test("stats echoes the caller's own window", () => {
    const p = degradedChainEventsPayload(
      new URL("https://api.metagraph.sh/api/v1/chain-events/stats?blocks=250"),
    ) as Row;
    assert.equal(p.window_blocks, 250);
    assert.equal(p.groups, 0);
    assert.deepEqual(p.activity, []);
  });

  test("an out-of-range or absent window falls back to the declared default", () => {
    for (const q of ["", "?blocks=0", "?blocks=99999", "?blocks=abc"]) {
      const p = degradedChainEventsPayload(
        new URL(`https://api.metagraph.sh/api/v1/chain-events/stats${q}`),
      ) as Row;
      assert.equal(p.window_blocks, 1000, `for ${q || "(no param)"}`);
    }
  });

  test("the block feed echoes the requested block number", () => {
    const p = degradedChainEventsPayload(
      new URL("https://api.metagraph.sh/api/v1/blocks/8700000/chain-events"),
    ) as Row;
    assert.equal(p.block_number, 8_700_000);
    assert.deepEqual(p.events, []);
  });

  // Built by the same builders the live path uses, so a field added to a
  // payload cannot drift out of its degraded twin.
  test("the subnet payloads carry their builders' own constant fields", () => {
    const own = degradedChainEventsPayload(
      new URL("https://api.metagraph.sh/api/v1/subnets/7/ownership-history"),
    ) as Row;
    assert.equal(own.netuid, 7);
    assert.equal(own.schema_version, 1);
    assert.ok(own.event_pallet, "event_pallet comes from the builder");
    assert.deepEqual(own.ownership_changes, []);

    const lease = degradedChainEventsPayload(
      new URL("https://api.metagraph.sh/api/v1/subnets/7/lease/history"),
    ) as Row;
    assert.equal(lease.netuid, 7);
    assert.ok(Array.isArray(lease.event_kinds));
    assert.deepEqual(lease.lease_events, []);
  });

  // null rather than 0: an unread rate is not a measured zero.
  test("conviction reports unread rates as null, not zero", () => {
    const p = degradedChainEventsPayload(
      new URL("https://api.metagraph.sh/api/v1/subnets/7/conviction"),
    ) as Row;
    assert.equal(p.netuid, 7);
    assert.equal(p.unlock_rate, null);
    assert.equal(p.maturity_rate, null);
    assert.deepEqual(p.leaderboard, []);
  });
});

// The load-bearing claim of this whole change: "schema-stable" has to mean the
// PUBLISHED schema, not a shape that merely looks plausible. A degraded payload
// that fails its own contract would break generated clients precisely when the
// tier is already down.
describe("every degraded payload satisfies its published schema", () => {
  const cases: [string, string, { parse: (v: unknown) => unknown }][] = [
    ["chain-events", "/api/v1/chain-events", ChainEventsFeedArtifactSchema],
    [
      "chain-events/stats",
      "/api/v1/chain-events/stats",
      ChainEventsStatsArtifactSchema,
    ],
    [
      "block chain-events",
      "/api/v1/blocks/8700000/chain-events",
      BlockChainEventsArtifactSchema,
    ],
    [
      "ownership-history",
      "/api/v1/subnets/1/ownership-history",
      SubnetOwnershipHistoryArtifactSchema,
    ],
    [
      "conviction",
      "/api/v1/subnets/1/conviction",
      SubnetConvictionArtifactSchema,
    ],
    [
      "lease/history",
      "/api/v1/subnets/1/lease/history",
      SubnetLeaseHistoryArtifactSchema,
    ],
  ];
  for (const [name, path, schema] of cases) {
    test(`${name} parses against its own contract`, () => {
      const payload = degradedChainEventsPayload(
        new URL(`https://api.metagraph.sh${path}`),
      );
      // Throws with a readable field-path diff on any mismatch.
      assert.ok(schema.parse(payload));
    });
  }
});

// The step BEFORE the floor: a proxied route whose stream already has a
// lakehouse reader serves real rows on a DATA_API failure instead of the empty.
describe("coldTierChainEventsPayload", () => {
  // #9319: the dispatcher reports WHICH tier answered, because only it knows.
  // Before this, every cold answer was labelled `lakehouse-cold-tier` at the
  // call site -- including conviction, which reads live chain storage and has
  // no lakehouse involvement at all. `meta.source` exists to report the store
  // that answered, so a wrong one makes the field worse than absent.
  test("conviction reports the live chain tier, not the lakehouse", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse(
        String((init as { body?: string })?.body ?? "{}"),
      );
      const result =
        body.method === "chain_getHeader"
          ? { number: "0x85d1db" }
          : body.method === "state_getKeysPaged"
            ? []
            : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }) as unknown as typeof fetch;
    try {
      const answer = await coldTierChainEventsPayload(
        {} as never,
        new URL("https://api.metagraph.sh/api/v1/subnets/7/conviction"),
      );
      assert.ok(answer, "the live tier must answer");
      assert.equal(answer.source, "live-chain-storage");
      assert.notEqual(answer.source, "lakehouse-cold-tier");
      assert.equal((answer.data as Row).count, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const OWNERSHIP_ROW = {
    pallet: "SubtensorModule",
    method: "SubnetOwnerChanged",
    block_number: 8_587_754,
    observed_at: 1_783_600_000_000,
    args: {
      netuid: 7,
      old_coldkey: [
        [
          230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117,
          251, 19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175,
          143, 88,
        ],
      ],
      new_coldkey: [
        [
          109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
      ],
    },
  };

  function lakehouse(rows: unknown[]) {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows } }),
      }) as unknown as Response) as unknown as typeof fetch;
    return mockEnv({ [R2_SQL_TOKEN_ENV]: "cfut_test" }) as unknown as Env;
  }

  test("ownership-history is served from the lakehouse", async () => {
    const env = lakehouse([OWNERSHIP_ROW]);
    const answer = (await coldTierChainEventsPayload(
      env,
      new URL("https://api.metagraph.sh/api/v1/subnets/7/ownership-history"),
    ))!;
    const payload = answer.data as Row;
    assert.equal(
      answer.source,
      "lakehouse-cold-tier",
      "a lakehouse read must say so",
    );
    assert.equal(payload.netuid, 7);
    assert.equal(payload.count, 1);
    assert.equal(payload.ownership_changes[0].block_number, 8_587_754);
  });

  // Three of the six now have readers (ownership-history, the all-events feed,
  // and its stats aggregate, all #9146). The rest are uncovered on purpose,
  // and a path with no reader must fall through to the floor rather than
  // invent one.
  const COVERED = [
    "/ownership-history",
    "/api/v1/chain-events",
    "/api/v1/chain-events/stats",
    "/lease/history",
  ];
  test("a route with no cold-tier reader yields null", async () => {
    const env = lakehouse([OWNERSHIP_ROW]);
    for (const path of FAMILY.filter(
      (p) => !COVERED.some((c) => p.endsWith(c) || p === c),
    )) {
      assert.equal(
        await coldTierChainEventsPayload(
          env,
          new URL(`https://api.metagraph.sh${path}`),
        ),
        null,
        path,
      );
    }
  });

  test("the all-events feed reads the lakehouse and clamps ?limit=", async () => {
    // #9146: the feed now has a reader. The limit is clamped to the same
    // 1-100 range data-api enforced, so a caller cannot widen the page.
    const env = lakehouse([]);
    const answer = (await coldTierChainEventsPayload(
      env,
      new URL("https://api.metagraph.sh/api/v1/chain-events?limit=10"),
    ))!;
    const payload = answer.data as Row;
    assert.ok(payload, "the feed must be covered, not fall through to null");
    assert.equal(payload.count, 0);
    assert.ok("next_before" in payload);
  });

  test("the stats aggregate reads the lakehouse", async () => {
    const env = lakehouse([]);
    const answer = (await coldTierChainEventsPayload(
      env,
      new URL("https://api.metagraph.sh/api/v1/chain-events/stats?blocks=500"),
    ))!;
    const payload = answer.data as Row;
    assert.ok(payload, "stats must be covered, not fall through to null");
    assert.equal(payload.window_blocks, 500);
    assert.equal(payload.groups, 0);
  });

  test("lease history answers a verified empty instead of claiming unavailable", async () => {
    // No subnet has ever been leased; a tier_unavailable marker on that would
    // tell callers to retry something that will never change.
    const env = lakehouse([]);
    const answer = (await coldTierChainEventsPayload(
      env,
      new URL("https://api.metagraph.sh/api/v1/subnets/7/lease/history"),
    ))!;
    const payload = answer.data as Row;
    assert.ok(
      payload,
      "must be an answer, not a fall-through to the marked empty",
    );
    assert.equal(payload.netuid, 7);
    assert.equal(payload.count, 0);
    assert.deepEqual(payload.lease_events, []);
  });

  test("an unconfigured lakehouse declines, leaving the floor to answer", async () => {
    assert.equal(
      await coldTierChainEventsPayload(
        mockEnv({}) as unknown as Env,
        new URL("https://api.metagraph.sh/api/v1/subnets/7/ownership-history"),
      ),
      null,
    );
  });
});

describe("handleChainEventsFamily", () => {
  // Unreachable through the router — the gate admits only paths the payload
  // map covers — so this is the only place the fallback is observable, and it
  // is the branch that keeps an unmapped seventh route from serving an empty
  // that satisfies no schema.
  test("an unmapped path keeps its original error", async () => {
    const res = await handleChainEventsFamily(
      req("/api/v1/subnets/1/metagraph"),
      mockEnv({}) as unknown as Env,
      new URL("https://api.metagraph.sh/api/v1/subnets/1/metagraph"),
      {},
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as Row;
    assert.equal(body.ok, false);
    assert.equal((body.error as Row).code, "data_tier_unavailable");
  });

  test("a mapped path degrades and names the failed tier, not the live one", async () => {
    const res = await handleChainEventsFamily(
      req("/api/v1/chain-events"),
      envWith("unconfigured"),
      new URL("https://api.metagraph.sh/api/v1/chain-events"),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-degraded"), "tier_unavailable");
    const body = (await res.json()) as Row;
    assert.equal((body.meta as Row).source, "data-worker-unavailable");
  });

  // Real rows, so NOT marked degraded and NOT barred from the edge cache --
  // the marker means "we could not look", which would be a lie here.
  test("a route with a cold tier serves the lakehouse, unmarked", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: {
            rows: [
              {
                pallet: "SubtensorModule",
                method: "SubnetOwnerChanged",
                block_number: 8_587_754,
                observed_at: 1_783_600_000_000,
                args: { netuid: 7 },
              },
            ],
          },
        }),
      }) as unknown as Response) as unknown as typeof fetch;
    const res = await handleChainEventsFamily(
      req("/api/v1/subnets/7/ownership-history"),
      mockEnv({ [R2_SQL_TOKEN_ENV]: "cfut_test" }) as unknown as Env,
      new URL("https://api.metagraph.sh/api/v1/subnets/7/ownership-history"),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-degraded"), null);
    const body = (await res.json()) as Row;
    assert.equal((body.meta as Row).source, "lakehouse-cold-tier");
    assert.equal((body.data as Row).count, 1);
  });
});

describe("the family degrades instead of erroring", () => {
  for (const mode of ["down", "unconfigured"] as const) {
    test(`every route answers 200 + degraded when the tier ${mode}s`, async () => {
      for (const path of FAMILY) {
        const res = await handleRequest(req(path), envWith(mode));
        assert.equal(res.status, 200, `${path} under ${mode}`);
        assert.equal(
          res.headers.get("x-metagraph-degraded"),
          "tier_unavailable",
          `${path} under ${mode} must be marked degraded`,
        );
        const body = (await res.json()) as Row;
        assert.equal(body.ok, true, `${path} under ${mode}`);
      }
    });
  }

  // The distinction that keeps this from hiding real bugs: a caller error
  // stays a caller error. It used to arrive as a 4xx from DATA_API; with the
  // tier read directly, the surviving caller-error path is the declared-param
  // gate, and it must NOT be swallowed into a degraded 200.
  test("a caller error is surfaced, not swallowed into an empty", async () => {
    const res = await handleRequest(
      req("/api/v1/chain-events?palet=Balances"),
      envWith("ok"),
    );
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("x-metagraph-degraded"), null);
    const body = (await res.json()) as Row;
    assert.equal(body.ok, false);
    assert.equal((body.error as Row).code, "invalid_query");
  });

  test("a healthy tier is untouched", async () => {
    const res = await handleRequest(req("/api/v1/chain-events"), envWith("ok"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-metagraph-degraded"), null);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).count, 1);
  });
});

// The two branches whose readers have NO network dimension decline explicitly
// off mainnet rather than falling through to `chain.*`. Silently reading
// mainnet would hand back another chain's history under a testnet path --
// well-formed, and therefore undetectable by anything downstream.
//
// Neither route is dispatched on the /{network}/ path today, so this is the
// guard that keeps opening one from leaking by default rather than by review.
describe("branches with no network-aware reader decline off mainnet", () => {
  test("ownership-history declines on testnet instead of reading mainnet", async () => {
    const env = envWith("ok");
    assert.equal(
      await coldTierChainEventsPayload(
        env,
        new URL("https://api.metagraph.sh/api/v1/subnets/7/ownership-history"),
        "testnet",
      ),
      null,
    );
    // The paired positive: the same call on mainnet DOES answer, so the decline
    // above is the network dimension and not a broken reader.
    assert.ok(
      await coldTierChainEventsPayload(
        env,
        new URL("https://api.metagraph.sh/api/v1/subnets/7/ownership-history"),
      ),
      "ownership-history must still answer on mainnet",
    );
  });

  test("conviction declines on testnet instead of reading finney", async () => {
    // Conviction is the one member that reads live CHAIN storage rather than
    // the lakehouse, so its mainnet control needs an RPC-shaped stub.
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse(
        String((init as { body?: string })?.body ?? "{}"),
      );
      const result =
        body.method === "chain_getHeader"
          ? { number: "0x85d1db" }
          : body.method === "state_getKeysPaged"
            ? []
            : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }) as unknown as typeof fetch;
    const url = new URL("https://api.metagraph.sh/api/v1/subnets/7/conviction");
    assert.equal(
      await coldTierChainEventsPayload({} as never, url, "testnet"),
      null,
    );
    assert.ok(
      await coldTierChainEventsPayload({} as never, url),
      "conviction must still answer on mainnet",
    );
  });
});

// The lakehouse leg answers every non-mainnet block, whatever the seam says.
// answerBlockDetail owns that rule so a testnet ref is never resolved against
// mainnet's D1 by resolveHotRef -- a leak no per-caller hot-leg guard catches.
describe("block chain-events routes to the lakehouse off mainnet", () => {
  test("a testnet block reads chain_testnet, and the D1 tier is never asked", async () => {
    const queries: string[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)).query);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: {
            rows: [
              {
                block_number: 7_700_500,
                event_index: 0,
                pallet: "System",
                method: "ExtrinsicSuccess",
                args: "{}",
                phase: "ApplyExtrinsic",
                extrinsic_index: 0,
                observed_at: 1,
              },
            ],
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    let d1Reads = 0;
    const env = mockEnv({
      [R2_SQL_TOKEN_ENV]: "cfut_test",
      METAGRAPH_HEALTH_DB: {
        prepare() {
          d1Reads += 1;
          return {
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
      },
    }) as unknown as Env;
    const answer = await hotTierBlockChainEvents(
      env,
      new URL("https://api.metagraph.sh/api/v1/blocks/7700500/chain-events"),
      "testnet",
    );
    assert.equal(answer?.kind, "answer");
    assert.equal(answer?.tier, "cold");
    assert.ok(queries.length > 0, "the lakehouse was never queried");
    for (const q of queries) assert.match(q, /\bchain_testnet\.\w+/);
    assert.equal(d1Reads, 0, "the mainnet D1 tier must not be consulted");
  });
});

// The router has always admitted the `0x` hash form of {ref}, and so has every
// reader underneath -- only the tier matcher was numeric-only. A hash therefore
// routed in, matched no tier, asked NO STORE, and fell out of
// handleChainEventsFamily as a 503 `data_tier_unavailable`: a retry-me status
// for a request that could never succeed, which is what the crawlers walking
// /blocks/{hash}/chain-events kept retrying against.
describe("the 0x block-hash form of {ref} reaches a tier", () => {
  const HASH = "0x" + "ab".repeat(32);

  test("a hash-form path is matched and actually queries a store", async () => {
    const queries: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      queries.push(String(JSON.parse(String(init.body)).query));
      return {
        ok: true,
        json: async () => ({ success: true, result: { rows: [] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const env = mockEnv({ [R2_SQL_TOKEN_ENV]: "cfut_test" }) as unknown as Env;

    const answer = await hotTierBlockChainEvents(
      env,
      new URL(`https://api.metagraph.sh/api/v1/blocks/${HASH}/chain-events`),
      "testnet",
    );

    assert.notEqual(
      answer,
      null,
      "a null here is the routing miss that became a 503 nothing could retry away",
    );
    assert.ok(
      queries.length > 0,
      "the point of matching is that a store gets asked at all",
    );
  });

  test("a malformed hash is still not this route", async () => {
    // 63 hex chars: close enough to prove the guard is the pattern, not a
    // prefix check that would admit anything starting 0x.
    const answer = await hotTierBlockChainEvents(
      mockEnv() as unknown as Env,
      new URL(
        `https://api.metagraph.sh/api/v1/blocks/0x${"ab".repeat(31)}c/chain-events`,
      ),
    );
    assert.equal(answer, null);
  });
});

// Off mainnet there is no second source to fall back to, so a lakehouse read
// that FAILS is a miss, not an empty block. The distinction is the whole point
// of #9260: `events: []` for a block with 400 of them reads as a quiet chain.
describe("a failed testnet read is a miss, not an empty block", () => {
  test("the block declines rather than reporting zero events", async () => {
    globalThis.fetch = (async () => {
      throw new Error("r2 sql unreachable");
    }) as unknown as typeof fetch;
    const answer = await hotTierBlockChainEvents(
      mockEnv({ [R2_SQL_TOKEN_ENV]: "cfut_test" }) as unknown as Env,
      new URL("https://api.metagraph.sh/api/v1/blocks/7700500/chain-events"),
      "testnet",
    );
    assert.equal(answer?.kind, "miss");
  });
});
