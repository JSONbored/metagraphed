// The block-window walk that bounds every scattered-key read on
// `chain.account_events` (#11131).
//
// The property under test is not "it adds a WHERE clause" -- it is that adding
// one does not change the answer. A cold-tier read here either returns exactly
// what the unbounded query returned or declines, so every test below compares
// the walk's output against the rows a single unbounded scan would have handed
// back over the same fixture.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ACCOUNT_EVENTS_BLOCK_WINDOW,
  MAX_WINDOW_STEPS,
  WINDOW_GROWTH,
  windowedFloorRead,
  windowedRowRead,
} from "../src/account-events-window.ts";

type Row = Record<string, unknown>;

const HEAD = 8_800_000;

/**
 * An engine that honours the block bound, so the walk is measured against a
 * table rather than against a stub that replays itself.
 *
 * A double that ignored the range would report the walk collecting the same
 * rows once per window and would prove nothing about the reassembly.
 */
function engine(rows: Row[], { fail = -1 }: { fail?: number } = {}) {
  const seen: string[] = [];
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    if (seen.length - 1 === fail) return null;
    const lo = Number(/block_number >= (\d+)/.exec(sql)?.[1] ?? 0);
    const hiMatch = /block_number <= (\d+)/.exec(sql);
    const hi = hiMatch ? Number(hiMatch[1]) : Number.POSITIVE_INFINITY;
    const limit = Number(/LIMIT (\d+)\s*$/.exec(sql)?.[1] ?? rows.length);
    return rows
      .filter(
        (r) => Number(r.block_number) >= lo && Number(r.block_number) <= hi,
      )
      .sort((a, b) => Number(b.block_number) - Number(a.block_number))
      .slice(0, limit);
  };
  return { query, seen };
}

const head = async () => HEAD;

function rowsAt(...blocks: number[]): Row[] {
  return blocks.map((block_number) => ({ block_number }));
}

const feed = (rows: Row[], need: number, extra: Record<string, unknown> = {}) =>
  windowedRowRead<Row>({} as never, {
    table: "chain.account_events",
    columns: "block_number",
    where: ["hotkey = 'x'"],
    order: " ORDER BY block_number DESC",
    need,
    headBlock: head as never,
    ...extra,
  });

