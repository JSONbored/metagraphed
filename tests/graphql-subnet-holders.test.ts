// The `subnet_holders` GraphQL field (#9595).
//
// The point of this file is CROSS-SURFACE AGREEMENT, not that the resolver
// returns plausible JSON. GraphQL is the surface with a history of quietly
// disagreeing with its siblings here: #9540 found eleven resolvers answering a
// schema-valid `0` with an empty `errors` array while REST and MCP served real
// rows for every one of them, because each had a ladder whose only rung was a
// retired tier. A consumer cannot tell that apart from "the chain has no data".
//
// So the central assertion below runs the SAME database through the REST
// handler and through this resolver and requires the two payloads to match
// field for field. A resolver-local query that drifted from the shared loader
// would still pass every shape check and fail that one.
//
// The decline path gets the same treatment for the same reason. `holders: []`
// with a `degraded` block and `holders: []` without one are opposite claims —
// "we cannot rank this" versus "nobody holds any" — and GraphQL is exactly
// where that distinction has been lost before.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import { FIELD_COMPLEXITY, SDL, handleGraphQLRequest } from "../src/graphql.ts";
import { SUBNET_HOLDERS_LIMIT_MAX } from "../src/subnet-holders.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const MIGRATIONS = [
  "0011_nominator_positions.sql",
  "0019_hotkey_alpha.sql",
  "0021_hotkey_alpha_passes.sql",
  "0022_nominator_positions_hotkey_netuid.sql",
  "0023_nominator_positions_netuid.sql",
].map((file) =>
  fs.readFileSync(path.join(process.cwd(), "migrations/d1", file), "utf8"),
);

const NETUID = 74;
const PASS = 1_785_900_000_000;
const POSITIONS_AT = 1_785_953_674_407;
const ck = (n: number) => `5Coldkey${String(n).padStart(40, "0")}`;
const hk = (n: number) => `5Hotkey0${String(n).padStart(40, "0")}`;

let db: InstanceType<typeof DatabaseSync>;

function d1() {
  return {
    prepare(text: string) {
      const run = (values: unknown[]) => ({
        async all() {
          return { results: db.prepare(text).all(...(values as never[])) };
        },
        async first() {
          return db.prepare(text).get(...(values as never[])) ?? null;
        },
      });
      return { bind: (...values: unknown[]) => run(values), ...run([]) };
    },
  };
}

const env = () => ({ METAGRAPH_HEALTH_DB: d1() }) as unknown as Env;

async function gql(query: string, e: Env = env()) {
  const res = await handleGraphQLRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
    e,
  );
  return (await res.json()) as Row;
}

/** The same five holders the REST suite uses: 250/200/150/100/50 on a 1,000
 * alpha pool, inserted out of rank order. */
function fiveHolders() {
  db.prepare(
    `INSERT INTO hotkey_alpha_passes
       (captured_at, expected_rows, received_rows, completed_at)
     VALUES (?, ?, ?, ?)`,
  ).run(PASS, 1, 1, PASS + 1000);
  db.prepare(
    `INSERT INTO hotkey_alpha (hotkey, netuid, total_alpha, captured_at)
     VALUES (?, ?, ?, ?)`,
  ).run(hk(1), NETUID, 1000, PASS);
  for (const [coldkey, fraction] of [
    [ck(3), 0.15],
    [ck(1), 0.25],
    [ck(5), 0.05],
    [ck(2), 0.2],
    [ck(4), 0.1],
  ] as [string, number][]) {
    db.prepare(
      `INSERT INTO nominator_positions
         (coldkey, hotkey, netuid, share_fraction, captured_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(coldkey, hk(1), NETUID, fraction, POSITIONS_AT);
  }
}

const FULL_QUERY = (netuid: number, limit?: number) => `{
  subnet_holders(netuid: ${netuid}${limit === undefined ? "" : `, limit: ${limit}`}) {
    schema_version
    netuid
    limit
    holder_count
    total_alpha
    concentration { top5_share top10_share top20_share }
    captured_at
    positions_captured_at
    holders { coldkey alpha share_of_total hotkey_count }
    degraded { reason }
  }
}`;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const schema of MIGRATIONS) db.exec(schema);
});

describe("subnet_holders agrees with REST over the same database", () => {
  test("the ranking is field-for-field identical", async () => {
    fiveHolders();
    const viaGraphql = ((await gql(FULL_QUERY(NETUID, 3))).data as Row)
      .subnet_holders as Row;

    const restRes = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/subnets/${NETUID}/holders?limit=3`,
      ),
      env(),
      {} as unknown as ExecutionContext,
    );
    const viaRest = ((await restRes.json()) as Row).data as Row;

    // GraphQL types `degraded` as an object and REST omits the key entirely on a
    // healthy read, so that one field is compared separately below; everything
    // else must match exactly.
    assert.equal(viaGraphql.degraded, null);
    assert.equal(viaRest.degraded, undefined);
    const { degraded: _g, ...gqlRest } = viaGraphql;
    const { degraded: _r, ...restRest } = viaRest;
    assert.deepEqual(gqlRest, restRest);
    // And the numbers are the ones the fixture describes, so a matching pair of
    // wrong answers cannot pass.
    assert.equal(viaGraphql.holder_count, 5);
    assert.equal(viaGraphql.total_alpha, 750);
    assert.deepEqual(
      (viaGraphql.holders as Row[]).map((h) => [h.coldkey, h.alpha]),
      [
        [ck(1), 250],
        [ck(2), 200],
        [ck(3), 150],
      ],
    );
  });

  test("the aggregates stay whole-subnet under a smaller limit", async () => {
    fiveHolders();
    const card = ((await gql(FULL_QUERY(NETUID, 2))).data as Row)
      .subnet_holders as Row;
    assert.equal((card.holders as Row[]).length, 2);
    assert.equal(card.holder_count, 5);
    // top5 over the FULL set is the whole 750, not the 450 the page carries.
    assert.equal((card.concentration as Row).top5_share, 1);
  });

  test("an absent limit takes the shared default", async () => {
    fiveHolders();
    const card = ((await gql(FULL_QUERY(NETUID))).data as Row)
      .subnet_holders as Row;
    assert.equal(card.limit, 20);
    assert.equal((card.holders as Row[]).length, 5);
  });
});

