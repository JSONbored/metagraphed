// The attribution sweep's review queue (#11227).
//
// THE FIXTURES ARE REAL. Every source URL and address shape below came out of
// production's `attribution_candidates` on 2026-08-15, when the table held
// 4,913 rows from 87 sources — of which 25 sources accounted for 4,751:
// `https://77.creativebuilds.io/allHolders` alone carried **1,230 distinct
// addresses**, and `/api/miners`, `/snap/metagraph` and their kin carried the
// rest. Applying the listing rule left 162 rows across 49 subnets.
//
// A BUG HERE IS NEVER A CRASH. It is one of two things, and both look like a
// working page:
//
//   1. A LISTING LEAKS INTO THE QUEUE. Every address on a metagraph dump
//      belongs to somebody else, so a reviewer handed one is being asked to
//      judge 1,230 strangers' keys — and will stop reading the queue.
//   2. A BOUNDED PAGE READS AS THE POPULATION. `candidates.length` is trimmed
//      by `?limit=`; `reviewable_count` is not. Confusing them reports "162
//      candidates" as "200 candidates" the day the queue grows past the limit.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";

// The route and the MCP tool both reach the store through `new Client(...)`
// inside src/read-store.ts, which a caller cannot inject into -- so the `pg`
// module is the seam. See tests/helpers/pg-mock.ts.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  buildAttributionCandidatesReview,
  declineAttributionCandidatesReview,
  loadAttributionCandidateTotals,
  loadAttributionCandidates,
  ATTRIBUTION_CANDIDATES_TABLE,
  type AttributionCandidatesDb,
  type AttributionCandidatesTotals,
} from "../src/attribution-candidates-review.ts";
import { AttributionCandidatesReviewArtifactSchema } from "../schemas-src/routes/attribution-candidates-review.ts";
import { LISTING_ADDRESS_CAP } from "../src/attribution-sweep.ts";
import {
  ATTRIBUTION_CANDIDATES_LIMIT_DEFAULT,
  ATTRIBUTION_CANDIDATES_LIMIT_MAX,
} from "../src/route-limits.ts";
import { ATTRIBUTION_SWEEP_TABLES } from "../src/read-store-tables.ts";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { pgMockEnv } from "./helpers/pg-mock.ts";

const FIRST_SEEN = 1_786_749_000_000;
const LAST_SEEN = 1_786_800_000_000;

/** A page carrying one address — the shape a team's own treasury page has. */
const TEAM_PAGE = "https://taostats.io/about";
/** The real listing that dominated the table. */
const LISTING = "https://77.creativebuilds.io/allHolders";

function row(over: Record<string, unknown> = {}) {
  return {
    netuid: 64,
    ss58: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
    source_url: TEAM_PAGE,
    first_seen: FIRST_SEEN,
    last_seen: LAST_SEEN,
    source_address_count: 1,
    ...over,
  };
}

const TOTALS: AttributionCandidatesTotals = {
  reviewable: 162,
  suppressed: 4_751,
  suppressedSources: 25,
};

/** A store whose every query answers `rows`, recording what it was asked. */
function db(rows: unknown[], capture: { sql: string[]; values: unknown[][] }) {
  return {
    async query<T>(sql: string, values: unknown[] = []) {
      capture.sql.push(sql);
      capture.values.push(values);
      return rows as T[];
    },
  } satisfies AttributionCandidatesDb;
}

const cap = () => ({ sql: [] as string[], values: [] as unknown[][] });

