// A tier that declined must not answer `ok: true` with zeros and no header
// (#10270).
//
// `/api/v1/accounts/{ss58}/counterparties` answered `counterparty_count: 0,
// transfers_scanned: 0` for an account with 114, on roughly one request in
// five. `transfers_scanned: 0` is the tell: the route reported that it scanned
// nothing and concluded there was nothing. Its Postgres rung is `"retired"` in
// wrangler.jsonc, so the lakehouse read IS its tier -- and `src/r2-sql.ts`'s
// failure counter, declared with "same contract as the Postgres tier's
// fallback generation: a caller can snapshot this before a read and compare
// after", had no reader outside its own test file.
//
// TWO TESTS, because the route was never the interesting part. The first pins
// the reported case end to end, in both directions. The second asks the same
// question of the whole route table and answers it by DRIVING the router, so
// it covers a route added tomorrow without anyone editing this file: for every
// registered path, if the lakehouse declined while the request was served and
// the answer was still a 200, that 200 must say so.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import {
  degradedSnapshot,
  labelDegradedResponse,
} from "../workers/request-handlers/analytics.ts";
import { currentR2SqlFailureGeneration } from "../src/r2-sql.ts";
import { OFFSET_EMULATION_CAP } from "../src/r2-sql-blocks.ts";
import { API_ROUTES, FEED_ROUTES } from "../src/contracts.ts";
import { concretePath } from "./concrete-path.ts";

/** The account from the issue -- 114 counterparties, 196 transfers scanned. */
const SS58 = "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3";
const COUNTERPARTY = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

/**
 * Enough env for `isR2SqlConfigured` to say yes, and nothing else.
 *
 * That gate is the reason this has to be set: an UNCONFIGURED lakehouse
 * returns null without touching the counter, on the stated grounds that a
 * self-hoster with no lakehouse is not a fault. A test that left the token out
 * would therefore drive the same empty payload while proving nothing about the
 * case that matters -- the configured lakehouse that declined.
 */
const LAKEHOUSE_ENV = { R2_SQL_TOKEN: "test-token" } as unknown as Env;

const DEGRADED_HEADER = "x-metagraph-degraded";

