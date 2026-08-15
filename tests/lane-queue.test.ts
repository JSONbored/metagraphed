// src/lane-queue.ts -- the ack/retry/drop decision, shared by every lane that
// moved from a cron to a queue (#10715).
//
// It had no direct test file: the three lanes each exercised it incidentally
// through their own handlers, which covers the happy path and leaves the
// decision itself -- the part with consequences -- asserted nowhere.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { consumeBatch } from "../src/lane-queue.ts";

// ---- the retry now says WHY (#10777) ----
//
// The catch was a bare `catch { message.retry(); }`. A message that failed its
// whole budget and dead-lettered produced no log line, no $exception, nothing,
// and the dead-letter verdict on the other end could only say how many were
// lost. Measured 2026-08-11: `revenue-probe` had gone 187 minutes with no
// verdict against a ~60 minute cadence, messages enqueuing on schedule and
// quietly dead-lettering, and error tracking held not one event for the lane.
describe("a retry reports its reason", () => {
  const msg = (body: unknown) => {
    const calls: string[] = [];
    return {
      calls,
      message: {
        body,
        ack: () => void calls.push("ack"),
        retry: () => void calls.push("retry"),
      },
    };
  };

  test("a THROWN failure reaches onRetry with its message", async () => {
    const seen: [string, number][] = [];
    const a = msg({ id: 1 });
    const result = await consumeBatch([a.message], {
      parse: (b) => b as { id: number },
      run: async () => {
        throw new Error("r2 sql: HTTP 500");
      },
      onRetry: (reason, count) => void seen.push([reason, count]),
    });
    assert.deepEqual(a.calls, ["retry"]);
    assert.equal(result.retried, 1);
    assert.deepEqual(seen, [["r2 sql: HTTP 500", 1]]);
    // RETURNED as well as reported. `onRetry` fires inside this call, and every
    // probe-job handler left it unset -- so the reason went to console.error
    // and the caller got a result carrying nothing about it. See
    // ConsumeResult.firstFailure.
    assert.equal(result.firstFailure, "r2 sql: HTTP 500");
  });

  test("a handler returning FALSE is reported too", async () => {
    // The quieter of the two failures -- no stack, no message. Leaving it
    // unreported would keep exactly half of the fix.
    const seen: string[] = [];
    const a = msg({ id: 1 });
    await consumeBatch([a.message], {
      parse: (b) => b as { id: number },
      run: async () => false,
      onRetry: (reason) => void seen.push(reason),
    });
    assert.deepEqual(seen, ["run() declined without throwing"]);
  });

  test("a non-Error throw still yields a readable reason", async () => {
    const seen: string[] = [];
    const a = msg({ id: 1 });
    await consumeBatch([a.message], {
      parse: (b) => b as { id: number },
      run: async () => {
        throw "socket closed";
      },
      onRetry: (reason) => void seen.push(reason),
    });
    assert.deepEqual(seen, ["socket closed"]);
  });

  test("ONE report per batch, carrying the full retry count", async () => {
    // A lane whose dependency is down fails every message identically; per
    // message reporting would turn one outage into a hundred records.
    const messages = Array.from({ length: 40 }, (_, i) => msg({ id: i }));
    const seen: [string, number][] = [];
    const result = await consumeBatch(
      messages.map((m) => m.message),
      {
        parse: (b) => b as { id: number },
        run: async () => {
          throw new Error("upstream down");
        },
        onRetry: (reason, count) => void seen.push([reason, count]),
      },
    );
    assert.equal(result.retried, 40);
    assert.equal(seen.length, 1, "one report, not forty");
    assert.deepEqual(seen[0], ["upstream down", 40]);
  });

  test("the FIRST failure is the one reported", async () => {
    const messages = [msg({ id: 1 }), msg({ id: 2 })];
    const seen: string[] = [];
    let n = 0;
    await consumeBatch(
      messages.map((m) => m.message),
      {
        parse: (b) => b as { id: number },
        run: async () => {
          n += 1;
          throw new Error(n === 1 ? "first" : "second");
        },
        onRetry: (reason) => void seen.push(reason),
      },
    );
    assert.deepEqual(seen, ["first"]);
  });

  test("a clean batch reports nothing", async () => {
    const seen: string[] = [];
    const a = msg({ id: 1 });
    const result = await consumeBatch([a.message], {
      parse: (b) => b as { id: number },
      run: async () => true,
      onRetry: (reason) => void seen.push(reason),
    });
    assert.equal(result.done, 1);
    assert.deepEqual(seen, [], "success is not something to report");
    // Null, not "". "Nothing was retried" and "retried for a reason nobody
    // recorded" are different answers, and a reporter has to tell them apart.
    assert.equal(result.firstFailure, null);
  });

  test("a batch that only DROPS reports nothing", async () => {
    // A vanished subject is acked, not retried -- it is the loop working as
    // designed, and reporting it would train a reader to ignore the channel.
    const seen: string[] = [];
    const a = msg({ id: 1 });
    const result = await consumeBatch([a.message], {
      parse: () => null,
      run: async () => true,
      onRetry: (reason) => void seen.push(reason),
    });
    assert.equal(result.dropped, 1);
    assert.deepEqual(seen, []);
    assert.equal(result.firstFailure, null);
  });

  test("with no onRetry the loop still says so, on console.error", async () => {
    // Opting out has to be deliberate: the default is not silence.
    const lines: string[] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const a = msg({ id: 1 });
      await consumeBatch([a.message], {
        parse: (b) => b as { id: number },
        run: async () => {
          throw new Error("boom");
        },
      });
    } finally {
      console.error = real;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /1 message\(s\) retried -- boom/);
  });

  test("a THROWING reporter cannot make the batch worse", async () => {
    // Every message is already acked or retried by the time the report runs.
    const a = msg({ id: 1 });
    const result = await consumeBatch([a.message], {
      parse: (b) => b as { id: number },
      run: async () => {
        throw new Error("boom");
      },
      onRetry: () => {
        throw new Error("posthog unreachable");
      },
    });
    assert.equal(result.retried, 1);
    assert.deepEqual(a.calls, ["retry"]);
  });
});
