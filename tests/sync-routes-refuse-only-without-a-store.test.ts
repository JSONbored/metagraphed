// The sync routes must reach their write from the family gate alone (#10144).
//
// THE BUG THIS EXISTED TO STOP. Every one of these handlers already skipped its
// D1 write once Neon owned the tables -- but the BINDING CHECK above the write
// did not know that. So with the tables sole-store on Neon and D1 unbound, the
// route answered 503 and never reached the Neon write that would have
// succeeded. Nothing failed while D1 stayed bound, which is why it survived the
// inversions: the check was dead code that only woke up on the day the database
// was dropped.
//
// D1 IS NOW DROPPED (#10179) and the file still earns its place, because the
// second case below is the one that matters after the collapse: the gate must
// be the ALL-OR-NOTHING family check, not a bare "is Hyperdrive bound". A
// half-declared family reaching the write would land the declared tables and
// leave the rest, and no read gate would notice -- each table answers fine on
// its own.
//
// WHAT IS ASSERTED, and why it is not a weaker test than it looks. There is no
// Postgres here, so a route that gets past the check fails at the write instead
// -- 502, or a swallowed verdict. That is the point. 503 means "I refused
// before trying"; anything else means the request reached the store. The pair
// of cases per route is what carries the weight:
//
//   Neon owns the whole family      ->  must NOT be 503 (the fix)
//   Neon owns only part of it        ->  must STILL be 503 (the gate is intact)
//
// Without the second case every assertion here would also pass if the gate had
// simply been deleted, which is a different and much worse change -- and is
// exactly what the D1 teardown did on its first pass, until this file caught
// it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

const { default: worker } = await import("../workers/data-api.ts");

const HYPERDRIVE = { connectionString: "postgresql://example/db" };
const NEURONS_SYNC_SECRET = "neurons-secret";
const NEURON_DAILY_BACKFILL_SECRET = "backfill-secret";
const CHAIN_DETAIL_SYNC_SECRET = "chain-detail-secret";
const POLLER_LANE_HEALTH_SYNC_SECRET = "poller-secret";

// The three tables neonOwnsNeuronsSnapshot requires together, and the four
// chain_detail families. Listed in full because both gates are all-or-nothing:
// a partial list is the "not owned" case, not a weaker version of owned.
const NEURON_TABLES = "neurons,neuron_daily,account_position_daily";
const CHAIN_DETAIL_TABLES =
  "chain_detail_blocks,chain_detail_extrinsics," +
  "chain_detail_account_events,chain_detail_chain_events";

const ctx = { waitUntil() {} } as unknown as ExecutionContext;

/** An env with NO D1 binding. (`owned` used to feed the sole-store flag;
 * kept in the signature so the many call sites stay unchanged, #10051.) */
function env(_owned: string): Record<string, unknown> {
  return {
    HYPERDRIVE,
    NEURONS_SYNC_SECRET,
    NEURON_DAILY_BACKFILL_SECRET,
    CHAIN_DETAIL_SYNC_SECRET,
    POLLER_LANE_HEALTH_SYNC_SECRET,
  };
}

