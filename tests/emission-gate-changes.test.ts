// The emission-gate change log (src/emission-gate-changes.ts, #9615).
//
// Two properties carry the weight, and both are about not overstating what the
// data says.
//
// `predates_capture` MUST SURVIVE TO THE PAYLOAD. The sampler writes a row the
// first time it OBSERVES a value, not the first time that value changed — so
// such a row has a null `previous_value` and is not a governance event at all.
// Serving it unflagged would present the start of our observation as a change,
// which is a fabricated finding on exactly the timeline someone would cite. The
// count is published for the same reason: a reader tallying governance events
// has to subtract them.
//
// AND THE FEED IS UNIONED IN SQL, not merged in JS. Three separate top-N reads
// would return the newest N of EACH table, so a quiet table would pad the page
// with old rows while a busy one lost recent ones — and "the newest N changes"
// would be neither. The ordering test below is what pins that.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import {
  EMISSION_CHANGES_LIMIT_DEFAULT,
  EMISSION_CHANGES_LIMIT_MAX,
  EMISSION_CHANGE_KINDS,
  buildEmissionChanges,
  emissionChangesSql,
  loadEmissionChanges,
} from "../src/emission-gate-changes.ts";
import { handleRequest } from "../workers/api.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

// The real DDL, so every CHECK constraint (the source enum, the 0/1 booleans,
// the two-arm shape check on emission_flow_watch) is enforced in fixtures too.
const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0005_emission_gate.sql"),
  "utf8",
);

const T = 1_785_900_000_000;
let db: InstanceType<typeof DatabaseSync>;

function d1() {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              return { results: db.prepare(text).all(...(values as never[])) };
            },
          };
        },
      };
    },
  };
}
const env = () => ({ METAGRAPH_HEALTH_DB: d1() }) as unknown as Env;

