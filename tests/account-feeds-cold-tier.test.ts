// Same properties as the sibling cold tiers: no silent widening, parity via
// the shared formatters, data-api's exact cursor token and order — plus the
// equivalences specific to this module: the single OR standing in for
// data-api's two-scan transfer merge, the collapsed weight-setters UNION, and
// the collapsed counterparties UNION (see the module header for the
// arguments each test pins down).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadAccountCounterpartiesColdTier,
  loadAccountStakeFlowColdTier,
  loadAccountStakeMovesColdTier,
  loadAccountTransfersColdTier,
  loadAccountWeightSettersColdTier,
  loadCounterpartyRelationshipColdTier,
} from "../src/account-feeds-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };
const ADDR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const OTHER = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function transferRow(block: number, index = 0) {
  return {
    block_number: block,
    event_index: index,
    extrinsic_index: 1,
    event_kind: "Transfer",
    hotkey: ADDR,
    coldkey: OTHER,
    netuid: null,
    uid: null,
    amount_tao: "12.5",
    alpha_amount: null,
    observed_at: 1_700_000_000_000 + block,
  };
}

function sqlFetch(...responses: unknown[][]) {
  const queries: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    const rows = responses[Math.min(call, responses.length - 1)] ?? [];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

function failingFetch() {
  globalThis.fetch = (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch;
}

/** A D1 stub whose `neurons` read returns the given rows (or throws). */
function d1With(rows: unknown[] | (() => never)) {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          if (typeof rows === "function") rows();
          return { results: rows as unknown[] };
        },
      }),
    }),
  };
}

describe("loadAccountTransfersColdTier", () => {
  test("reads both sides with one disjunction on the Transfer kind, newest first", async () => {
    const q = sqlFetch([transferRow(10, 1), transferRow(10, 0)]);
    const data = await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
      limit: 2,
    });
    assert.equal(data!.transfer_count, 2);
    assert.equal(data!.transfers[0]!.direction, "sent");
    const s = q[0]!;
    assert.match(s, /event_kind = 'Transfer'/);
    assert.match(
      s,
      new RegExp(`\\(hotkey = '${ADDR}' OR coldkey = '${ADDR}'\\)`),
      "one OR stands in for data-api's two-scan merge — same row set",
    );
    assert.match(
      s,
      /ORDER BY observed_at DESC, block_number DESC, event_index DESC/,
    );
  });

  test("direction narrows to a single indexed side, exactly like data-api", async () => {
    const qSent = sqlFetch([transferRow(5)]);
    const sent = await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
      limit: 5,
      direction: "sent",
    });
    assert.match(qSent[0]!, new RegExp(`hotkey = '${ADDR}'`));
    assert.ok(!/ OR /.test(qSent[0]!), "no disjunction on a single side");
    assert.equal(sent!.transfers[0]!.direction, "sent");

    const qRecv = sqlFetch([
      { ...transferRow(5), hotkey: OTHER, coldkey: ADDR },
    ]);
    const received = await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
      limit: 5,
      direction: "received",
    });
    assert.match(qRecv[0]!, new RegExp(`coldkey = '${ADDR}'`));
    assert.equal(received!.transfers[0]!.direction, "received");

    const qAll = sqlFetch([transferRow(5)]);
    await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
      limit: 5,
      direction: "all",
    });
    assert.match(qAll[0]!, / OR /, "all reads both sides");
  });

  test("applies block-range filters and data-api's exact 3-part tuple seek", async () => {
    const q = sqlFetch([transferRow(5)]);
    await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
      limit: 5,
      blockStart: "100",
      blockEnd: 900,
      cursor: "1700000000950.950.2",
    });
    const s = q[0]!;
    assert.match(s, /block_number >= 100/);
    assert.match(s, /block_number <= 900/);
    assert.match(
      s,
      /\(observed_at, block_number, event_index\) < \(1700000000950, 950, 2\)/,
    );
  });

  test("declines an unusable address, direction, or range instead of widening", async () => {
    for (const [ss58, extra] of [
      ["not-an-address", {}],
      [ADDR, { direction: "sideways" }],
      [ADDR, { blockStart: -1 }],
      [ADDR, { blockEnd: "abc" }],
    ] as [string, Record<string, unknown>][]) {
      const q = sqlFetch([transferRow(1)]);
      assert.equal(
        await loadAccountTransfersColdTier(TOKEN as never, ss58, {
          limit: 5,
          ...extra,
        }),
        null,
        JSON.stringify(extra),
      );
      assert.equal(q.length, 0, "decline issues no query");
    }
  });

  test("invalid paging declines; a malformed cursor means page 1", async () => {
    const q = sqlFetch([transferRow(1)]);
    assert.equal(
      await loadAccountTransfersColdTier(TOKEN as never, ADDR, { limit: 0 }),
      null,
    );
    assert.equal(
      await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
        limit: 5,
        offset: 100_000,
      }),
      null,
    );
    assert.equal(q.length, 0);

    const q2 = sqlFetch([transferRow(9)]);
    const data = await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
      limit: 5,
      cursor: "junk",
    });
    assert.ok(data, "page 1, not a decline");
    assert.ok(!/junk/.test(q2[0]!));
  });

  test("offset is emulated by over-fetch + slice; a cursor page skips it", async () => {
    const q = sqlFetch([transferRow(9), transferRow(8), transferRow(7)]);
    const data = await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
      limit: 1,
      offset: 2,
    });
    assert.match(q[0]!, /LIMIT 3/);
    assert.equal(data!.transfers[0]!.block_number, 7);

    const q2 = sqlFetch([transferRow(9), transferRow(8)]);
    const paged = await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
      limit: 2,
      offset: 5,
      cursor: "1700000000009.9.0",
    });
    assert.match(q2[0]!, /LIMIT 2/, "no over-fetch on a cursor page");
    assert.equal(paged!.next_cursor, "1700000000008.8.0");
  });

  test("a short page carries no cursor; an unusable last row emits none; a failed query declines", async () => {
    sqlFetch([transferRow(3)]);
    const short = await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
      limit: 5,
    });
    assert.equal(short!.next_cursor, null);

    sqlFetch([{ ...transferRow(3), block_number: "bad" }]);
    const odd = await loadAccountTransfersColdTier(TOKEN as never, ADDR, {
      limit: 1,
    });
    assert.equal(odd!.next_cursor, null);

    failingFetch();
    assert.equal(
      await loadAccountTransfersColdTier(TOKEN as never, ADDR, { limit: 5 }),
      null,
    );
  });
});