describe("buildAttributionCandidatesReview", () => {
  test("carries the address, the page and the subnet on every candidate", () => {
    const body = buildAttributionCandidatesReview([row()], TOTALS, {
      limit: 200,
      offset: 0,
    });
    const [candidate] = body.candidates as Record<string, unknown>[];
    assert.equal(candidate!.netuid, 64);
    assert.equal(
      candidate!.ss58,
      "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
    );
    // THE REVIEW IS OPENING THIS. A row a reviewer cannot trace to a document
    // is not reviewable, which is why it is required rather than nullable.
    assert.equal(candidate!.source_url, TEAM_PAGE);
    assert.equal(candidate!.first_seen, new Date(FIRST_SEEN).toISOString());
    assert.equal(candidate!.last_seen, new Date(LAST_SEEN).toISOString());
    assert.equal(candidate!.source_address_count, 1);
  });

  // Failure #2 at the top of this file. The page count and the population are
  // different numbers and must never be derived from each other.
  test("the page count and the population are separate numbers", () => {
    const body = buildAttributionCandidatesReview(
      [row(), row({ netuid: 8 })],
      TOTALS,
      {
        limit: 2,
      },
    );
    assert.equal(body.candidate_count, 2);
    assert.equal(body.reviewable_count, 162);
    assert.notEqual(body.candidate_count, body.reviewable_count);
  });

  // A filter a caller cannot see is one they cannot check.
  test("the suppression and the rule behind it are published", () => {
    const body = buildAttributionCandidatesReview([row()], TOTALS);
    assert.equal(body.suppressed_count, 4_751);
    assert.equal(body.suppressed_source_count, 25);
    assert.equal(body.listing_address_cap, LISTING_ADDRESS_CAP);
  });

  // A failed COUNT must not become a claim about the population. Defaulting it
  // to the page length is the specific lie this guards.
  test("unreadable totals are null, never the page length", () => {
    const body = buildAttributionCandidatesReview(
      [row(), row({ netuid: 8 })],
      null,
    );
    assert.equal(body.candidate_count, 2);
    assert.equal(body.reviewable_count, null);
    assert.equal(body.suppressed_count, null);
    assert.equal(body.suppressed_source_count, null);
    // The RULE is a constant, so it survives a failed read.
    assert.equal(body.listing_address_cap, LISTING_ADDRESS_CAP);
  });

  // The three fields that make a row reviewable are the three it is dropped for
  // lacking. A candidate with no address, no page or no subnet is not a
  // smaller review item, it is not one at all.
  test("a row missing the address, the page or the subnet is dropped", () => {
    const body = buildAttributionCandidatesReview(
      [
        row(),
        row({ ss58: null }),
        row({ ss58: "" }),
        row({ source_url: null }),
        row({ netuid: null }),
      ],
      TOTALS,
    );
    assert.equal(body.candidate_count, 1);
  });

  // A NUMERIC STRING IS KEPT, not dropped. node-postgres hands back BIGINT as a
  // string whenever the value is not exactly representable, and while `netuid`
  // is an INTEGER column today, dropping a row for arriving in the driver's
  // other numeric shape would lose a real candidate to a type surprise --
  // strictly worse than coercing a value that is unambiguous.
  test("a numeric-string netuid is coerced rather than discarded", () => {
    const body = buildAttributionCandidatesReview(
      [row({ netuid: "64" })],
      TOTALS,
    );
    assert.equal(body.candidate_count, 1);
    assert.equal((body.candidates as Record<string, unknown>[])[0]!.netuid, 64);
    // But a non-integer is still not a netuid.
    assert.equal(
      buildAttributionCandidatesReview([row({ netuid: "6.4" })], TOTALS)
        .candidate_count,
      0,
    );
  });

  test("an unreadable timestamp is null rather than 1970", () => {
    for (const value of [null, 0, -1, "nope", 8.64e15 * 2]) {
      const body = buildAttributionCandidatesReview(
        [row({ first_seen: value, last_seen: value })],
        TOTALS,
      );
      const [candidate] = body.candidates as Record<string, unknown>[];
      assert.equal(candidate!.first_seen, null, String(value));
      assert.equal(candidate!.last_seen, null, String(value));
    }
  });

  test("null and non-array input degrade to an empty queue, not a throw", () => {
    for (const input of [null, undefined, "nope" as unknown]) {
      const body = buildAttributionCandidatesReview(input as never, TOTALS);
      assert.deepEqual(body.candidates, []);
      assert.equal(body.candidate_count, 0);
      // And the population is still reported: an empty PAGE is not an empty
      // table, which is exactly what a reviewer paging past the end sees.
      assert.equal(body.reviewable_count, 162);
    }
  });

  // The echo is what lets a caller confirm the request they got answered --
  // "162 candidates" means something different scoped to one subnet. Both
  // builders publish it, and an omitted filter is null rather than invented.
  test("the request is echoed back, with an omitted filter as null", () => {
    const scoped = buildAttributionCandidatesReview([row()], TOTALS, {
      netuid: 64,
      limit: 50,
      offset: 10,
    });
    assert.deepEqual(
      { netuid: scoped.netuid, limit: scoped.limit, offset: scoped.offset },
      { netuid: 64, limit: 50, offset: 10 },
    );
    const wide = buildAttributionCandidatesReview([row()], TOTALS);
    assert.deepEqual(
      { netuid: wide.netuid, limit: wide.limit, offset: wide.offset },
      { netuid: null, limit: null, offset: null },
    );
    const declined = declineAttributionCandidatesReview("unavailable");
    assert.deepEqual(
      {
        netuid: declined.netuid,
        limit: declined.limit,
        offset: declined.offset,
      },
      { netuid: null, limit: null, offset: null },
    );
  });

  test("the payload validates against the route's own schema", () => {
    const parsed = AttributionCandidatesReviewArtifactSchema.safeParse(
      buildAttributionCandidatesReview([row(), row({ netuid: 8 })], TOTALS, {
        netuid: undefined,
        limit: 200,
        offset: 0,
      }),
    );
    assert.equal(
      parsed.success,
      true,
      JSON.stringify(parsed.error?.issues ?? []),
    );
  });
});