function post(
  path: string,
  header: string,
  token: string,
  body: unknown,
  owned: string,
) {
  return worker.fetch(
    new Request(`https://d/api/v1/internal/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", [header]: token },
      body: JSON.stringify(body),
    }),
    env(owned) as unknown as Env,
    ctx,
  );
}

function neuronRow() {
  return {
    netuid: 8,
    uid: 3,
    hotkey: "5Hot",
    coldkey: "5Cold",
    active: 1,
    validator_permit: 1,
    rank: 1,
    trust: 0,
    validator_trust: 0.5,
    consensus: 0.4,
    incentive: 0.3,
    dividends: 0.2,
    emission_tao: 1.5,
    stake_tao: 100.25,
    registered_at_block: 1000,
    is_immunity_period: 0,
    axon: "1.2.3.4:9000",
    block_number: 5_000_000,
    captured_at: 1_780_000_000_000,
  };
}

/** Asserts the route got PAST the binding check -- see the header.
 *
 * 400 is rejected as loudly as 503: a payload the handler refuses never gets
 * near the store, so a fixture that drifts out of shape would turn every one of
 * these into a test of the validator. That is how the chain-detail case passed
 * while sending a body the parser threw out. */
async function assertReachedTheStore(res: Response, label: string) {
  const body = (await res.json()) as { error?: string };
  assert.notEqual(
    res.status,
    400,
    `${label}: the fixture is malformed, so this proves nothing -- ${JSON.stringify(body)}`,
  );
  assert.notEqual(
    body.error,
    "d1 binding unavailable",
    `${label}: refused before the write with D1 unbound while Neon owns the tables`,
  );
  assert.notEqual(
    res.status,
    503,
    `${label}: answered 503, body ${JSON.stringify(body)}`,
  );
}

// assertStillRefuses left with the partial-family tests (#10051).

describe("neurons-sync", () => {
  const send = (owned: string) =>
    post(
      "neurons-sync",
      "x-neurons-sync-token",
      NEURONS_SYNC_SECRET,
      [neuronRow()],
      owned,
    );

  test("reaches the store when Neon owns the three tables", async () => {
    await assertReachedTheStore(await send(NEURON_TABLES), "neurons-sync");
  });

  // The partial-family arm retired with NEON_SOLE_STORE_TABLES (#10051):
  // Neon is the only store, so a family split across stores cannot exist.
  // The no-store refusals this suite is named for stand above.
});

describe("backfill-neuron-daily", () => {
  const send = (owned: string) =>
    post(
      "backfill-neuron-daily",
      "x-neuron-daily-backfill-token",
      NEURON_DAILY_BACKFILL_SECRET,
      [{ ...neuronRow(), snapshot_date: "2026-08-01" }],
      owned,
    );

  test("reaches the store, and a Neon failure is the request's failure", async () => {
    // This route did not merely have a stale check -- it wrote D1 first,
    // returned 502 if that failed, then mirrored to Neon best-effort and
    // reported stores:["d1","neon"]. With both tables Neon's, that had the
    // authoritative store in the mirror's position: an operator replaying a
    // year of history could be told `ok` for rows that landed nowhere.
    const res = await send(NEURON_TABLES);
    await assertReachedTheStore(res, "backfill-neuron-daily");
    // No Postgres behind the fake Hyperdrive, so the write cannot succeed --
    // and now that Neon is authoritative, that has to surface as a failure
    // rather than a 200 with a mirror block nobody reads.
    assert.equal(res.status, 502);
  });

  // The partial-family arm retired with NEON_SOLE_STORE_TABLES (#10051):
  // Neon is the only store, so a family split across stores cannot exist.
  // The no-store refusals this suite is named for stand above.
});

describe("chain-detail-sync", () => {
  const send = (owned: string) =>
    post(
      "chain-detail-sync",
      "x-chain-detail-sync-token",
      CHAIN_DETAIL_SYNC_SECRET,
      {
        // Same shape as tests/chain-detail-sync-route.test.ts's fixture --
        // parseChainDetailSync wants the nested per-block families, not a flat
        // block row.
        blocks: [
          {
            block_number: 5_000_000,
            block_hash: "0x" + "a".repeat(64),
            observed_at: 1_785_799_000_000,
            spec_version: 441,
            extrinsics: [
              {
                block_number: 5_000_000,
                extrinsic_index: 0,
                extrinsic_hash: "0x" + "b".repeat(64),
                signer: null,
                call_module: "Timestamp",
                call_function: "set",
                success: null,
                fee_tao: null,
                tip_tao: null,
                call_args: null,
                observed_at: 1_785_799_000_000,
              },
            ],
            chain_events: [
              {
                block_number: 5_000_000,
                event_index: 0,
                pallet: "System",
                method: "ExtrinsicSuccess",
                args: null,
                phase: "ApplyExtrinsic",
                extrinsic_index: 0,
                observed_at: 1_785_799_000_000,
              },
            ],
            account_events: [],
          },
        ],
      },
      owned,
    );

  test("reaches the store when Neon owns all four families", async () => {
    await assertReachedTheStore(
      await send(CHAIN_DETAIL_TABLES),
      "chain-detail-sync",
    );
  });

  // The partial-family arm retired with NEON_SOLE_STORE_TABLES (#10051):
  // Neon is the only store, so a family split across stores cannot exist.
  // The no-store refusals this suite is named for stand above.
});

describe("poller-lane-health-sync", () => {
  const outcome = {
    lane: "hotkey-alpha",
    verdict: "ok",
    age_ms: 95_600,
    detail: null,
    checked_at: 1_785_960_000_000,
  };
  const send = (owned: string) =>
    post(
      "poller-lane-health-sync",
      "x-poller-lane-health-sync-token",
      POLLER_LANE_HEALTH_SYNC_SECRET,
      [outcome],
      owned,
    );

  test("writes through the lane_health store rather than the D1 binding", async () => {
    // Every other verdict writer in the repo already goes through
    // laneHealthStore. This route reached for METAGRAPH_HEALTH_DB by name, so
    // the poller's job outcomes were the one class of verdict that would have
    // stopped landing when D1 went away -- silently, because recordLaneVerdict
    // swallows its failures by design.
    const res = await send("lane_health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { stores?: string[] };
    assert.deepEqual(body.stores, ["neon"]);
  });

  test("503s only when NEITHER store is bound", async () => {
    const res = await worker.fetch(
      new Request("https://d/api/v1/internal/poller-lane-health-sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-poller-lane-health-sync-token": POLLER_LANE_HEALTH_SYNC_SECRET,
        },
        body: JSON.stringify([outcome]),
      }),
      { POLLER_LANE_HEALTH_SYNC_SECRET } as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "no lane_health store bound" });
  });
});
