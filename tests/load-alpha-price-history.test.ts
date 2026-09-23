import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  ALPHA_PRICE_HISTORY_LOOKBACK_DAYS,
  alphaPriceHistoryQuery,
  loadAlphaPriceHistoryByNetuid,
} from "../scripts/lib/load-alpha-price-history.ts";
const CREDS = {
  STATE_EXPORT_URL: "https://example.com/state-export",
  STATE_EXPORT_SECRET: "test-export-secret",
};
const now = () => Date.parse("2026-08-08T00:00:00Z");
const revision = (value = 7) => ({ version: 1, revision: value });
const page = (
  rows: unknown[] = [],
  next_cursor: unknown = null,
  value = 7,
) => ({ ...revision(value), rows, next_cursor });
function transport(replies: unknown[]) {
  const calls: Array<{
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
  }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.ok(init);
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    if (r instanceof Response) return r;
    if (r === undefined) throw Error("unexpected request");
    return Response.json(r);
  };
  return { calls, fetchImpl };
}
describe("alphaPriceHistoryQuery", () => {
  // THE INCIDENT THIS PINS. This query has TWO engines behind it -- the D1 HTTP
  // door at build time, and Postgres through readStore in
  // src/live-economics-refresh.ts. It used to carry `date('now','-40 days')`,
  // which is SQLite's spelling and `function date(unknown, unknown) does not
  // exist` on Postgres. The read sits inside refreshLiveEconomics's own try, so
  // the throw took the WHOLE tick: KV `economics:current` stopped advancing
  // while the last good blob kept being served.
  //
  // So what is asserted is the ABSENCE of a dialect, not the presence of one.
  test("carries no date function at all, in either dialect", () => {
    const sql = alphaPriceHistoryQuery();
    assert.ok(!/date\s*\(/i.test(sql), `a date function survived: ${sql}`);
    assert.ok(!sql.includes("INTERVAL"));
    assert.ok(!sql.includes("CURRENT_DATE"));
    assert.match(sql, /ORDER BY netuid ASC, snapshot_date ASC/);
  });

  test("compares against a plain YYYY-MM-DD literal, which both engines parse", () => {
    const sql = alphaPriceHistoryQuery(ALPHA_PRICE_HISTORY_LOOKBACK_DAYS, () =>
      Date.parse("2026-08-08T00:00:00Z"),
    );
    // 40 days before 2026-08-08.
    assert.match(sql, /WHERE snapshot_date >= '2026-06-29'/);
  });

  test("truncates a fractional lookback rather than emitting a broken literal", () => {
    const sql = alphaPriceHistoryQuery(7.9, () =>
      Date.parse("2026-08-08T00:00:00Z"),
    );
    // 7 days, not 7.9 -- a fractional day would land mid-day and shift the
    // boundary by the time of day the build happened to run.
    assert.match(sql, /WHERE snapshot_date >= '2026-08-01'/);
  });
});

describe("loadAlphaPriceHistoryByNetuid", () => {
  test("reads every revision-bound page with its actual capture stamp", async () => {
    const { calls, fetchImpl } = transport([
      revision(),
      page([[1, "2026-08-01", 0.5, 1785542400000]], ["2026-08-01", 1]),
      page([
        [1, "2026-08-02", 0.6, 1785628800000],
        [2, "2026-08-02", 0.1, null],
      ]),
      revision(),
    ]);
    const result = await loadAlphaPriceHistoryByNetuid(CREDS, fetchImpl, now);
    assert.ok(result);
    assert.equal(result.size, 2);
    assert.deepEqual(result.get(1), [
      {
        snapshot_date: "2026-08-01",
        alpha_price_tao: 0.5,
        captured_at: 1785542400000,
      },
      {
        snapshot_date: "2026-08-02",
        alpha_price_tao: 0.6,
        captured_at: 1785628800000,
      },
    ]);
    assert.deepEqual(calls[1].body.cursor, ["2026-06-29", -1]);
    assert.deepEqual(calls[2].body.cursor, ["2026-08-01", 1]);
    assert.equal(calls[2].body.revision, 7);
    assert.equal(calls[3].body.revision, 7);
    for (const c of calls) {
      assert.equal(c.url, CREDS.STATE_EXPORT_URL);
      assert.equal(c.init.redirect, "error");
      assert.equal(
        new Headers(c.init.headers).get("x-state-export-token"),
        CREDS.STATE_EXPORT_SECRET,
      );
      assert.equal(new Headers(c.init.headers).get("accept-encoding"), "gzip");
      assert.ok(c.init.signal instanceof AbortSignal);
      assert.equal(c.body.table, "subnet_snapshots");
    }
  });
  test("empty history and nullable prices are valid complete snapshots", async () => {
    for (const rows of [[], [[0, "2026-08-01", null, null]]]) {
      const { fetchImpl } = transport([revision(), page(rows), revision()]);
      const result = await loadAlphaPriceHistoryByNetuid(CREDS, fetchImpl, now);
      assert.ok(result);
      assert.equal(result.size, rows.length);
    }
  });
  test("missing credentials never make a request", async () => {
    for (const env of [
      {},
      { STATE_EXPORT_URL: CREDS.STATE_EXPORT_URL },
      { STATE_EXPORT_SECRET: CREDS.STATE_EXPORT_SECRET },
    ]) {
      const { calls, fetchImpl } = transport([]);
      assert.equal(await loadAlphaPriceHistoryByNetuid(env, fetchImpl), null);
      assert.equal(calls.length, 0);
    }
  });
  test.each([
    "http://example.com/export",
    "https://user@example.com/export",
    "https://user:secret@example.com/export",
    "https://example.com/export?q=1",
    "https://example.com/export#fragment",
    "not-a-url",
  ])("rejects credential-unsafe URL %s", async (url) => {
    const { calls, fetchImpl } = transport([]);
    assert.equal(
      await loadAlphaPriceHistoryByNetuid(
        { ...CREDS, STATE_EXPORT_URL: url },
        fetchImpl,
        now,
      ),
      null,
    );
    assert.equal(calls.length, 0);
  });
  test("partial or invalid responses never become an empty successful history", async () => {
    for (const reply of [
      new Error("private transport detail"),
      new Response(null, { status: 500 }),
      new Response(null, { status: 200 }),
      new Response("invalid-json"),
      {},
      page(null as unknown as unknown[]),
      page([[1, "bad-day", 1, 1]]),
      page([[1, "2026-08-01", "rounded", 1]]),
      page([[1, "2026-08-01", 1, Number.MAX_SAFE_INTEGER + 1]]),
    ]) {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { fetchImpl } = transport([revision(), reply]);
      assert.equal(
        await loadAlphaPriceHistoryByNetuid(CREDS, fetchImpl, now),
        null,
      );
      assert.ok(
        warning.mock.calls.every(
          (c) => !String(c[0]).includes("private transport detail"),
        ),
      );
      warning.mockRestore();
    }
  });
  test("rejects repeated, reversed and mismatched cursor keys", async () => {
    const cases = [
      page([], ["2026-08-01", 1]),
      page([[1, "2026-08-01", 1, 1]], ["2026-08-01", 2]),
      page([[1, "2026-06-28", 1, 1]]),
      page([
        [1, "2026-08-01", 1, 1],
        [1, "2026-08-01", 2, 2],
      ]),
      page([
        [1, "2026-08-02", 1, 1],
        [2, "2026-08-01", 1, 1],
      ]),
    ];
    for (const reply of cases) {
      const { fetchImpl } = transport([revision(), reply]);
      assert.equal(
        await loadAlphaPriceHistoryByNetuid(CREDS, fetchImpl, now),
        null,
      );
    }
  });
  test("retries changed snapshots from the beginning and discards their rows", async () => {
    for (const changed of [
      new Response(null, { status: 409 }),
      page([[1, "2026-08-01", 99, 1]], null, 8),
    ]) {
      const { fetchImpl } = transport([
        revision(),
        changed,
        revision(8),
        page([[2, "2026-08-02", 0.4, 2]], null, 8),
        revision(8),
      ]);
      const result = await loadAlphaPriceHistoryByNetuid(CREDS, fetchImpl, now);
      assert.ok(result);
      assert.equal(result.has(1), false);
      assert.equal(result.get(2)?.[0].alpha_price_tao, 0.4);
    }
    const { fetchImpl } = transport([
      revision(),
      page([[1, "2026-08-01", 1, 1]]),
      revision(8),
      revision(8),
      page([], null, 8),
      revision(8),
    ]);
    assert.equal(
      (await loadAlphaPriceHistoryByNetuid(CREDS, fetchImpl, now))?.size,
      0,
    );
  });
  test("stops after three revision conflicts", async () => {
    const { calls, fetchImpl } = transport([
      revision(),
      new Response(null, { status: 409 }),
      revision(),
      new Response(null, { status: 409 }),
      revision(),
      new Response(null, { status: 409 }),
    ]);
    assert.equal(
      await loadAlphaPriceHistoryByNetuid(CREDS, fetchImpl, now),
      null,
    );
    assert.equal(calls.length, 6);
  });
  test("caps inflated response bytes and cancels the stream", async () => {
    let cancelled = false;
    const huge = new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(512 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const { fetchImpl } = transport([revision(), huge]);
    assert.equal(
      await loadAlphaPriceHistoryByNetuid(CREDS, fetchImpl, now),
      null,
    );
    assert.equal(cancelled, true);
  });
  test("bounds total rows and number of pages", async () => {
    for (const size of [1, 2000]) {
      const replies: unknown[] = [revision()];
      for (let p = 0; p < 11; p++) {
        const day = `2026-07-${String(p + 1).padStart(2, "0")}`;
        replies.push(
          page(
            Array.from({ length: size }, (_, i) => [i, day, 0.1, 1]),
            [day, size - 1],
          ),
        );
      }
      const { calls, fetchImpl } = transport(replies);
      assert.equal(
        await loadAlphaPriceHistoryByNetuid(CREDS, fetchImpl, now),
        null,
      );
      assert.equal(calls.length, 12);
    }
  });
});