describe("declineAttributionCandidatesReview", () => {
  // NULL, not zero. Zero would assert the sweep has found nothing — the lane's
  // most important NEGATIVE result — and a failed read must never manufacture
  // it.
  test("a decline reports unknown counts rather than an empty finding", () => {
    const body = declineAttributionCandidatesReview("unavailable", {
      netuid: 64,
      limit: 200,
      offset: 0,
    });
    assert.deepEqual(body.degraded, { reason: "unavailable" });
    assert.equal(body.candidate_count, null);
    assert.equal(body.reviewable_count, null);
    assert.equal(body.suppressed_count, null);
    assert.deepEqual(body.candidates, []);
    assert.equal(body.netuid, 64);
    assert.equal(
      AttributionCandidatesReviewArtifactSchema.safeParse(body).success,
      true,
    );
  });
});

describe("loadAttributionCandidates", () => {
  test("applies the listing rule at READ time, with the cap as a bound value", async () => {
    const c = cap();
    await loadAttributionCandidates(db([], c), {});
    // The rule is derived from the table, not trusted from the writer.
    assert.match(c.sql[0]!, /COUNT\(DISTINCT ss58\) AS addrs/);
    assert.match(c.sql[0]!, /WHERE p\.addrs <= \?/);
    // BOUND, never interpolated: the cap is a module constant today, and a
    // literal here is the shape that becomes an injection the day it is not.
    assert.equal(c.values[0]![0], LISTING_ADDRESS_CAP);
    assert.doesNotMatch(c.sql[0]!, new RegExp(`<= ${LISTING_ADDRESS_CAP}`));
  });

  test("reads the table the sweep writes, and one the caller declared", async () => {
    const c = cap();
    await loadAttributionCandidates(db([], c), {});
    assert.match(c.sql[0]!, new RegExp(`FROM ${ATTRIBUTION_CANDIDATES_TABLE}`));
    assert.equal(
      ATTRIBUTION_SWEEP_TABLES.includes(
        ATTRIBUTION_CANDIDATES_TABLE as (typeof ATTRIBUTION_SWEEP_TABLES)[number],
      ),
      true,
      "the handler's declared table set must cover this read",
    );
  });

  // An unstable ORDER BY under an OFFSET silently drops and repeats rows across
  // a reviewer's pagination — the one failure mode that makes a queue lose work
  // while looking fine.
  test("orders to a total, deterministic key", async () => {
    const c = cap();
    await loadAttributionCandidates(db([], c), {});
    assert.match(
      c.sql[0]!,
      /ORDER BY c\.netuid ASC, c\.last_seen DESC, c\.ss58 ASC, c\.source_url ASC/,
    );
  });

  test("the netuid filter is optional, and bound when present", async () => {
    const wide = cap();
    await loadAttributionCandidates(db([], wide), { limit: 50, offset: 10 });
    assert.doesNotMatch(wide.sql[0]!, /c\.netuid = \?/);
    assert.deepEqual(wide.values[0], [LISTING_ADDRESS_CAP, 50, 10]);

    const scoped = cap();
    await loadAttributionCandidates(db([], scoped), {
      netuid: 64,
      limit: 50,
      offset: 10,
    });
    assert.match(scoped.sql[0]!, /AND c\.netuid = \?/);
    assert.deepEqual(scoped.values[0], [LISTING_ADDRESS_CAP, 64, 50, 10]);
  });

  test("defaults the page bound rather than reading unbounded", async () => {
    const c = cap();
    await loadAttributionCandidates(db([], c), {});
    assert.deepEqual(c.values[0], [
      LISTING_ADDRESS_CAP,
      ATTRIBUTION_CANDIDATES_LIMIT_DEFAULT,
      0,
    ]);
    assert.ok(
      ATTRIBUTION_CANDIDATES_LIMIT_DEFAULT <= ATTRIBUTION_CANDIDATES_LIMIT_MAX,
    );
  });

  test("an unbound store and a throwing one are the same decline", async () => {
    assert.equal(await loadAttributionCandidates(null), null);
    assert.equal(await loadAttributionCandidates({}), null);
    assert.equal(
      await loadAttributionCandidates({
        async query() {
          throw new Error("relation does not exist");
        },
      }),
      null,
    );
  });
});

