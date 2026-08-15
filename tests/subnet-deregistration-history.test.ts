// The deregistration-rank series (#10296).
//
// THE FIXTURES ARE REAL. Every subnet below is a row this lane actually wrote,
// read out of production Neon on 2026-08-15, and the expected ranks were
// cross-checked two ways before this file existed: once by replaying the pallet
// rule in SQL against the whole table, and once by running the builder over the
// full 129-row day. Both agreed -- 112 ranked, 16 immune, netuid 36 at rank 1,
// netuid 74 at rank 38.
//
// The trimmed field here keeps the subnets that make each rule bite:
//
//   36    rank 1 on the newest day, the lowest compared price among prunable
//   70    THE EVENT THIS SERIES EXISTS FOR: rank 1 on 08-10 and 08-11, then
//         re-registered on 08-12 at block 8,825,571 with its price collapsed to
//         4.0e-8, immune for another 863,870 blocks. The ranking called it two
//         days early, and a single day's answer shows none of it.
//   86    a NULL moving_price, which the pallet's ValueQuery compares as 0 --
//         and which would be rank 1 on price alone, but is immune
//   0      root, which get_network_to_prune() skips entirely
//
// A bug in this module is never a crash. It is a plausible ordering that is not
// the pallet's, or a rank asserted on a day the subnet could not be pruned at
// all -- so the assertions below are about the rule, not about the plumbing.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";

// The route and the MCP tool both reach the store through `new Client(...)`
// inside src/read-store.ts, which a caller cannot inject into -- so the `pg`
// module is the seam. See tests/helpers/pg-mock.ts for why it is a module mock.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  buildDeregistrationHistory,
  declineDeregistrationHistory,
  loadDeregistrationHistory,
  DEREGISTRATION_HISTORY_FIRST_DAY,
  DEREGISTRATION_HISTORY_TABLE,
  DEREGISTRATION_HISTORY_WINDOWS,
} from "../src/subnet-deregistration-history.ts";
import { DeregistrationHistoryArtifactSchema } from "../schemas-src/routes/subnet-deregistration-history.ts";
import { SUBNET_DEREGISTRATION_DAILY_TABLE } from "../src/subnet-deregistration-daily.ts";
import { SUBNET_DEREGISTRATION_HISTORY_PATH_PATTERN } from "../workers/config.ts";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { pgMockEnv } from "./helpers/pg-mock.ts";

const IMMUNITY = 864_000;
const CAPTURED_AT = 1_786_800_000_000;

/** The six days the lane has written, with their real pinned blocks. */
const BLOCKS: Record<string, number> = {
  "2026-08-10": 8_811_313,
  "2026-08-11": 8_818_513,
  "2026-08-12": 8_825_701,
  "2026-08-13": 8_832_903,
  "2026-08-14": 8_840_105,
  "2026-08-15": 8_847_303,
};

/** Real rows, netuid -> per-day (moving_price, registered_at_block). A single
 * entry means the value held across every day. */
const FIELD: Record<
  number,
  {
    price: (number | null) | Record<string, number | null>;
    reg: number | Record<string, number>;
  }
> = {
  // Root. Skipped by the pallet, so it must never appear in either list.
  0: { price: null, reg: 0 },
  36: {
    price: {
      "2026-08-10": 0.0018149488605558872,
      "2026-08-11": 0.001585506834089756,
      "2026-08-12": 0.0014941163826733828,
      "2026-08-13": 0.0014754103031009436,
      "2026-08-14": 0.001456729369238019,
      "2026-08-15": 0.0014414172619581223,
    },
    reg: 7_894_898,
  },
  70: {
    price: {
      "2026-08-10": 0.001424305373802781,
      "2026-08-11": 0.0013565670233219862,
      "2026-08-12": 4.0046870708465576e-8,
      "2026-08-13": 0.00043863081373274326,
      "2026-08-14": 0.001523241400718689,
      "2026-08-15": 0.0028657489456236362,
    },
    // The re-registration. Everything before 08-12 is the old subnet's block.
    reg: {
      "2026-08-10": 7_787_562,
      "2026-08-11": 7_787_562,
      "2026-08-12": 8_825_571,
      "2026-08-13": 8_825_571,
      "2026-08-14": 8_825_571,
      "2026-08-15": 8_825_571,
    },
  },
  // Immune the whole way, and unpriced -- the pair that would rank it FIRST on
  // a naive price sort.
  86: { price: null, reg: 8_693_284 },
  74: { price: 0.003763633780181408, reg: 5_086_205 },
  59: { price: 0.0019395886920392513, reg: 4_401_833 },
  27: { price: 0.002418492455035448, reg: 1_727_132 },
};