async function withFetch<T>(
  stub: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/** The lakehouse unreachable: a transport throw, the shape a dropped socket
 * or an aborted query takes by the time `r2SqlQuery` sees it. */
const refusingLakehouse = (() => {
  throw new Error("r2 sql unreachable");
}) as unknown as typeof fetch;

/** The lakehouse answering, in R2 SQL's own envelope. */
function answeringLakehouse(rows: Record<string, unknown>[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ success: true, result: { rows } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function apiRequest(path: string): Request {
  return new Request(`https://api.metagraph.sh${path}`);
}

describe("the counterparties zero says it is a zero (#10270)", () => {
  test("a declining lakehouse produces a LABELLED empty card", async () => {
    const res = (await withFetch(refusingLakehouse, () =>
      handleRequest(
        apiRequest(`/api/v1/accounts/${SS58}/counterparties`),
        LAKEHOUSE_ENV,
        {},
      ),
    )) as Response;
    const body = (await res.json()) as {
      ok: boolean;
      data: { counterparty_count: number; transfers_scanned: number };
    };
    // Still a 200 and still schema-stable: #9146 settled that a public READ
    // degrades to a parseable empty rather than erroring. What changes is that
    // the caller can now tell which it got.
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.counterparty_count, 0);
    assert.equal(body.data.transfers_scanned, 0);
    assert.equal(res.headers.get(DEGRADED_HEADER), "tier_unavailable");
  });

  test("a measured answer carries NO label", async () => {
    // Without this the test above passes for the uninteresting reason that
    // every response is labelled, which would be a worse bug than the one
    // being fixed -- a marker on everything marks nothing.
    const res = (await withFetch(
      answeringLakehouse([
        {
          hotkey: SS58,
          coldkey: COUNTERPARTY,
          amount_tao: 1.5,
          block_number: 5_870_000,
          event_index: 0,
          observed_at: 1_785_000_000_000,
        },
      ]),
      () =>
        handleRequest(
          apiRequest(`/api/v1/accounts/${SS58}/counterparties`),
          LAKEHOUSE_ENV,
          {},
        ),
    )) as Response;
    const body = (await res.json()) as {
      data: { counterparty_count: number; transfers_scanned: number };
    };
    assert.equal(res.status, 200);
    assert.equal(body.data.counterparty_count, 1);
    assert.equal(body.data.transfers_scanned, 1);
    assert.equal(res.headers.get(DEGRADED_HEADER), null);
  });
});

describe("a page declined BEFORE the query says so too (#11142)", () => {
  /** Records every request, and refuses -- so "no query issued" is provable. */
  function countingLakehouse(calls: string[]): typeof fetch {
    return (async (input: unknown) => {
      calls.push(String(input));
      throw new Error("r2 sql unreachable");
    }) as unknown as typeof fetch;
  }

  test("a depth past OFFSET_EMULATION_CAP is labelled, not served as end-of-feed", async () => {
    // The sweep below cannot catch this one. It keys off the r2-sql failure
    // generation, and this decline is taken before any query is issued, so no
    // generation moves -- which is exactly how it reached production
    // unlabelled. Asserting `calls` is empty is what proves the label came
    // from the cap and not from a query that happened to fail.
    const calls: string[] = [];
    const res = (await withFetch(countingLakehouse(calls), () =>
      handleRequest(
        apiRequest(
          `/api/v1/extrinsics?limit=5&offset=${OFFSET_EMULATION_CAP + 10}`,
        ),
        LAKEHOUSE_ENV,
        {},
      ),
    )) as Response;
    const body = (await res.json()) as {
      data: { extrinsic_count: number; next_cursor: string | null };
    };

    assert.equal(calls.length, 0, "the cap must decline before querying");
    assert.equal(res.status, 200);
    // Still the schema-stable empty (#9146). What changes is that a caller can
    // now tell it apart from a real end-of-feed, which this payload is
    // otherwise byte-identical to.
    assert.equal(body.data.extrinsic_count, 0);
    assert.equal(body.data.next_cursor, null);
    assert.equal(res.headers.get(DEGRADED_HEADER), "tier_unavailable");
  });

  test("a depth within the cap still asks the lakehouse", async () => {
    // Non-vacuity for the assertion above: if the route short-circuited at
    // every depth, `calls.length === 0` would prove nothing about the cap.
    const calls: string[] = [];
    await withFetch(countingLakehouse(calls), () =>
      handleRequest(
        apiRequest("/api/v1/extrinsics?limit=5&offset=0"),
        LAKEHOUSE_ENV,
        {},
      ),
    );
    assert.ok(calls.length > 0, "a servable depth must reach the tier");
  });

  test("the call_hash arm is labelled too, having skipped the tier", async () => {
    // A second, independent way into the same operand: call_hash has no column
    // in the lakehouse table, so the read is skipped outright rather than
    // declined. Unlabelled, that answered "no extrinsics match this hash" for
    // a filter that was never evaluated.
    const calls: string[] = [];
    const res = (await withFetch(countingLakehouse(calls), () =>
      handleRequest(
        apiRequest(
          `/api/v1/extrinsics?limit=5&call_module=SubtensorModule&call_hash=0x${"a".repeat(64)}`,
        ),
        LAKEHOUSE_ENV,
        {},
      ),
    )) as Response;
    assert.equal(calls.length, 0, "call_hash must skip the tier");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(DEGRADED_HEADER), "tier_unavailable");
  });
});

describe("no registered route serves an unlabelled decline (#10270)", () => {
  /**
   * Both route tables, because they are two registries and a sweep of one
   * misses the other: `FEED_ROUTES` is separate from `API_ROUTES` by design
   * (#8703), and a family-wide invariant that only asked the bigger table
   * would be silently partial.
   */
  const EVERY_ROUTE = [...API_ROUTES, ...FEED_ROUTES];

  /**
   * The two anchors this sweep must reach, one per response path.
   *
   * `counterparties` goes through `envelopeResponse` with no edge cache -- the
   * 71-handler family #9110's fix never covered. `chain/weights` goes through
   * `withEdgeCache`, which had the labelling but not the r2-sql signal. If a
   * refactor stopped either from reaching the lakehouse, the sweep would go
   * quietly green on a smaller surface, so name them rather than trust a count.
   */
  const ANCHORS = [
    "/api/v1/accounts/{ss58}/counterparties",
    "/api/v1/chain/weights",
  ];

  test("every route that saw the lakehouse decline says so", async () => {
    const exercised: string[] = [];
    const unlabelled: string[] = [];
    const threw: string[] = [];

    await withFetch(refusingLakehouse, async () => {
      for (const route of EVERY_ROUTE) {
        const before = currentR2SqlFailureGeneration();
        let res: Response;
        try {
          res = (await handleRequest(
            apiRequest(concretePath(route.path)),
            LAKEHOUSE_ENV,
            {},
          )) as Response;
        } catch (error) {
          threw.push(`${route.path}: ${(error as Error).message}`);
          continue;
        }
        // The counter is the whole discriminator: a route that never asked the
        // lakehouse has nothing to declare, and needs no exemption entry here.
        if (currentR2SqlFailureGeneration() === before) continue;
        exercised.push(route.path);
        if (res.status === 200 && !res.headers.get(DEGRADED_HEADER)) {
          unlabelled.push(route.path);
        }
      }
    });

    assert.deepEqual(
      threw,
      [],
      "handleRequest has no top-level try/catch, so a throw here is a 500 in production",
    );
    assert.deepEqual(
      unlabelled,
      [],
      "these answered 200 after the lakehouse declined, with nothing to say so",
    );
    for (const anchor of ANCHORS) {
      assert.ok(
        exercised.includes(anchor),
        `${anchor} no longer reaches the lakehouse -- this sweep is measuring less than it thinks`,
      );
    }
  });
});

describe("what the router label refuses to touch", () => {
  // The four early returns, each stated once. Driving them through a route
  // would need a route that happens to be in each state, which is how a
  // condition ends up asserted by coincidence rather than on purpose.
  const stale = () => ({ ...degradedSnapshot(), r2Sql: -1 });

  test("a non-200 is left alone", () => {
    const res = new Response("{}", { status: 503 });
    labelDegradedResponse(res, stale());
    assert.equal(res.headers.get(DEGRADED_HEADER), null);
  });

  test("a handler's own wording survives", () => {
    // #9273: get_account_positions and its siblings can say WHY a zero is
    // untrustworthy. A generic `tier_unavailable` written over that would make
    // the specific reason unrecoverable.
    const res = new Response("{}", {
      status: 200,
      headers: { [DEGRADED_HEADER]: "position_ledger_incomplete" },
    });
    labelDegradedResponse(res, stale());
    assert.equal(
      res.headers.get(DEGRADED_HEADER),
      "position_ledger_incomplete",
    );
  });

  test("a measured answer is left alone", () => {
    const res = new Response("{}", { status: 200 });
    labelDegradedResponse(res, degradedSnapshot());
    assert.equal(res.headers.get(DEGRADED_HEADER), null);
  });

  test("a stable decline is labelled too, not only a tier failure", () => {
    const res = new Response("{}", { status: 200 });
    labelDegradedResponse(res, { ...degradedSnapshot(), unmeasured: -1 });
    assert.equal(res.headers.get(DEGRADED_HEADER), "tier_unavailable");
  });

  test("immutable headers are swallowed, not thrown", () => {
    // A body read back out of the edge cache. `withEdgeCache` only ever stored
    // a measured answer there, so the throw means a CONCURRENT request
    // degraded -- relabelling a known-good cached body on that evidence would
    // be the false positive, and a throw here would be a 500 on a request that
    // had a perfectly good answer in hand.
    let attempted = false;
    const frozen = {
      status: 200,
      headers: {
        has: () => false,
        set: () => {
          attempted = true;
          throw new TypeError("Can't modify immutable headers.");
        },
      },
    } as unknown as Response;
    labelDegradedResponse(frozen, stale());
    assert.equal(attempted, true, "the label must have been attempted");
  });
});
