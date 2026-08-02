// src/r2-sql.ts is a SERVING path over the chain lakehouse, so these tests
// care about two things above all: that no failure mode can turn a slow
// archive query into a broken page, and that nothing user-controlled can be
// interpolated into a query (R2 SQL has no bound parameters, so the safe-
// literal guards are the whole defence).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  currentR2SqlFailureGeneration,
  isR2SqlConfigured,
  r2SqlQuery,
  R2_SQL_TOKEN_ENV,
  safeBlockNumber,
  safeHexLiteral,
} from "../src/r2-sql.ts";
import { mockEnv } from "./row-type.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };

function jsonFetch(body: unknown, ok = true, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("isR2SqlConfigured", () => {
  test("requires a non-empty token", () => {
    assert.equal(isR2SqlConfigured(mockEnv(TOKEN)), true);
    assert.equal(isR2SqlConfigured(mockEnv()), false);
    assert.equal(
      isR2SqlConfigured(mockEnv({ [R2_SQL_TOKEN_ENV]: "  " })),
      false,
    );
    assert.equal(isR2SqlConfigured(null), false);
  });
});

describe("safe literals — the only defence against injection here", () => {
  test("block numbers: real non-negative integers only", () => {
    assert.equal(safeBlockNumber(8755000), 8755000);
    assert.equal(safeBlockNumber("8755000"), 8755000);
    for (const bad of [
      -1,
      1.5,
      NaN,
      Infinity,
      "abc",
      null,
      undefined,
      true,
      false,
      "",
      "  ",
      "-5",
      "1.5",
      "1; DROP TABLE",
      // All digits, but beyond Number.MAX_SAFE_INTEGER -- would lose precision
      // and address the wrong block.
      "99999999999999999999",
    ]) {
      assert.equal(safeBlockNumber(bad), null, `rejected: ${String(bad)}`);
    }
  });

  test("hex literals: 0x-prefixed hex only, lowercased", () => {
    assert.equal(safeHexLiteral("0xABCdef"), "0xabcdef");
    for (const bad of [
      "abcdef",
      "0x",
      "0xzz",
      "0x123'--",
      "'; DROP TABLE chain.blocks; --",
      42,
      null,
    ]) {
      assert.equal(safeHexLiteral(bad), null, `rejected: ${String(bad)}`);
    }
  });
});

describe("r2SqlQuery", () => {
  test("unconfigured returns null WITHOUT calling out or counting a failure", async () => {
    const { impl, calls } = jsonFetch({});
    const before = currentR2SqlFailureGeneration();
    const rows = await r2SqlQuery(mockEnv(), "SELECT 1", { fetch: impl });
    assert.equal(rows, null);
    assert.equal(calls.length, 0);
    assert.equal(
      currentR2SqlFailureGeneration(),
      before,
      "no token is a deployment shape, not a fault",
    );
  });

  test("returns rows, and posts the query to the warehouse endpoint", async () => {
    const { impl, calls } = jsonFetch({
      success: true,
      result: { rows: [{ block_number: 8755095 }] },
    });
    const rows = await r2SqlQuery(
      mockEnv(TOKEN),
      "SELECT block_number FROM chain.blocks LIMIT 1",
      { fetch: impl },
    );
    assert.deepEqual(rows, [{ block_number: 8755095 }]);
    assert.match(calls[0]!.url, /r2-sql\/query\/metagraphed-lakehouse$/);
    assert.equal(
      (calls[0]!.init.headers as Record<string, string>).authorization,
      "Bearer cfut_test",
    );
    const sent = JSON.parse(String(calls[0]!.init.body));
    assert.equal(sent.warehouse, "metagraphed-lakehouse");
    assert.match(sent.query, /FROM chain\.blocks/);
  });

  test("an empty result is [] — 'no such block' is an ANSWER, not a failure", async () => {
    const { impl } = jsonFetch({ success: true, result: { rows: [] } });
    const before = currentR2SqlFailureGeneration();
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", { fetch: impl });
    assert.deepEqual(rows, []);
    assert.equal(currentR2SqlFailureGeneration(), before);
  });

  test("a missing rows field still yields [] rather than null", async () => {
    const { impl } = jsonFetch({ success: true, result: {} });
    assert.deepEqual(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", { fetch: impl }),
      [],
    );
  });

  test("HTTP error degrades to null and bumps the generation", async () => {
    const { impl } = jsonFetch({}, false, 503);
    const before = currentR2SqlFailureGeneration();
    const captured: { route?: string }[] = [];
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
      fetch: impl,
      recordException: (async (_e: unknown, ev: { route?: string }) => {
        captured.push(ev);
        return true;
      }) as never,
    });
    assert.equal(rows, null);
    assert.equal(currentR2SqlFailureGeneration(), before + 1);
    assert.equal(captured[0]?.route, "r2-sql");
  });

  test("a success:false body degrades to null with the engine's message", async () => {
    const { impl } = jsonFetch({
      success: false,
      errors: [{ code: 40006, message: "warehouse does not exist" }],
    });
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
      fetch: impl,
      recordException: (async () => true) as never,
    });
    assert.equal(rows, null);
  });

  test("a success:false body with no error detail still degrades cleanly", async () => {
    const { impl } = jsonFetch({ success: false });
    assert.equal(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: impl,
        recordException: (async () => true) as never,
      }),
      null,
    );
  });

  test("a thrown transport error is contained", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    assert.equal(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: impl,
        recordException: (async () => true) as never,
      }),
      null,
    );
  });

  test("account and warehouse overrides are honoured", async () => {
    const { impl, calls } = jsonFetch({ success: true, result: { rows: [] } });
    await r2SqlQuery(
      mockEnv({
        ...TOKEN,
        R2_SQL_ACCOUNT_ID: "acct123",
        R2_SQL_WAREHOUSE: "other-house",
      }),
      "SELECT 1",
      { fetch: impl },
    );
    assert.match(
      calls[0]!.url,
      /accounts\/acct123\/r2-sql\/query\/other-house$/,
    );
  });

  test("a stuck query is aborted by the timeout, not left pinning the request", async () => {
    // A fetch that never settles on its own: only the abort can end it.
    const impl = (async (_u: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as unknown as typeof fetch;
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
      fetch: impl,
      timeoutMs: 5,
      recordException: (async () => true) as never,
    });
    assert.equal(
      rows,
      null,
      "an aborted query degrades like any other failure",
    );
  });

  test("a non-Error rejection still degrades cleanly", async () => {
    const impl = (async () => {
      throw "plain string";
    }) as unknown as typeof fetch;
    assert.equal(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: impl,
        recordException: (async () => true) as never,
      }),
      null,
    );
  });

  test("a success:false body with an error lacking a code omits the suffix", async () => {
    const { impl } = jsonFetch({
      success: false,
      errors: [{ message: "nope" }],
    });
    assert.equal(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: impl,
        recordException: (async () => true) as never,
      }),
      null,
    );
  });

  test("uses the real exception recorder when none is injected", async () => {
    const impl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    // No POSTHOG_PROJECT_TOKEN here, so the real recorder is a safe no-op --
    // this exercises the default rather than the injected seam.
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", { fetch: impl });
    assert.equal(rows, null);
  });

  test("falls back to the real global fetch when none is injected", async () => {
    const realFetch = globalThis.fetch;
    let hit = false;
    globalThis.fetch = (async () => {
      hit = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows: [{ n: 1 }] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1");
      assert.equal(hit, true);
      assert.deepEqual(rows, [{ n: 1 }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