describe("windowedRowRead", () => {
  test("ONE window when the newest rows fill the page", async () => {
    // The common case and the whole point: a busy account never widens, so it
    // pays one bounded query where it used to pay a full-table scan.
    const e = engine(rowsAt(HEAD - 10, HEAD - 20, HEAD - 30));
    const rows = await feed(rowsAt(), 2, { query: e.query });
    assert.equal(e.seen.length, 1);
    assert.deepEqual(rows, rowsAt(HEAD - 10, HEAD - 20));
  });

  test("the walk returns EXACTLY what one unbounded scan would have", async () => {
    // Rows scattered across four windows, deliberately including one below the
    // first widening so the concatenation has to span slices.
    const table = rowsAt(HEAD - 10, HEAD - 400_000, HEAD - 3_000_000, 12);
    const e = engine(table);
    const walked = await feed(rowsAt(), 4, { query: e.query });
    const unbounded = [...table].sort(
      (a, b) => Number(b.block_number) - Number(a.block_number),
    );
    assert.deepEqual(walked, unbounded, "the bound must not change the answer");
    assert.ok(e.seen.length > 1, "this fixture must exercise widening");
  });

  test("the newest slice carries NO ceiling; later slices do", async () => {
    // A row can reach the lakehouse before the decode watermark advances past
    // it, so capping the newest slice at the head would silently drop the top
    // of the feed. Later slices need their ceiling to stay disjoint.
    const e = engine(rowsAt(HEAD + 500, 10));
    const rows = await feed(rowsAt(), 2, { query: e.query });
    assert.doesNotMatch(e.seen[0]!, /block_number <= /);
    assert.match(e.seen[1]!, /block_number <= /);
    assert.deepEqual(
      rows,
      rowsAt(HEAD + 500, 10),
      "a row above the watermark must still be returned",
    );
  });

  test("slices are strictly disjoint and descending", async () => {
    const e = engine(rowsAt(1));
    await feed(rowsAt(), 5, { query: e.query });
    const floors = e.seen.map((s) => Number(/>= (\d+)/.exec(s)![1]));
    const ceils = e.seen.slice(1).map((s) => Number(/<= (\d+)/.exec(s)![1]));
    for (let i = 0; i < ceils.length; i++) {
      assert.ok(
        ceils[i]! < floors[i]!,
        `slice ${i + 1} must sit below slice ${i}'s floor`,
      );
    }
  });

  test("a failed slice fails the whole read", async () => {
    // A short page whose shortness has no visible cause is the silently-wrong
    // answer this family declines rather than serves.
    const e = engine(rowsAt(HEAD - 10, 5), { fail: 1 });
    assert.equal(await feed(rowsAt(), 5, { query: e.query }), null);
  });

  test("an unreadable head falls back to the unbounded query, not a decline", async () => {
    // The window is an optimisation over a query that worked without one.
    // Declining here would trade a slow answer for no answer.
    for (const unusable of [null, Number.NaN, -1]) {
      const e = engine(rowsAt(HEAD - 10));
      const rows = await feed(rowsAt(), 1, {
        query: e.query,
        headBlock: (async () => unusable) as never,
      });
      assert.equal(e.seen.length, 1);
      assert.doesNotMatch(e.seen[0]!, /block_number >=/);
      assert.deepEqual(rows, rowsAt(HEAD - 10));
    }
  });

  test("a cursor starts the walk at its own block, not the head", async () => {
    const e = engine(rowsAt(HEAD - 10, 4_000_000));
    await feed(rowsAt(), 1, { query: e.query, ceiling: 5_000_000 });
    assert.match(e.seen[0]!, /block_number >= 4750000/);
  });

  test("the walk stops at block 0 rather than running past it", async () => {
    const e = engine([]);
    await feed([], 1, { query: e.query });
    const floors = e.seen.map((s) => Number(/>= (\d+)/.exec(s)![1]));
    assert.equal(floors.at(-1), 0, "the last slice must reach the bottom");
    assert.ok(
      e.seen.length <= MAX_WINDOW_STEPS,
      `${e.seen.length} slices exceeds the step cap`,
    );
  });

  test("the step cap holds even when block 0 is unreachable", async () => {
    // A head far past the real chain, so widening never lands on zero within
    // the cap. Without the cap this loops forever.
    const e = engine([]);
    await windowedRowRead<Row>({} as never, {
      table: "chain.account_events",
      columns: "block_number",
      where: ["hotkey = 'x'"],
      order: " ORDER BY block_number DESC",
      need: 1,
      query: e.query,
      headBlock: (async () => Number.MAX_SAFE_INTEGER) as never,
    });
    assert.equal(e.seen.length, MAX_WINDOW_STEPS);
  });
});

