import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  ChainBlockUnavailableError,
  chainBlockHash,
  chainBlockUnavailable,
  chainHeaderNumber,
  chainStorageChanges,
  chainStorageKeys,
} from "../src/chain-rpc-read.ts";
import { withEmissionFailover } from "../src/emission-rpc.ts";
import { createSubtensorPinnedStorage } from "../src/subtensor-pinned-storage.ts";

const HASH = "0x" + "ab".repeat(32);

describe("method-level chain reads", () => {
  test("accepts exact hashes and safe hexadecimal heights", () => {
    assert.equal(chainBlockHash(HASH, "chain_getFinalizedHead"), HASH);
    assert.equal(chainHeaderNumber({ number: "0x0" }), 0);
    assert.equal(
      chainHeaderNumber({ number: "0x1fffffffffffff" }),
      Number.MAX_SAFE_INTEGER,
    );
  });

  test.each([null, undefined, 9, [], "0x123", "0x" + "gg".repeat(32)])(
    "rejects an unusable block hash (%s)",
    (value) => {
      assert.throws(
        () => chainBlockHash(value, "chain_getFinalizedHead"),
        /chain_getFinalizedHead: response was not a block hash/,
      );
    },
  );

  test("a null header is an unavailable pinned block, not a TypeError", () => {
    assert.throws(() => chainHeaderNumber(null), ChainBlockUnavailableError);
  });

  test.each([
    undefined,
    [],
    7,
    "header",
    {},
    { number: null },
    { number: 9 },
    { number: "0x" },
    { number: "0x9tail" },
    { number: "9" },
    { number: "-0x1" },
    { number: "0x20000000000000" },
  ])("rejects malformed or imprecise headers (%s)", (value) => {
    assert.throws(() => chainHeaderNumber(value), /chain_getHeader:/);
  });

  test("preserves complete changes, null values, ordering, and valid unset pages", () => {
    const changes: [string, string | null][] = [
      ["key", "0x00"],
      ["key", null],
    ];
    assert.deepEqual(
      chainStorageChanges([{ block: HASH, changes }, { changes: [] }], HASH),
      changes,
    );
    assert.deepEqual(chainStorageChanges([{ changes: [] }], HASH), []);
    assert.deepEqual(chainStorageKeys([]), []);
    assert.deepEqual(chainStorageKeys(["a", "b"]), ["a", "b"]);
  });

  test.each([null, []])(
    "absent changesets cannot become unset storage (%s)",
    (value) => {
      assert.throws(
        () => chainStorageChanges(value, HASH),
        ChainBlockUnavailableError,
      );
    },
  );

  test.each([
    undefined,
    {},
    "pages",
    [null],
    [4],
    [{}],
    [{ changes: null }],
    [{ changes: [], block: "wrong" }],
    [{ changes: [null] }],
    [{ changes: [["key"]] }],
    [{ changes: [[5, null]] }],
    [{ changes: [["key", undefined]] }],
    [{ changes: [["key", 7]] }],
  ])("rejects malformed or differently pinned changes (%s)", (value) => {
    assert.throws(
      () => chainStorageChanges(value, HASH),
      /state_queryStorageAt:/,
    );
  });

  test.each([null, undefined, {}, "keys", [null], [1]])(
    "rejects malformed key pages (%s)",
    (value) => {
      assert.throws(() => chainStorageKeys(value), /state_getKeysPaged:/);
    },
  );

  test("only explicit block unavailability is retryable", () => {
    assert.equal(
      chainBlockUnavailable(new ChainBlockUnavailableError("missing")),
      true,
    );
    for (const method of [
      "chain_getHeader",
      "state_queryStorageAt",
      "state_getStorage",
      "state_getKeysPaged",
    ]) {
      assert.equal(
        chainBlockUnavailable(
          new Error(
            `${method}: UnknownBlock: Header was not found in the database`,
          ),
        ),
        true,
      );
    }
    for (const error of [
      null,
      undefined,
      "UnknownBlock",
      new Error("state_getStorage: HTTP 429"),
      new Error("unrelated: UnknownBlock"),
      new Error("chain_getHeader: malformed"),
      new TypeError("Cannot read properties of null (reading 'number')"),
    ]) {
      assert.equal(chainBlockUnavailable(error), false);
    }
  });

  test("the shared pinned reader rejects the recorded null-header failure before state reads", async () => {
    const methods: string[] = [];
    const storage = createSubtensorPinnedStorage({
      rpcUrl: "https://rpc.test",
      fetchImpl: (async (_url, init) => {
        const { method } = JSON.parse(String(init?.body));
        methods.push(method);
        return new Response(
          JSON.stringify({
            result: method === "chain_getBlockHash" ? HASH : null,
          }),
        );
      }) as typeof fetch,
    });
    await assert.rejects(() => storage.pinHead(), ChainBlockUnavailableError);
    assert.deepEqual(methods, ["chain_getBlockHash", "chain_getHeader"]);
  });
});

describe("bounded complete-sample consistency recovery", () => {
  test("the second unavailable endpoint may recover when the first remains unavailable", async () => {
    const calls: string[] = [];
    const result = await withEmissionFailover(
      { urls: ["a", "b"], waitForRetry: async () => {} },
      async (url) => {
        calls.push(url);
        if (calls.length < 4) throw new ChainBlockUnavailableError("missing");
        return "second complete";
      },
      "sample",
    );
    assert.equal(result, "second complete");
    assert.deepEqual(calls, ["a", "b", "a", "b"]);
  });

  test("tries the whole pool, waits once, and restarts only unavailable endpoints", async () => {
    const calls: string[] = [];
    let waited = 0;
    const result = await withEmissionFailover(
      {
        urls: ["a", "b"],
        waitForRetry: async () => {
          waited++;
        },
      },
      async (url) => {
        calls.push(url);
        if (calls.length === 1) throw new ChainBlockUnavailableError("missing");
        if (url === "b") throw new Error("HTTP 429");
        return "complete";
      },
      "sample",
    );
    assert.equal(result, "complete");
    assert.deepEqual(calls, ["a", "b", "a"]);
    assert.equal(waited, 1);
  });

  test("persistent UnknownBlock is bounded to two attempts per unavailable endpoint", async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        withEmissionFailover(
          { urls: ["a", "b"], waitForRetry: async () => {} },
          async (url) => {
            calls.push(url);
            throw new Error(`state_getStorage: UnknownBlock: ${url}`);
          },
          "sample",
        ),
      /UnknownBlock: b/,
    );
    assert.deepEqual(calls, ["a", "b", "a", "b"]);
  });

  test("a schema error after an unavailable block remains fatal, without another retry", async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withEmissionFailover(
          { urls: ["a"], waitForRetry: async () => {} },
          async () => {
            if (++attempts === 1)
              throw new ChainBlockUnavailableError("missing");
            throw new Error("bad schema");
          },
          "sample",
        ),
      /bad schema/,
    );
    assert.equal(attempts, 2);
  });

  test("the production consistency delay is bounded and does not retry immediately", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const pending = withEmissionFailover(
        { urls: ["a"] },
        async () => {
          if (++attempts === 1) throw new ChainBlockUnavailableError("missing");
          return "complete";
        },
        "sample",
      );
      await vi.advanceTimersByTimeAsync(499);
      assert.equal(attempts, 1);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(await pending, "complete");
      assert.equal(attempts, 2);
    } finally {
      vi.useRealTimers();
    }
  });
});