describe("loadAccountStakeFlowColdTier", () => {
  const FLOW_ROW = {
    netuid: 7,
    event_kind: "StakeAdded",
    total_tao: "100",
    event_count: "2",
    last_observed: 1_700_000_000_500,
  };

  test("groups by (netuid, kind) over both stake kinds within the window", async () => {
    const q = sqlFetch([FLOW_ROW]);
    const res = await loadAccountStakeFlowColdTier(TOKEN as never, ADDR, {
      window: "7d",
    });
    const s = q[0]!;
    assert.match(
      s,
      new RegExp(`\\(hotkey = '${ADDR}' OR coldkey = '${ADDR}'\\)`),
    );
    assert.match(
      s,
      /\(event_kind = 'StakeAdded' OR event_kind = 'StakeRemoved'\)/,
      "the IN list rewritten as an OR — same row set",
    );
    assert.match(s, /GROUP BY netuid, event_kind/);
    const cutoff = Number(/observed_at >= (\d+)/.exec(s)![1]);
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    assert.ok(
      Math.abs(cutoff - expected) < 60_000,
      "request-time window math, same as data-api's windowCutoff",
    );
    assert.equal(res!.data.window, "7d");
    assert.equal(res!.data.total_staked_tao, 100);
    assert.equal(res!.generatedAt, new Date(1_700_000_000_500).toISOString());
  });

  test("direction narrows the kind; an unknown window falls back to the default", async () => {
    const qIn = sqlFetch([FLOW_ROW]);
    await loadAccountStakeFlowColdTier(TOKEN as never, ADDR, {
      direction: "in",
    });
    assert.match(qIn[0]!, /event_kind = 'StakeAdded'/);
    assert.ok(!/StakeRemoved/.test(qIn[0]!));

    const qOut = sqlFetch([FLOW_ROW]);
    const res = await loadAccountStakeFlowColdTier(TOKEN as never, ADDR, {
      window: "6000d",
      direction: "out",
    });
    assert.match(qOut[0]!, /event_kind = 'StakeRemoved'/);
    assert.equal(res!.data.window, "30d", "data-api's fallback, not an error");
  });

  test("a null SUM is coalesced to 0 client-side, matching data-api's COALESCE", async () => {
    sqlFetch([{ ...FLOW_ROW, total_tao: null }]);
    const res = await loadAccountStakeFlowColdTier(TOKEN as never, ADDR, {});
    assert.equal(res!.data.subnets[0]!.staked_tao, 0);
    assert.equal(
      res!.data.stake_events,
      2,
      "the group still counts its events",
    );
  });

  test("declines a bad address or direction without querying; a failed query yields null", async () => {
    const q = sqlFetch([FLOW_ROW]);
    assert.equal(
      await loadAccountStakeFlowColdTier(TOKEN as never, "junk", {}),
      null,
    );
    assert.equal(
      await loadAccountStakeFlowColdTier(TOKEN as never, ADDR, {
        direction: "up",
      }),
      null,
    );
    assert.equal(q.length, 0);
    failingFetch();
    assert.equal(
      await loadAccountStakeFlowColdTier(TOKEN as never, ADDR),
      null,
    );
  });
});