function param(
  at: number,
  {
    name = "emission_gate_exponent",
    value = 3,
    prev = 2 as number | null,
    source = "governance",
    predates = 0,
    block = 8_000_000 as number | null,
  } = {},
) {
  db.prepare(
    `INSERT INTO emission_gate_param_history
       (param, value, previous_value, source, block_number, observed_at, predates_capture)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(name, value, prev, source, block, at, predates);
}
function subnetSwitch(
  at: number,
  netuid = 7,
  enabled = 1,
  prev: number | null = 0,
  predates = 0,
) {
  db.prepare(
    `INSERT INTO subnet_emission_enabled_history
       (netuid, enabled, previous_enabled, block_number, observed_at, predates_capture)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(netuid, enabled, prev, 8_000_000, at, predates);
}
// The table's CHECK is two-armed: ONLY `subnet_ema_tao_flow` may carry a netuid,
// and it must also carry an ema_block; every other item must have both NULL.
// Encoding that here rather than passing them independently means a fixture
// cannot express a row production could not hold -- which is the whole reason
// this suite loads the real DDL.
function flow(
  at: number,
  item: string = "net_tao_flow_enabled",
  netuid: number | null = null,
  isSet = 0,
) {
  const subnetScoped = item === "subnet_ema_tao_flow";
  db.prepare(
    `INSERT INTO emission_flow_watch
       (item, netuid, is_set, ema_block, block_number, observed_at, predates_capture)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    item,
    subnetScoped ? (netuid ?? 12) : null,
    isSet,
    subnetScoped ? 8_000_000 : null,
    8_000_000,
    at,
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

describe("predates_capture is never lost", () => {
  test("a first observation is flagged and counted separately", async () => {
    // The row shape the sampler writes when it first SEES a value: no previous
    // reading, so no change occurred.
    param(T, { prev: null, predates: 1 });
    param(T - 1000, { prev: 2, value: 3, predates: 0 });
    const card = buildEmissionChanges(await loadEmissionChanges(d1()));
    const first = (card.changes as Row[])[0];
    assert.equal(first.predates_capture, true);
    assert.equal(first.previous_value, null);
    assert.equal((card.changes as Row[])[1].predates_capture, false);
    // The count is what lets a reader subtract non-events from a tally.
    assert.equal(card.change_count, 2);
    assert.equal(card.predates_capture_count, 1);
  });

  test("the flag is a boolean on every kind, not just params", async () => {
    param(T, { predates: 1 });
    subnetSwitch(T - 1, 7, 1, null, 1);
    flow(T - 2);
    const card = buildEmissionChanges(await loadEmissionChanges(d1()));
    for (const c of card.changes as Row[]) {
      assert.equal(typeof c.predates_capture, "boolean");
    }
    assert.equal(card.predates_capture_count, 2);
  });
});

describe("one feed, three shapes", () => {
  test("each kind carries only its own fields", async () => {
    param(T);
    subnetSwitch(T - 1);
    flow(T - 2, "subnet_ema_tao_flow", 12, 1);
    const changes = buildEmissionChanges(await loadEmissionChanges(d1()))
      .changes as Row[];
    const byKind = Object.fromEntries(changes.map((c) => [c.kind, c]));

    // A network-wide parameter has no subnet. `netuid: null` would read as
    // "some subnet, unknown", which is why the field is ABSENT.
    assert.equal("netuid" in byKind.param, false);
    assert.equal(byKind.param.param, "emission_gate_exponent");
    assert.equal(byKind.param.source, "governance");

    // A switch has no numeric value.
    assert.equal("value" in byKind.subnet, false);
    assert.equal(byKind.subnet.netuid, 7);
    assert.equal(byKind.subnet.enabled, true);
    assert.equal(byKind.subnet.previous_enabled, false);

    assert.equal(byKind.flow.item, "subnet_ema_tao_flow");
    assert.equal(byKind.flow.netuid, 12);
    assert.equal(byKind.flow.is_set, true);
    assert.equal("value" in byKind.flow, false);
  });

  test("an unrecognised source is nulled rather than published", () => {
    // It reaches the payload as an enum the contract declares.
    const card = buildEmissionChanges([
      { kind: "param", observed_at: T, key: "x", source: "vibes" },
    ]);
    assert.equal((card.changes as Row[])[0].source, null);
  });

  test("a non-0/1 boolean is null, never false", () => {
    // `false` would assert the switch was OFF; null says it was unreadable.
    const card = buildEmissionChanges([
      {
        kind: "subnet",
        observed_at: T,
        netuid: 7,
        enabled: 9,
        previous_enabled: null,
      },
    ]);
    assert.equal((card.changes as Row[])[0].enabled, null);
    assert.equal((card.changes as Row[])[0].previous_enabled, null);
  });
});

describe("the feed is unioned, not merged per table", () => {
  test("newest-first ordering holds ACROSS the three tables", async () => {
    // Interleaved on purpose: a per-table merge would group them.
    param(T - 0);
    flow(T - 10);
    subnetSwitch(T - 20);
    param(T - 30);
    subnetSwitch(T - 40);
    const card = buildEmissionChanges(await loadEmissionChanges(d1()));
    assert.deepEqual(
      (card.changes as Row[]).map((c) => c.kind),
      ["param", "flow", "subnet", "param", "subnet"],
    );
  });

  test("the limit is the newest N overall, not the newest N of each", async () => {
    // Five params newer than any switch. A per-table top-2 would return 2
    // params AND 2 switches; the union returns the 2 newest, both params.
    for (let i = 0; i < 5; i += 1) param(T - i);
    subnetSwitch(T - 100);
    const card = buildEmissionChanges(
      await loadEmissionChanges(d1(), { limit: 2 }),
      { limit: 2 },
    );
    assert.equal(card.change_count, 2);
    assert.deepEqual(
      (card.changes as Row[]).map((c) => c.kind),
      ["param", "param"],
    );
  });

  test("?kind= restricts the union to one leg", async () => {
    param(T);
    subnetSwitch(T - 1);
    flow(T - 2);
    for (const kind of EMISSION_CHANGE_KINDS) {
      const card = buildEmissionChanges(
        await loadEmissionChanges(d1(), { kind }),
        { kind },
      );
      assert.equal(card.change_count, 1);
      assert.equal((card.changes as Row[])[0].kind, kind);
      assert.equal(card.kind, kind);
    }
  });

  test("the SQL names every leg it claims to", () => {
    const all = emissionChangesSql(10);
    for (const table of [
      "emission_gate_param_history",
      "subnet_emission_enabled_history",
      "emission_flow_watch",
    ]) {
      assert.match(all, new RegExp(table));
    }
    assert.match(all, /ORDER BY observed_at DESC LIMIT 10/);
    // A filtered read touches ONE table -- the others are not scanned.
    const only = emissionChangesSql(10, "param");
    assert.match(only, /emission_gate_param_history/);
    assert.doesNotMatch(only, /subnet_emission_enabled_history/);
  });
});

describe("buildEmissionChanges edges", () => {
  test("empty and unreadable inputs are cards, not throws", () => {
    for (const rows of [null, undefined, [], "nope" as unknown]) {
      const card = buildEmissionChanges(rows as never);
      assert.equal(card.change_count, 0);
      assert.equal(card.predates_capture_count, 0);
      assert.equal(card.latest_change_at, null);
      assert.deepEqual(card.changes, []);
    }
  });

  test("a row with no kind or no timestamp is dropped", () => {
    const card = buildEmissionChanges([
      { kind: null, observed_at: T },
      { kind: "param", observed_at: 0 },
      { kind: "param", observed_at: null },
      { kind: "param", observed_at: 1e300 },
      { kind: "param", observed_at: T, key: "ok" },
    ]);
    assert.equal(card.change_count, 1);
    assert.equal((card.changes as Row[])[0].param, "ok");
  });

  test("a non-integer block_number is null rather than rounded", () => {
    const card = buildEmissionChanges([
      { kind: "param", observed_at: T, block_number: 1.5 },
    ]);
    assert.equal((card.changes as Row[])[0].block_number, null);
  });

  test("no binding and a failed read both return null", async () => {
    assert.equal(await loadEmissionChanges(null), null);
    db.exec("DROP TABLE emission_flow_watch");
    assert.equal(await loadEmissionChanges(d1()), null);
  });

  test("a non-numeric value reads as unmeasured, not zero", () => {
    // Number("junk") is NaN and Number(null) is 0 -- so a bare Number() would
    // publish a missing gate parameter as a REAL SETTING OF ZERO, on the feed
    // whose whole purpose is saying what the gate was set to.
    for (const bad of ["junk", undefined, null, {}]) {
      const card = buildEmissionChanges([
        { kind: "param", observed_at: T, key: "x", value: bad },
      ]);
      assert.equal((card.changes as Row[])[0].value, null);
    }
    // And a genuine zero survives as a zero.
    const zero = buildEmissionChanges([
      { kind: "param", observed_at: T, key: "x", value: 0 },
    ]);
    assert.equal((zero.changes as Row[])[0].value, 0);
  });

  test("a driver returning no results object yields an empty feed", async () => {
    const shim = {
      prepare: () => ({ bind: () => ({ all: async () => null }) }),
    };
    const rows = await loadEmissionChanges(shim as never);
    assert.deepEqual(rows, []);
  });

  test("the limit pair is what the contract publishes", () => {
    assert.equal(EMISSION_CHANGES_LIMIT_DEFAULT, 50);
    assert.equal(EMISSION_CHANGES_LIMIT_MAX, 200);
  });
});

describe("GET /api/v1/chain/governance/emission-changes", () => {
  const get = (p: string, e?: Env) =>
    handleRequest(
      new Request(`https://api.metagraph.sh${p}`),
      e ?? env(),
      {} as unknown as ExecutionContext,
    );
  const body = async (res: Response) => {
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    return ((await res.json()) as Row).data as Row;
  };

  test("serves the feed", async () => {
    param(T);
    subnetSwitch(T - 1);
    const data = await body(
      await get("/api/v1/chain/governance/emission-changes"),
    );
    assert.equal(data.change_count, 2);
    assert.equal(data.limit, EMISSION_CHANGES_LIMIT_DEFAULT);
  });

  test("an empty log is the steady state, not a 404", async () => {
    const data = await body(
      await get("/api/v1/chain/governance/emission-changes"),
    );
    assert.equal(data.change_count, 0);
    assert.deepEqual(data.changes, []);
  });

  test("an unsupported kind is a 400", async () => {
    assert.equal(
      (await get("/api/v1/chain/governance/emission-changes?kind=nope")).status,
      400,
    );
  });

  test("an over-ceiling limit is rejected, not clamped", async () => {
    assert.equal(
      (
        await get(
          `/api/v1/chain/governance/emission-changes?limit=${EMISSION_CHANGES_LIMIT_MAX + 1}`,
        )
      ).status,
      400,
    );
  });

  test("an unknown query parameter is rejected", async () => {
    assert.equal(
      (await get("/api/v1/chain/governance/emission-changes?netuid=1")).status,
      400,
    );
  });

  test("no D1 binding is an empty feed rather than a 500", async () => {
    const data = await body(
      await get("/api/v1/chain/governance/emission-changes", {} as Env),
    );
    assert.equal(data.change_count, 0);
  });

  test("the path is exact, so a deeper path is not this route", async () => {
    const res = await get("/api/v1/chain/governance/emission-changes/extra");
    assert.notEqual(res.status, 200);
  });
});