describe("loadAttributionCandidateTotals", () => {
  test("counts both sides of the rule in one pass over the whole table", async () => {
    const c = cap();
    const totals = await loadAttributionCandidateTotals(
      db(
        [{ reviewable: "162", suppressed: "4751", suppressed_sources: "25" }],
        c,
      ),
      {},
    );
    // No LIMIT: the counts describe the population, and a bounded count is the
    // defect this route publishes a total to avoid.
    assert.doesNotMatch(c.sql[0]!, /LIMIT/);
    assert.deepEqual(c.values[0], [
      LISTING_ADDRESS_CAP,
      LISTING_ADDRESS_CAP,
      LISTING_ADDRESS_CAP,
    ]);
    // node-postgres returns COUNT(*) as a STRING whenever the value is not
    // exactly representable — parsed, never asserted to be a number.
    assert.deepEqual(totals, {
      reviewable: 162,
      suppressed: 4_751,
      suppressedSources: 25,
    });
  });

  test("scoping to a netuid binds it and keeps the rule", async () => {
    const c = cap();
    await loadAttributionCandidateTotals(db([{}], c), { netuid: 64 });
    assert.match(c.sql[0]!, /WHERE c\.netuid = \?/);
    assert.equal(c.values[0]![3], 64);
  });

  test("a missing row, an unbound store and a throw are all a decline", async () => {
    assert.equal(await loadAttributionCandidateTotals(null), null);
    assert.equal(await loadAttributionCandidateTotals({}), null);
    assert.equal(await loadAttributionCandidateTotals(db([], cap()), {}), null);
    assert.equal(
      await loadAttributionCandidateTotals({
        async query() {
          throw new Error("nope");
        },
      }),
      null,
    );
  });

  test("an unreadable count is 0 rather than NaN", async () => {
    const totals = await loadAttributionCandidateTotals(
      db(
        [{ reviewable: "nope", suppressed: -1, suppressed_sources: null }],
        cap(),
      ),
      {},
    );
    assert.deepEqual(totals, {
      reviewable: 0,
      suppressed: 0,
      suppressedSources: 0,
    });
  });
});