describe("subnet_holders declines rather than answering zero", () => {
  test("an unproven pool ledger carries a reason, not an empty ranking", async () => {
    // Rows exist and would rank perfectly well — that is the danger. An empty
    // list with no reason would read as "nobody holds this subnet's alpha".
    const card = ((await gql(FULL_QUERY(NETUID))).data as Row)
      .subnet_holders as Row;
    assert.deepEqual(card.holders, []);
    assert.deepEqual(card.degraded, { reason: "pool_totals_unproven" });
    assert.equal(card.holder_count, null);
    assert.equal(card.total_alpha, null);
    assert.deepEqual(card.concentration, {
      top5_share: null,
      top10_share: null,
      top20_share: null,
    });
  });

  test("root declines with its own reason", async () => {
    fiveHolders();
    const card = ((await gql(FULL_QUERY(0))).data as Row).subnet_holders as Row;
    assert.deepEqual(card.degraded, { reason: "root_not_in_alpha_map" });
  });

  test("no D1 binding declines rather than erroring", async () => {
    const body = await gql(FULL_QUERY(NETUID), {} as Env);
    assert.equal(body.errors, undefined);
    assert.deepEqual(((body.data as Row).subnet_holders as Row).degraded, {
      reason: "unavailable",
    });
  });

  test("a declined read is still a schema-valid non-null card", async () => {
    // The field is `SubnetHolders!`, so a decline that returned null would
    // surface as a GraphQL error and take the whole query down with it.
    const body = await gql(`{ subnet_holders(netuid: ${NETUID}) { netuid } }`);
    assert.equal(body.errors, undefined);
    assert.equal(((body.data as Row).subnet_holders as Row).netuid, NETUID);
  });
});

describe("subnet_holders validates its limit rather than clamping", () => {
  // REST returns 400 on an over-ceiling limit. A GraphQL field that silently
  // substituted a different number would answer a question nobody asked.
  test.each([0, -1, SUBNET_HOLDERS_LIMIT_MAX + 1])(
    "limit %i is a BAD_USER_INPUT error",
    async (limit) => {
      const body = await gql(FULL_QUERY(NETUID, limit));
      const errors = body.errors as Row[];
      assert.equal(Array.isArray(errors), true);
      assert.match(String(errors[0].message), /limit must be an integer/);
      assert.equal(
        (errors[0].extensions as Row)?.code,
        "BAD_USER_INPUT",
        "the code is what a client branches on",
      );
    },
  );

  test("the ceiling itself is accepted", async () => {
    fiveHolders();
    const card = (
      (await gql(FULL_QUERY(NETUID, SUBNET_HOLDERS_LIMIT_MAX))).data as Row
    ).subnet_holders as Row;
    assert.equal(card.limit, SUBNET_HOLDERS_LIMIT_MAX);
  });
});

describe("the field is declared and priced", () => {
  test("the SDL exposes it with both arguments", () => {
    assert.match(
      SDL,
      /subnet_holders\(netuid: Int!, limit: Int\): SubnetHolders!/,
    );
    assert.match(SDL, /type SubnetHolders \{/);
    assert.match(SDL, /type SubnetHolder \{/);
  });

  test("it carries a complexity cost", () => {
    // An unpriced field is free to the depth/complexity limiter, so a query can
    // fan out across subnets without ever tripping the budget.
    assert.equal(typeof FIELD_COMPLEXITY.subnet_holders, "number");
    assert.equal(
      FIELD_COMPLEXITY.subnet_holders,
      FIELD_COMPLEXITY.subnet_concentration,
      "it costs what its per-subnet siblings do",
    );
  });

  test("the SDL documents that an empty list without a reason is a measurement", () => {
    // The one sentence a consumer has to read to use this field correctly.
    assert.match(SDL, /empty holders list WITHOUT a degraded block/);
  });
});
