// The account summary card's composition (#9263).
//
// Measured 2026-08-03 against the chain's top extrinsic signer:
// /accounts/{ss58}/events returned 100 events and /accounts/{ss58}/subnets a
// registration on netuid 46 with 54,085 TAO staked, while /accounts/{ss58}
// answered recent_events 0, event_kinds 0, registrations 0 -- and reported a
// source, as though it had measured them.
//
// The properties worth pinning are the ones a plausible implementation gets
// wrong: the registration leg must read the SAME rows /subnets reads, and a
// tier that exists and fails must DECLINE rather than publish a zero card
// that reads as fact.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ACCOUNT_REGISTRATIONS_SQL,
  ACCOUNT_SUMMARY_GAP_CODE,
  accountSummaryGapMessage,
  answerAccountSummary,
  loadAccountRegistrationsD1,
} from "../src/account-summary-card.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

const SS58 = "5Fv5t8frGG3MKtahp4WafKPmT5xZDbqWf8aFZpXyvjHTgzzx";

const NEURON_ROW = {
  netuid: 46,
  uid: 232,
  stake_tao: "54085.698671464",
  validator_permit: 1,
  active: 1,
};

const RECENT_EVENT = {
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

/** A lakehouse that answers all four of the summary reader's queries. */
function lakehouse({ fail = false }: { fail?: boolean } = {}) {
  const queries: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const sql = JSON.parse(String(init.body)).query as string;
    queries.push(sql);
    if (fail) return { ok: false, status: 500 } as unknown as Response;
    // Matched on each read's DISTINCTIVE clause. `count(DISTINCT netuid)` was
    // the aggregate's marker until #9282 split the distinct count into its own
    // GROUP BY subquery (R2 SQL refuses the ungrouped form -- 40015, scan
    // budget). A stub that still looks for it silently stops matching the
    // aggregate, which falls through to the event rows, and the loader then
    // declines -- so this test failed on main claiming the card was a gap.
    // Ordered so the subnet read is recognised before the cap probe: both
    // select count(*), only one groups by netuid.
    const rows = sql.includes("GROUP BY event_kind")
      ? [{ kind: "TimelockedWeightsCommitted", count: 100 }]
      : sql.includes("GROUP BY netuid")
        ? [{ sc: 1 }]
        : sql.includes("min(block_number) AS fb")
          ? [
              {
                c: 100,
                fb: 8_700_000,
                lb: 8_763_529,
                fo: 1_785_000_000_000,
                lo: 1_785_759_000_000,
              },
            ]
          : sql.includes("count(*) AS c FROM (")
            ? [{ c: 100 }]
            : [RECENT_EVENT];
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

/** A D1 that answers the neurons read (or throws, when `fail`). */
function d1({ rows = [NEURON_ROW], fail = false } = {}) {
  const seen: { sql: string; params: unknown[] }[] = [];
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            seen.push({ sql, params });
            return {
              async all() {
                if (fail) throw new Error("d1 down");
                return { results: rows };
              },
            };
          },
        };
      },
    },
    seen,
  };
}

describe("loadAccountRegistrationsD1", () => {
  test("runs the SAME bound query DATA_API's /subnets leg runs", async () => {
    // Same columns, same predicate, same order -- so the summary's
    // `registrations` and /subnets' `subnets` cannot come to disagree about
    // where one hotkey is registered.
    const db = d1();
    const rows = await loadAccountRegistrationsD1(db as never, SS58);
    assert.deepEqual(rows, [NEURON_ROW]);
    assert.equal(db.seen[0]!.sql, ACCOUNT_REGISTRATIONS_SQL);
    assert.deepEqual(db.seen[0]!.params, [SS58], "bound, never interpolated");
  });

  test("no binding is an empty list; a bound failure is a decline", async () => {
    // The difference is the whole point: a deployment without D1 has no neuron
    // snapshot to be missing, while a database that IS there and erroring is a
    // fault the card must not paper over.
    assert.deepEqual(await loadAccountRegistrationsD1({} as never, SS58), []);
    assert.deepEqual(await loadAccountRegistrationsD1(null, SS58), []);
    assert.equal(
      await loadAccountRegistrationsD1(d1({ fail: true }) as never, SS58),
      null,
    );
  });

  test("a non-array result set is an empty list, not a crash", async () => {
    const db = d1({ rows: null as never });
    assert.deepEqual(await loadAccountRegistrationsD1(db as never, SS58), []);
  });
});

describe("answerAccountSummary", () => {
  test("the card carries BOTH legs — events and current registrations", async () => {
    lakehouse();
    const answer = await answerAccountSummary(
      { ...d1(), [R2_SQL_TOKEN_ENV]: "cfut_test" } as never,
      SS58,
    );
    assert.equal(answer.kind, "answer");
    assert.ok(answer.kind === "answer");
    assert.equal(answer.data.event_count, 100);
    assert.equal(answer.data.event_kinds.length, 1);
    assert.equal(answer.data.recent_events.length, 1);
    // The leg #9263 found still missing after #9257 wired the event half.
    assert.deepEqual(answer.data.registrations, [
      {
        netuid: 46,
        uid: 232,
        stake_tao: 54085.698671464,
        validator_permit: true,
        active: true,
      },
    ]);
  });

  test("a configured lakehouse that cannot answer DECLINES, never a zero card", async () => {
    lakehouse({ fail: true });
    const answer = await answerAccountSummary(
      { ...d1(), [R2_SQL_TOKEN_ENV]: "cfut_test" } as never,
      SS58,
    );
    assert.equal(answer.kind, "gap");
  });

  test("a bound D1 that throws DECLINES too, even with the events leg healthy", async () => {
    // A card that is half measured and half zero carries nothing in the
    // payload to say which half is which.
    lakehouse();
    const answer = await answerAccountSummary(
      { ...d1({ fail: true }), [R2_SQL_TOKEN_ENV]: "cfut_test" } as never,
      SS58,
    );
    assert.equal(answer.kind, "gap");
  });

  test("a deployment with NO lakehouse misses — its zero card was always correct", async () => {
    // A self-hoster or CI run has no chain history to read at all, so there is
    // nothing to decline about.
    lakehouse();
    const answer = await answerAccountSummary(d1() as never, SS58);
    assert.equal(answer.kind, "miss");
  });

  test("an unusable address declines rather than scanning every account", async () => {
    lakehouse();
    const answer = await answerAccountSummary(
      { ...d1(), [R2_SQL_TOKEN_ENV]: "cfut_test" } as never,
      "not-an-address",
    );
    assert.equal(answer.kind, "gap");
  });
});

describe("accountSummaryGapMessage", () => {
  test("names the account, the cause, and the sibling route that still works", async () => {
    const message = accountSummaryGapMessage(SS58);
    assert.match(message, new RegExp(SS58));
    assert.match(
      message,
      /not an account without activity/,
      "the one sentence that separates this from a quiet account",
    );
    assert.match(message, new RegExp(`/api/v1/accounts/${SS58}/events`));
    assert.equal(ACCOUNT_SUMMARY_GAP_CODE, "account_summary_unavailable");
  });
});