// The rule is the sweep's, stated once. If these ever disagree the queue and
// the writer are filtering to different populations, which is invisible from
// either side.
describe("the listing rule is the sweep's own", () => {
  test("the cap the reader applies is the cap the writer enforces", () => {
    assert.equal(typeof LISTING_ADDRESS_CAP, "number");
    assert.ok(LISTING_ADDRESS_CAP >= 1);
    // The real listing from production is over it by two orders of magnitude,
    // and the team page is under it — the rule separates them, which is the
    // whole claim.
    assert.ok(1_230 > LISTING_ADDRESS_CAP, LISTING);
    assert.ok(1 <= LISTING_ADDRESS_CAP, TEAM_PAGE);
  });
});

// Both surfaces run the SAME loader and the SAME builder, so what is worth
// testing here is that each reaches them, defaults its arguments the same way,
// and DECLINES rather than 500s when the store cannot answer -- the state every
// deployment without a Hyperdrive binding is in.
describe("the two surfaces over this queue", () => {
  const PATH = "/api/v1/review/attribution-candidates";

  /** The page query answers rows; the totals query answers the counts. Matched
   * by SQL substring, so each statement gets the shape it actually asked for. */
  function answerWith(rows: unknown[], totals: Record<string, unknown>) {
    pg.control.answers = [
      { match: "AS suppressed_sources", rows: [totals] },
      { match: ATTRIBUTION_CANDIDATES_TABLE, rows },
    ];
  }

  function tool() {
    const found = MCP_TOOLS.find(
      (t) => t.name === "list_review_attribution_candidates",
    );
    assert.ok(found, "the tool must be registered");
    return found;
  }

  const TOTALS_ROW = {
    reviewable: "162",
    suppressed: "4751",
    suppressed_sources: "25",
  };

  test("the route serves the queue with its population beside it", async () => {
    answerWith([row(), row({ netuid: 8 })], TOTALS_ROW);
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${PATH}?limit=2`),
      pgMockEnv() as never,
      {} as never,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.data.candidate_count, 2);
    // The page is 2 and the queue is 162 -- the distinction this route exists
    // to publish.
    assert.equal(body.data.reviewable_count, 162);
    assert.equal(body.data.suppressed_count, 4_751);
    assert.equal(body.data.listing_address_cap, LISTING_ADDRESS_CAP);
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
    assert.equal(body.data.candidate_count, null);
    assert.equal(body.data.reviewable_count, null);
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
    assert.equal(pg.control.queries.length, before, "no read was made");
  });

  test("a netuid outside the u16 range is refused by the router", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${PATH}?netuid=70000`),
      {} as never,
      {} as never,
    );
    assert.equal(res.status, 400);
  });

  test("the MCP tool serves the same queue, scoped and unscoped", async () => {
    answerWith([row()], TOTALS_ROW);
    const scoped = (await tool().handler({ netuid: 64, limit: 10, offset: 5 }, {
      env: pgMockEnv(),
    } as never)) as Record<string, unknown>;
    assert.equal(scoped.netuid, 64);
    assert.equal(scoped.limit, 10);
    assert.equal(scoped.offset, 5);
    assert.equal(scoped.candidate_count, 1);
    assert.equal(
      AttributionCandidatesReviewArtifactSchema.safeParse(scoped).success,
      true,
    );

    answerWith([row()], TOTALS_ROW);
    const wide = (await tool().handler({}, {
      env: pgMockEnv(),
    } as never)) as Record<string, unknown>;
    // The tool's own defaults, which must be the route's -- a looser bound on
    // one surface is simply the way around the other's.
    assert.equal(wide.netuid, null);
    assert.equal(wide.limit, ATTRIBUTION_CANDIDATES_LIMIT_DEFAULT);
    assert.equal(wide.offset, 0);
  });

  test("the MCP tool declines on an unreachable store, like the route", async () => {
    const body = (await tool().handler({}, { env: {} } as never)) as Record<
      string,
      unknown
    >;
    assert.deepEqual(body.degraded, { reason: "unavailable" });
    assert.equal(body.reviewable_count, null);
  });
});
