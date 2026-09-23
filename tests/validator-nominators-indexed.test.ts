import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { AccountEventsRow } from "../generated/lakehouse/types.ts";
import { foldValidatorNominators } from "../src/validator-nominators-indexed.ts";

const event = (
  coldkey: string | null,
  amount_tao: number | null,
  event_kind = "StakeAdded",
  observed_at = 100,
): AccountEventsRow => ({
  block_number: 1,
  event_index: 0,
  extrinsic_index: null,
  event_kind,
  hotkey: "validator",
  coldkey,
  netuid: 1,
  uid: 1,
  amount_tao,
  alpha_amount: null,
  observed_at,
});
async function* stream(rows: AccountEventsRow[]) {
  yield* rows;
}
const query = { sort: "net_staked", limit: 20, offset: 0 };

it("matches independent SQL groups, nullable sums, ties, physical duplicates and pagination", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE events(coldkey TEXT, amount_tao REAL, event_kind TEXT, observed_at INTEGER)",
    );
    const rows = [
      event("z", null),
      event("a", null, "StakeRemoved"),
      event(null, 0),
      event("zero", 0),
      event("b", 5),
      event("b", 2, "StakeRemoved", 200),
      event("b", 5),
      event("c", 9),
      event("d", 9),
      event("mixed", null),
      event("mixed", 4, "StakeRemoved", 300),
      event("only-out", 20, "StakeRemoved"),
      event("only-in", 20),
      event("c", 1, "StakeRemoved"),
      event("d", 1, "StakeRemoved"),
    ];
    const insert = db.prepare("INSERT INTO events VALUES(?,?,?,?)");
    for (const row of rows)
      insert.run(row.coldkey, row.amount_tao, row.event_kind, row.observed_at);
    for (const sort of ["net_staked", "gross_staked", "last_activity"]) {
      const column = {
        net_staked: "net_staked_tao",
        gross_staked: "gross_staked_tao",
        last_activity: "last_observed",
      }[sort];
      for (const coldkey of [null, "b", "missing"]) {
        for (const [limit, offset] of [
          [1, 0],
          [2, 1],
          [100, 0],
        ]) {
          const where = coldkey === null ? "" : " WHERE coldkey = ?";
          const binds = coldkey === null ? [] : [coldkey];
          const expected = db
            .prepare(
              `SELECT coldkey,
            COALESCE(SUM(CASE WHEN event_kind='StakeAdded' THEN amount_tao ELSE 0 END),0) AS staked_tao,
            COALESCE(SUM(CASE WHEN event_kind='StakeRemoved' THEN amount_tao ELSE 0 END),0) AS unstaked_tao,
            SUM(CASE WHEN event_kind='StakeAdded' THEN amount_tao ELSE -amount_tao END) AS net_staked_tao,
            SUM(amount_tao) AS gross_staked_tao, COUNT(*) AS event_count, MAX(observed_at) AS last_observed
            FROM events${where} GROUP BY coldkey ORDER BY ${column} DESC NULLS FIRST, coldkey ASC NULLS LAST LIMIT ?`,
            )
            .all(...binds, limit + offset);
          const count = db
            .prepare(
              `SELECT count(*) AS c FROM (SELECT coldkey FROM events${where} GROUP BY coldkey)`,
            )
            .get(...binds)!.c;
          for (const input of [rows, [...rows].reverse()]) {
            expect(
              await foldValidatorNominators(stream(input), {
                coldkey,
                sort,
                limit,
                offset,
              }),
            ).toEqual({ rows: expected, totalCount: count });
          }
        }
      }
    }
  } finally {
    db.close();
  }
});

it("bounds aggregate memory and rejects overflowing sums", async () => {
  async function* many() {
    for (let i = 0; i <= 131072; i++) yield event(String(i), 0);
  }
  await expect(foldValidatorNominators(many(), query)).rejects.toThrow(
    "group budget",
  );
  await expect(
    foldValidatorNominators(
      stream([event("a", Number.MAX_VALUE), event("a", Number.MAX_VALUE)]),
      query,
    ),
  ).rejects.toThrow("numeric range");
  expect(await foldValidatorNominators(stream([]), query)).toEqual({
    rows: [],
    totalCount: 0,
  });
});