describe("loadAccountStakeMovesColdTier", () => {
  const MOVE_ROW = {
    netuid: 3,
    movements: "4",
    first_observed: 1_700_000_000_100,
    last_observed: 1_700_000_000_900,
  };

  test("groups StakeMoved by netuid over the window", async () => {
    const q = sqlFetch([MOVE_ROW]);
    const res = await loadAccountStakeMovesColdTier(TOKEN as never, ADDR, {
      window: "90d",
    });
    const s = q[0]!;
    assert.match(s, /event_kind = 'StakeMoved'/);
    assert.match(
      s,
      new RegExp(`\\(hotkey = '${ADDR}' OR coldkey = '${ADDR}'\\)`),
    );
    assert.match(s, /GROUP BY netuid$/);
    assert.equal(res!.data.total_movements, 4);
    assert.equal(res!.data.window, "90d");
    assert.equal(res!.generatedAt, new Date(1_700_000_000_900).toISOString());
  });

  test("an empty window answers zeros with a null generatedAt — an answer, not a decline", async () => {
    sqlFetch([]);
    const res = await loadAccountStakeMovesColdTier(TOKEN as never, ADDR);
    assert.equal(res!.data.total_movements, 0);
    assert.equal(res!.generatedAt, null);
  });

  test("declines a bad address without querying; a failed query yields null", async () => {
    const q = sqlFetch([MOVE_ROW]);
    assert.equal(
      await loadAccountStakeMovesColdTier(TOKEN as never, "junk", {}),
      null,
    );
    assert.equal(q.length, 0);
    failingFetch();
    assert.equal(
      await loadAccountStakeMovesColdTier(TOKEN as never, ADDR, {}),
      null,
    );
  });
});

describe("loadAccountWeightSettersColdTier", () => {
  const WS_ROW = {
    netuid: 11,
    weight_sets: "6",
    first_observed: 1_700_000_000_100,
    last_observed: 1_700_000_000_800,
  };
  const envWith = (db: unknown) =>
    ({ ...TOKEN, METAGRAPH_HEALTH_DB: db }) as never;

  test("collapses data-api's UNION into one disjunction over the D1 neuron slots", async () => {
    const q = sqlFetch([WS_ROW]);
    const res = await loadAccountWeightSettersColdTier(
      envWith(
        d1With([
          { netuid: 11, uid: 4 },
          { netuid: 20, uid: 9 },
        ]),
      ),
      ADDR,
      { window: "30d" },
    );
    const s = q[0]!;
    assert.match(s, /event_kind = 'WeightsSet'/);
    assert.match(
      s,
      new RegExp(
        `\\(hotkey = '${ADDR}' OR \\(\\(hotkey IS NULL OR hotkey = ''\\) AND ` +
          `\\(\\(netuid = 11 AND uid = 4\\) OR \\(netuid = 20 AND uid = 9\\)\\)\\)\\)`,
      ),
      "the two UNION ALL branches are disjoint, so one OR is the same multiset",
    );
    assert.match(s, /GROUP BY netuid$/);
    assert.equal(res!.data.total_weight_sets, 6);
    assert.equal(res!.data.window, "30d");
    assert.equal(res!.generatedAt, new Date(1_700_000_000_800).toISOString());
  });

  test("no registered slots leaves only the hotkey branch, like data-api's dropped UNION", async () => {
    const q = sqlFetch([WS_ROW]);
    const res = await loadAccountWeightSettersColdTier(
      envWith(d1With([])),
      ADDR,
      {},
    );
    assert.match(q[0]!, new RegExp(`AND hotkey = '${ADDR}' GROUP BY`));
    assert.ok(!/uid =/.test(q[0]!));
    assert.equal(res!.data.window, "7d", "the route's own default window");
  });

  test("declines without the slot source: no binding, a D1 failure, or an unusable slot", async () => {
    for (const db of [
      undefined,
      {},
      d1With(() => {
        throw new Error("d1 down");
      }),
      d1With([{ netuid: "bad", uid: 1 }]),
      d1With([{ netuid: 1, uid: null }]),
      { prepare: () => ({ bind: () => ({}) }) }, // no .all on this D1 shim
    ]) {
      const q = sqlFetch([WS_ROW]);
      assert.equal(
        await loadAccountWeightSettersColdTier(envWith(db), ADDR, {}),
        null,
      );
      assert.equal(q.length, 0, "decline issues no lakehouse query");
    }
  });

  test("declines a bad address before touching D1; a failed query yields null", async () => {
    const q = sqlFetch([WS_ROW]);
    assert.equal(
      await loadAccountWeightSettersColdTier(
        envWith(
          d1With(() => {
            throw new Error("never reached");
          }),
        ),
        "junk",
        {},
      ),
      null,
    );
    assert.equal(q.length, 0);
    failingFetch();
    assert.equal(
      await loadAccountWeightSettersColdTier(envWith(d1With([])), ADDR),
      null,
    );
  });
});