describe("windowedFloorRead", () => {
  const aggregate = (
    e: ReturnType<typeof engine>,
    satisfiedAt: number,
    extra: Record<string, unknown> = {},
  ) =>
    windowedFloorRead<Row[]>({} as never, {
      headBlock: head as never,
      query: e.query,
      attempt: (bound, run) =>
        run({} as never, `SELECT x FROM chain.account_events WHERE a${bound}`),
      satisfied: (rows) => rows.length >= satisfiedAt,
      ...extra,
    });

  test("ONE bounded read when the window already holds enough", async () => {
    // The high-activity account #9386 measured declining ~50% of the time: it
    // answers from the first window and never issues the full scan.
    const e = engine(rowsAt(HEAD - 1, HEAD - 2, HEAD - 3));
    const rows = await aggregate(e, 2);
    assert.equal(e.seen.length, 1);
    assert.match(e.seen[0]!, /block_number >= \d+/);
    assert.equal(rows!.length, 3);
  });

  test("A QUIET ACCOUNT COSTS EXACTLY ONE EXTRA QUERY, never a walk", async () => {
    // Proving an account has fewer than N events means reading its whole
    // history -- the widest window is `>= 0`, which prunes nothing. Widening
    // repeatedly would charge extra queries for the same full scan, so this is
    // deliberately two-phase.
    const e = engine(rowsAt(HEAD - 1));
    const rows = await aggregate(e, 5);
    assert.equal(e.seen.length, 2, e.seen.join("\n"));
    assert.match(e.seen[0]!, /block_number >= \d+/);
    assert.doesNotMatch(
      e.seen[1]!,
      /block_number/,
      "the fallback is unbounded",
    );
    assert.equal(rows!.length, 1);
  });

  test("no ceiling on the bounded attempt, so the range stays a suffix", async () => {
    // "The newest N within the range" is only "the newest N overall" while the
    // range runs to the top of the table.
    const e = engine(rowsAt(HEAD + 900));
    await aggregate(e, 1);
    assert.doesNotMatch(e.seen[0]!, /block_number <= /);
  });

  test("a head inside the first window skips straight to the unbounded read", async () => {
    // The bound would BE the whole table, so issuing it is one wasted query
    // before the identical unbounded one.
    const e = engine(rowsAt(100));
    await aggregate(e, 99, {
      headBlock: (async () => ACCOUNT_EVENTS_BLOCK_WINDOW - 1) as never,
    });
    assert.equal(e.seen.length, 1);
    assert.doesNotMatch(e.seen[0]!, /block_number >=/);
  });

  test("a failed bounded attempt declines instead of falling through", async () => {
    // Falling through would turn an engine failure into a full-table scan --
    // the most expensive possible response to the engine being unwell.
    const e = engine(rowsAt(HEAD - 1), { fail: 0 });
    assert.equal(await aggregate(e, 1), null);
    assert.equal(e.seen.length, 1);
  });

  test("an unreadable head goes straight to the unbounded read", async () => {
    const e = engine(rowsAt(HEAD - 1));
    const rows = await aggregate(e, 1, {
      headBlock: (async () => null) as never,
    });
    assert.equal(e.seen.length, 1);
    assert.doesNotMatch(e.seen[0]!, /block_number >=/);
    assert.equal(rows!.length, 1);
  });
});

describe("the window constants", () => {
  test("growth reaches the whole chain inside the step cap", async () => {
    // The cap is only ever hit by a pathological head; for a real one the walk
    // must reach block 0 well before it, or a sparse account silently gets a
    // short page.
    let reach = 0;
    let window = ACCOUNT_EVENTS_BLOCK_WINDOW;
    for (let i = 0; i < MAX_WINDOW_STEPS; i++) {
      reach += window;
      window *= WINDOW_GROWTH;
    }
    assert.ok(
      reach > 20_000_000,
      `${reach} blocks of reach is short of the chain's height`,
    );
  });
});

describe("the default reader", () => {
  test("both helpers fall back to the real r2-sql reader when none is injected", () => {
    // `query` is optional on both, and only windowedRowRead's default had a
    // caller. An untested default is how a module grows a second, divergent
    // path to the same engine.
    const unconfigured = {} as never; // no R2_SQL_TOKEN: r2SqlQuery declines
    return Promise.all([
      windowedRowRead(unconfigured, {
        table: "chain.account_events",
        columns: "block_number",
        where: ["hotkey = 'x'"],
        order: " ORDER BY block_number DESC",
        need: 1,
        headBlock: head as never,
      }).then((rows) => assert.equal(rows, null)),
      windowedFloorRead(unconfigured, {
        headBlock: head as never,
        attempt: (bound, run) =>
          run(
            unconfigured,
            `SELECT x FROM chain.account_events WHERE a${bound}`,
          ),
        satisfied: () => true,
      }).then((rows) => assert.equal(rows, null)),
    ]);
  });
});