const DAYS = Object.keys(BLOCKS);

function pick<T>(value: T | Record<string, T>, day: string): T {
  return value !== null && typeof value === "object"
    ? (value as Record<string, T>)[day]!
    : (value as T);
}

/** The rows the loader would return for `days`, in its own order. */
function rows(days: readonly string[] = DAYS) {
  const out: Record<string, unknown>[] = [];
  for (const day of days) {
    for (const [netuid, spec] of Object.entries(FIELD)) {
      out.push({
        snapshot_date: day,
        netuid: Number(netuid),
        moving_price: pick(spec.price, day),
        registered_at_block: pick(spec.reg, day),
        subnet_mechanism: 1,
        network_immunity_period: IMMUNITY,
        pinned_block: BLOCKS[day],
        captured_at: CAPTURED_AT,
      });
    }
  }
  return out;
}

type Point = Record<string, unknown>;
const pointsOf = (body: Record<string, unknown>) => body.points as Point[];

describe("buildDeregistrationHistory", () => {
  // THE HEADLINE CASE. On 08-10 and 08-11 netuid 70 is what the chain would
  // prune next; on 08-12 it is immune with a fresh registration block. That is
  // a deregistration and re-registration, and the series is the only place it
  // is visible.
  test("shows netuid 70 at rank 1, then re-registered and immune", () => {
    const points = pointsOf(buildDeregistrationHistory(rows(), 70));
    assert.deepEqual(
      points.map((p) => [p.day, p.rank, p.immune]),
      [
        ["2026-08-10", 1, false],
        ["2026-08-11", 1, false],
        ["2026-08-12", null, true],
        ["2026-08-13", null, true],
        ["2026-08-14", null, true],
        ["2026-08-15", null, true],
      ],
    );
    const [before, after] = [points[1]!, points[2]!];
    assert.equal(before.registered_at_block, 7_787_562);
    assert.equal(after.registered_at_block, 8_825_571);
    // 130 blocks before that day's pin, and protected for a full period after.
    assert.equal(BLOCKS["2026-08-12"]! - 8_825_571, 130);
    assert.equal(
      after.blocks_until_prunable,
      8_825_571 + IMMUNITY - BLOCKS["2026-08-12"]!,
    );
  });

  // And the other side of the same event: netuid 36 inherits rank 1 the moment
  // 70 leaves the prunable field.
  test("netuid 36 inherits rank 1 when 70 becomes immune", () => {
    const points = pointsOf(buildDeregistrationHistory(rows(), 36));
    assert.deepEqual(
      points.map((p) => p.next_to_deregister),
      [70, 70, 36, 36, 36, 36],
    );
    assert.deepEqual(
      points.map((p) => p.rank),
      [2, 2, 1, 1, 1, 1],
    );
  });

  // The invariant the route lives or dies on. A rank on an immune day is a
  // standing the pallet never granted, and it is the one error that would look
  // entirely reasonable in a UI.
  test("an immune day carries no rank, and a prunable day always does", () => {
    for (const netuid of [70, 86, 74, 36, 59, 27]) {
      for (const p of pointsOf(buildDeregistrationHistory(rows(), netuid))) {
        if (p.immune === true)
          assert.equal(p.rank, null, `sn${netuid} ${p.day}`);
        else {
          assert.equal(typeof p.rank, "number", `sn${netuid} ${p.day}`);
          assert.ok((p.rank as number) >= 1);
          assert.ok((p.rank as number) <= (p.ranked_count as number));
        }
      }
    }
  });

  // Netuid 86 has NO moving price and would sort first on price alone -- the
  // exact mis-ordering #10285 was filed about. Immunity excludes it entirely.
  test("an unpriced, immune subnet is never rank 1", () => {
    const points = pointsOf(buildDeregistrationHistory(rows(), 86));
    assert.equal(points.length, 6);
    for (const p of points) {
      assert.equal(p.immune, true);
      assert.equal(p.rank, null);
      assert.equal(p.moving_price, null);
      // The pallet's ValueQuery makes an ABSENT entry compare as 0 -- which is
      // why immunity, not price, is what keeps it out of position one.
      assert.equal(p.comparison_price, 0);
      assert.notEqual(p.next_to_deregister, 86);
    }
  });

  // Root is skipped by get_network_to_prune(), so it has no series at all --
  // not an empty one with rows, and not a rank.
  test("root has no standing to report", () => {
    const body = buildDeregistrationHistory(rows(), 0);
    assert.deepEqual(body.points, []);
    assert.equal(body.point_count, 0);
    // Still a real answer rather than a decline: nothing failed to read.
    assert.equal(body.degraded, undefined);
    assert.equal(body.first_captured_day, DEREGISTRATION_HISTORY_FIRST_DAY);
  });

  test("the field size rides with every rank", () => {
    for (const p of pointsOf(buildDeregistrationHistory(rows(), 74))) {
      // Six of the seven fixture subnets are non-root; on every day exactly two
      // (70 after 08-12, and 86 throughout) are immune.
      assert.equal((p.ranked_count as number) + (p.immune_count as number), 6);
      assert.ok((p.ranked_count as number) > 0);
    }
  });

  test("points are oldest-first and the summary reports the depth it FOUND", () => {
    const body = buildDeregistrationHistory(rows(), 74);
    const days = pointsOf(body).map((p) => p.day as string);
    assert.deepEqual(days, [...days].sort());
    assert.equal(body.point_count, 6);
    assert.equal(body.oldest_day, "2026-08-10");
    assert.equal(body.newest_day, "2026-08-15");
    // The window ASKED for is echoed; the depth reported comes from the rows.
    assert.equal(
      (
        buildDeregistrationHistory(rows(), 74, { window: "180d" }) as Record<
          string,
          unknown
        >
      ).window,
      "180d",
    );
  });

  // The trap the pipeline series documents, on a sharper subject: a rank that
  // was not re-measured must not read as a rank that held steady.
  test("a repeated pinned_block is one observation, not two", () => {
    const repeated = rows(["2026-08-14", "2026-08-15"]).map((r) =>
      // Same block on both days, as a carried-forward capture would write.
      ({ ...r, pinned_block: BLOCKS["2026-08-14"] }),
    );
    const body = buildDeregistrationHistory(repeated, 74);
    assert.equal(body.point_count, 2);
    assert.equal(body.distinct_observations, 1);
    assert.deepEqual(
      pointsOf(body).map((p) => p.repeats_previous_observation),
      [false, true],
    );
    // And the honest case, for contrast: six distinct blocks, six observations.
    assert.equal(
      buildDeregistrationHistory(rows(), 74).distinct_observations,
      6,
    );
  });

  // A day whose inputs cannot be ranked is DROPPED, never emitted with null
  // cells -- "this subnet had no rank that day" is a different and false claim.
  test("a day with no pinned block or no immunity period is dropped", () => {
    for (const missing of ["pinned_block", "network_immunity_period"]) {
      const broken = rows(["2026-08-15"]).map((r) => ({
        ...r,
        [missing]: null,
      }));
      const body = buildDeregistrationHistory(
        [...rows(["2026-08-14"]), ...broken],
        74,
      );
      assert.deepEqual(
        pointsOf(body).map((p) => p.day),
        ["2026-08-14"],
        missing,
      );
    }
  });

  test("rows with no readable day are skipped rather than grouped together", () => {
    const body = buildDeregistrationHistory(
      [
        ...rows(["2026-08-15"]),
        { netuid: 74, snapshot_date: null },
        { netuid: 74 },
      ],
      74,
    );
    assert.equal(body.point_count, 1);
  });

  test("a subnet absent from a day is absent from the series, not null in it", () => {
    // 74 registered at 5,086,205, so drop it from the first two days as a
    // late-registering subnet would be.
    const partial = rows().filter(
      (r) =>
        !(
          r.netuid === 74 &&
          (r.snapshot_date === "2026-08-10" || r.snapshot_date === "2026-08-11")
        ),
    );
    const body = buildDeregistrationHistory(partial, 74);
    assert.deepEqual(
      pointsOf(body).map((p) => p.day),
      ["2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15"],
    );
    assert.equal(body.oldest_day, "2026-08-12");
  });

  test("null and non-array input degrade to an empty series, not a throw", () => {
    for (const input of [null, undefined, "nope" as unknown]) {
      const body = buildDeregistrationHistory(input as never, 74);
      assert.deepEqual(body.points, []);
      assert.equal(body.point_count, 0);
      assert.equal(body.oldest_day, null);
    }
  });

  // A day on which EVERY subnet is immune has no pruning order at all. The
  // pallet would prune nobody, so rank 1 does not exist -- and reporting a
  // `next_to_deregister` there would name a victim the chain has not chosen.
  test("a day where nothing is prunable names no next_to_deregister", () => {
    // Push every registration to just before the pin, so the whole field is
    // inside its immunity window.
    const allImmune = rows(["2026-08-15"]).map((r) => ({
      ...r,
      registered_at_block: BLOCKS["2026-08-15"]! - 1,
    }));
    const [point] = pointsOf(buildDeregistrationHistory(allImmune, 74));
    assert.equal(point!.immune, true);
    assert.equal(point!.rank, null);
    assert.equal(point!.ranked_count, 0);
    assert.equal(point!.next_to_deregister, null);
    assert.equal(point!.next_to_deregister_comparison_price, null);
  });

  // An unreadable cell is ABSENT, never coerced. A price that arrived as a
  // string would otherwise become NaN or 0 -- and 0 is the most prunable value
  // there is, so a bad read would promote a subnet to rank 1.
  test("an unreadable price is absent, not zero", () => {
    const dirty = rows(["2026-08-15"]).map((r) =>
      r.netuid === 74 ? { ...r, moving_price: "not a number" } : r,
    );
    const [point] = pointsOf(buildDeregistrationHistory(dirty, 74));
    assert.equal(point!.moving_price, null);
    // The pallet's ValueQuery is what makes the COMPARISON 0, which is a
    // property of the chain rather than of this read.
    assert.equal(point!.comparison_price, 0);
  });

  test("an unreadable or absent captured_at is null, never 1970 and never a crash", () => {
    for (const value of [null, 0, -1, "nope", 8.64e15 * 2]) {
      const dirty = rows(["2026-08-15"]).map((r) => ({
        ...r,
        captured_at: value,
      }));
      const [point] = pointsOf(buildDeregistrationHistory(dirty, 74));
      assert.equal(point!.captured_at, null, String(value));
    }
    // And the readable case, so the assertion above is not passing on nothing.
    const [ok] = pointsOf(buildDeregistrationHistory(rows(["2026-08-15"]), 74));
    assert.equal(ok!.captured_at, new Date(CAPTURED_AT).toISOString());
  });

  test("an omitted window is reported as null rather than invented", () => {
    assert.equal(buildDeregistrationHistory(rows(), 74).window, null);
    assert.equal(declineDeregistrationHistory("unavailable", 74).window, null);
  });

  test("the payload validates against the route's own schema", () => {
    const parsed = DeregistrationHistoryArtifactSchema.safeParse(
      buildDeregistrationHistory(rows(), 70, { window: "30d" }),
    );
    assert.equal(
      parsed.success,
      true,
      JSON.stringify(parsed.error?.issues ?? []),
    );
  });
});