describe("loadAccountCounterpartiesColdTier", () => {
  test("aggregates the capped newest-first Transfer scan through the shared builder", async () => {
    const q = sqlFetch([transferRow(10), transferRow(9)]);
    const data = await loadAccountCounterpartiesColdTier(TOKEN as never, ADDR, {
      limit: 5,
    });
    const s = q[0]!;
    assert.match(s, /event_kind = 'Transfer'/);
    assert.match(
      s,
      new RegExp(`\\(hotkey = '${ADDR}' OR coldkey = '${ADDR}'\\)`),
    );
    assert.match(s, /LIMIT 5000$/, "data-api's exact scan cap");
    assert.equal(data!.counterparty_count, 1);
    assert.equal(data!.counterparties[0]!.address, OTHER);
    assert.equal(data!.counterparties[0]!.sent_tao, 25);
  });

  test("declines a bad address without querying; a failed query yields null", async () => {
    const q = sqlFetch([transferRow(1)]);
    assert.equal(
      await loadAccountCounterpartiesColdTier(TOKEN as never, "junk", {}),
      null,
    );
    assert.equal(q.length, 0);
    failingFetch();
    assert.equal(
      await loadAccountCounterpartiesColdTier(TOKEN as never, ADDR),
      null,
    );
  });
});

describe("loadCounterpartyRelationshipColdTier", () => {
  test("reads the pair in both orientations and reproduces data-api's composite payload", async () => {
    const q = sqlFetch([
      transferRow(10),
      { ...transferRow(9), hotkey: OTHER, coldkey: ADDR },
    ]);
    const data = await loadCounterpartyRelationshipColdTier(
      TOKEN as never,
      ADDR,
      OTHER,
      { limit: 50 },
    );
    assert.match(
      q[0]!,
      new RegExp(
        `\\(\\(hotkey = '${ADDR}' AND coldkey = '${OTHER}'\\) OR ` +
          `\\(hotkey = '${OTHER}' AND coldkey = '${ADDR}'\\)\\)`,
      ),
    );
    assert.equal(data!.counterparty_count, 1);
    assert.equal(data!.relationship.transfer_count, 2);
    assert.equal(data!.counterparties[0]!.net_tao, 0);
    assert.equal(
      data!.relationship.last_seen_at,
      null,
      "observed_at is stripped so this tier matches data-api's projection",
    );
  });

  test("no transfers between the pair yields the empty composite, not a decline", async () => {
    sqlFetch([]);
    const data = await loadCounterpartyRelationshipColdTier(
      TOKEN as never,
      ADDR,
      OTHER,
    );
    assert.equal(data!.counterparty_count, 0);
    assert.deepEqual(data!.counterparties, []);
    assert.equal(data!.relationship.transfer_count, 0);
  });

  test("declines a bad address on either side without querying; a failed query yields null", async () => {
    const q = sqlFetch([transferRow(1)]);
    assert.equal(
      await loadCounterpartyRelationshipColdTier(TOKEN as never, "junk", OTHER),
      null,
    );
    assert.equal(
      await loadCounterpartyRelationshipColdTier(TOKEN as never, ADDR, "junk"),
      null,
    );
    assert.equal(q.length, 0);
    failingFetch();
    assert.equal(
      await loadCounterpartyRelationshipColdTier(TOKEN as never, ADDR, OTHER),
      null,
    );
  });
});