describe("emission_changes over GraphQL and MCP", () => {
  test("GraphQL serves the same feed", async () => {
    param(T, { predates: 1, prev: null });
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `{ emission_changes { change_count predates_capture_count
            changes { kind observed_at predates_capture param value previous_value source } } }`,
        }),
      }),
      env(),
    );
    const card = (((await res.json()) as Row).data as Row)
      .emission_changes as Row;
    assert.equal(card.change_count, 1);
    assert.equal(card.predates_capture_count, 1);
    assert.equal((card.changes as Row[])[0].predates_capture, true);
  });

  test("GraphQL validates kind and limit", async () => {
    const bad = async (q: string) => {
      const res = await handleGraphQLRequest(
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
        }),
        env(),
      );
      return ((await res.json()) as Row).errors as Row[];
    };
    assert.match(
      String(
        (await bad(`{ emission_changes(kind: "nope") { kind } }`))[0].message,
      ),
      /kind must be one of/,
    );
    assert.match(
      String(
        (
          await bad(
            `{ emission_changes(limit: ${EMISSION_CHANGES_LIMIT_MAX + 1}) { limit } }`,
          )
        )[0].message,
      ),
      /limit must be an integer/,
    );
  });

  test("the MCP tool warns a model not to overcount", async () => {
    param(T);
    const tool = MCP_TOOLS.find((t) => t.name === "get_emission_changes");
    assert.ok(tool, "get_emission_changes is not registered");
    const card = (await tool.handler(
      { limit: EMISSION_CHANGES_LIMIT_MAX + 50 } as never,
      { env: env() } as never,
    )) as Row;
    assert.equal(card.limit, EMISSION_CHANGES_LIMIT_MAX);
    assert.equal(card.change_count, 1);
    // The single most misreadable field in this feed.
    assert.match(tool.description, /Subtract predates_capture_count/);
  });

  test("the MCP tool passes its kind filter through", async () => {
    param(T);
    subnetSwitch(T - 1);
    const tool = MCP_TOOLS.find((t) => t.name === "get_emission_changes");
    const card = (await tool!.handler(
      { kind: "subnet" } as never,
      { env: env() } as never,
    )) as Row;
    assert.equal(card.change_count, 1);
    assert.equal((card.changes as Row[])[0].kind, "subnet");
  });
});