describe("declineDeregistrationHistory", () => {
  // NULL, not zero. A zero would assert this subnet has never been ranked,
  // which is a measurement nobody made.
  test("a decline reports unknown counts rather than zero ones", () => {
    const body = declineDeregistrationHistory("unavailable", 74, {
      window: "7d",
    });
    assert.deepEqual(body.degraded, { reason: "unavailable" });
    assert.equal(body.point_count, null);
    assert.equal(body.distinct_observations, null);
    assert.deepEqual(body.points, []);
    assert.equal(body.first_captured_day, DEREGISTRATION_HISTORY_FIRST_DAY);
    assert.equal(
      DeregistrationHistoryArtifactSchema.safeParse(body).success,
      true,
    );
  });
});

describe("loadDeregistrationHistory", () => {
  function db(capture: { sql?: string; values?: unknown[] }) {
    return {
      async query<T>(sql: string, values?: unknown[]) {
        capture.sql = sql;
        capture.values = values;
        return [] as T[];
      },
    };
  }

  test("reads the lane's table and does NOT filter to one netuid", async () => {
    const capture: { sql?: string; values?: unknown[] } = {};
    await loadDeregistrationHistory(db(capture), {
      window: "7d",
      nowMs: Date.parse("2026-08-15T12:00:00.000Z"),
    });
    assert.match(
      capture.sql!,
      new RegExp(`FROM ${DEREGISTRATION_HISTORY_TABLE}`),
    );
    // The whole field, every day. Filtering here would return rows from which
    // no rank can be computed -- rank is relative.
    assert.doesNotMatch(capture.sql!, /netuid = \?/);
    assert.match(capture.sql!, /ORDER BY snapshot_date ASC, netuid ASC/);
    assert.deepEqual(capture.values, ["2026-08-08"]);
  });

  test("the window sets the cutoff, and an unknown one is a decline", async () => {
    const capture: { sql?: string; values?: unknown[] } = {};
    const nowMs = Date.parse("2026-08-15T12:00:00.000Z");
    await loadDeregistrationHistory(db(capture), { window: "180d", nowMs });
    assert.deepEqual(capture.values, ["2026-02-16"]);
    // A window the route never declared must not silently become the default.
    assert.equal(
      await loadDeregistrationHistory(db(capture), { window: "1y", nowMs }),
      null,
    );
  });

  test("an unbound store and a throwing one are the same decline", async () => {
    assert.equal(await loadDeregistrationHistory(null), null);
    assert.equal(await loadDeregistrationHistory({}), null);
    assert.equal(
      await loadDeregistrationHistory({
        async query() {
          throw new Error("relation does not exist");
        },
      }),
      null,
    );
  });
});

describe("wiring", () => {
  test("the loader reads the table the lane writes", () => {
    assert.equal(
      DEREGISTRATION_HISTORY_TABLE,
      SUBNET_DEREGISTRATION_DAILY_TABLE,
    );
  });

  test("the route pattern matches the published path and nothing near it", () => {
    const p = SUBNET_DEREGISTRATION_HISTORY_PATH_PATTERN;
    assert.equal(
      p.exec("/api/v1/subnets/74/deregistration-ranking/history")?.[1],
      "74",
    );
    // The network-wide current ranking is a DIFFERENT route.
    assert.equal(p.test("/api/v1/chain/deregistration-ranking"), false);
    assert.equal(p.test("/api/v1/subnets/74/deregistration-ranking"), false);
    assert.equal(
      p.test("/api/v1/subnets/abc/deregistration-ranking/history"),
      false,
    );
  });

  test("the windows are the four the schema declares", () => {
    assert.deepEqual(DEREGISTRATION_HISTORY_WINDOWS, [
      "7d",
      "30d",
      "90d",
      "180d",
    ]);
  });
});

// Both surfaces serve the SAME builder over the SAME loader, so the thing worth
// testing here is that each one reaches it -- and that each declines rather
// than 500s when the store cannot answer, which is the state every deployment
// without a Hyperdrive binding is in.
describe("the two surfaces over this series", () => {
  const PATH = "/api/v1/subnets/74/deregistration-ranking/history";

  function answerWith(rowsForQuery: unknown[]) {
    pg.control.answers = [
      { match: DEREGISTRATION_HISTORY_TABLE, rows: rowsForQuery },
    ];
  }

  function mcpTool() {
    const tool = MCP_TOOLS.find(
      (t) => t.name === "get_deregistration_ranking_history",
    );
    assert.ok(tool, "the tool must be registered");
    return tool;
  }

  test("the route serves the replayed series", async () => {
    answerWith(rows(["2026-08-14", "2026-08-15"]));
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${PATH}?window=7d`),
      pgMockEnv() as never,
      {} as never,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.point_count, 2);
    // Four prunable subnets in the trimmed field (36, 59, 27, 74 by compared
    // price); 70 and 86 are immune and root is skipped.
    assert.equal((body.data.points as Point[])[0]!.rank, 4);
    assert.equal((body.data.points as Point[])[0]!.ranked_count, 4);
  });

  test("the route declines rather than 500s when the store cannot answer", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${PATH}`),
      {} as never,
      {} as never,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    assert.deepEqual(body.data.degraded, { reason: "unavailable" });
    // NULL, not zero -- see declineDeregistrationHistory.
    assert.equal(body.data.point_count, null);
  });

  // The handler's own guard, ahead of any store read: an unsupported ?format=
  // is a caller error, and answering it with a JSON body would serve the wrong
  // content type rather than saying so.
  test("an unsupported response format is refused before the store is touched", async () => {
    const before = pg.control.queries.length;
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${PATH}?format=xml`),
      pgMockEnv() as never,
      {} as never,
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: { message?: string } };
    assert.match(String(body.error?.message ?? ""), /format must be one of/);
    assert.equal(pg.control.queries.length, before, "no read was made");
  });

  test("a window the route never declared is rejected by the router", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${PATH}?window=1y`),
      {} as never,
      {} as never,
    );
    assert.equal(res.status, 400);
  });

  test("the MCP tool serves the same series", async () => {
    answerWith(rows(["2026-08-14", "2026-08-15"]));
    const body = (await mcpTool().handler({ netuid: 74, window: "7d" }, {
      env: pgMockEnv(),
    } as never)) as Record<string, unknown>;
    assert.equal(body.point_count, 2);
    assert.equal(body.window, "7d");
    assert.equal(
      DeregistrationHistoryArtifactSchema.safeParse(body).success,
      true,
    );
  });

  test("the MCP tool declines on an unreachable store, like the route", async () => {
    const body = (await mcpTool().handler({ netuid: 74 }, {
      env: {},
    } as never)) as Record<string, unknown>;
    assert.deepEqual(body.degraded, { reason: "unavailable" });
    // The tool's own default window, not the route's -- they must agree.
    assert.equal(body.window, "30d");
  });
});
