// The Analytics Engine data-point layout for RPC proxy usage (#9228).
//
// This layout is an UNMIGRATABLE SCHEMA. AE rows have no column names -- a
// dataset is blob1..blob20 / double1..double20 / one index -- so the mapping
// from meaning to slot exists only in src/rpc-usage-capture.ts, and old data
// points keep whatever a slot meant when they were written. There is no
// ALTER. Swapping two blobs would not fail anything: it would silently make
// every historical row disagree with every new one, and the reader would
// average two different quantities together.
//
// So these tests assert the layout POSITIONALLY, by array index, not through
// a named accessor that would move with the mistake.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  recordRpcUsageEvent,
  RPC_USAGE_BLOBS,
  RPC_USAGE_DATASET,
  RPC_USAGE_DOUBLES,
  truncateIndex,
  usageDataPoint,
  usageIndex,
  type RpcUsageEvent,
} from "../src/rpc-usage-capture.ts";

function event(overrides: Partial<RpcUsageEvent> = {}): RpcUsageEvent {
  return {
    pool: "public",
    network: "finney",
    endpointId: "onfinality-finney-rpc",
    provider: "onfinality",
    ok: true,
    status: 200,
    attempts: 1,
    latencyMs: 83,
    cache: "bypass",
    ...overrides,
  };
}

describe("the AE slot layout", () => {
  test("blobs are written in the order the slot map declares", () => {
    const point = usageDataPoint(event());
    // blobN is 1-indexed; the array is 0-indexed. Deriving the expected
    // position from the declared slot name is what makes this test fail on a
    // swap rather than on a rename.
    const at = (slot: string) => point.blobs[Number(slot.slice(4)) - 1];
    assert.equal(at(RPC_USAGE_BLOBS.pool), "public");
    assert.equal(at(RPC_USAGE_BLOBS.network), "finney");
    assert.equal(at(RPC_USAGE_BLOBS.endpointId), "onfinality-finney-rpc");
    assert.equal(at(RPC_USAGE_BLOBS.provider), "onfinality");
    assert.equal(at(RPC_USAGE_BLOBS.cache), "bypass");
    assert.equal(point.blobs.length, 5);
  });

  test("doubles are written in the order the slot map declares", () => {
    const point = usageDataPoint(event({ attempts: 3, status: 502 }));
    const at = (slot: string) => point.doubles[Number(slot.slice(6)) - 1];
    assert.equal(at(RPC_USAGE_DOUBLES.ok), 1);
    assert.equal(at(RPC_USAGE_DOUBLES.attempts), 3);
    assert.equal(at(RPC_USAGE_DOUBLES.latencyMs), 83);
    assert.equal(at(RPC_USAGE_DOUBLES.status), 502);
    assert.equal(point.doubles.length, 4);
  });

  test("every declared slot is distinct — no slot is reused", () => {
    const slots = [
      ...Object.values(RPC_USAGE_BLOBS),
      ...Object.values(RPC_USAGE_DOUBLES),
    ];
    assert.equal(new Set(slots).size, slots.length);
  });

  test("stays inside AE's per-data-point limits", () => {
    const point = usageDataPoint(event());
    assert.ok(point.blobs.length <= 20, "AE allows at most 20 blobs");
    assert.ok(point.doubles.length <= 20, "AE allows at most 20 doubles");
    assert.equal(point.indexes.length, 1, "AE allows exactly one index");
    const blobBytes = new TextEncoder().encode(point.blobs.join("")).length;
    assert.ok(blobBytes <= 16_384, "all blobs together must be under 16 KB");
  });

  test("the dataset name is the retired table's name", () => {
    // Deliberate: same measurement, restored. A reader grepping the old name
    // should land on the new writer.
    assert.equal(RPC_USAGE_DATASET, "rpc_proxy_events");
  });
});

describe("the event -> data point mapping", () => {
  test("ok is 1/0 so a weighted sum is the ok count", () => {
    assert.equal(usageDataPoint(event({ ok: true })).doubles[0], 1);
    assert.equal(usageDataPoint(event({ ok: false })).doubles[0], 0);
  });

  test("a missing endpoint records the empty sentinel, never undefined", () => {
    // undefined in a blobs array would be a type error at the binding, and
    // the GROUP BY needs a value to bucket.
    const point = usageDataPoint(
      event({ endpointId: null, provider: null, ok: false }),
    );
    assert.equal(point.blobs[2], "");
    assert.equal(point.blobs[3], "");
  });

  test("a non-finite reading becomes zero rather than poisoning the window", () => {
    // A NaN double would make every avg and every quantile over the window
    // NaN, and unlike a row in a table there is no way to delete it after.
    const point = usageDataPoint(
      event({
        latencyMs: Number.NaN,
        attempts: undefined as unknown as number,
        status: undefined as unknown as number,
      }),
    );
    assert.deepEqual(point.doubles, [1, 0, 0, 0]);
    for (const value of point.doubles) assert.ok(Number.isFinite(value));
  });

  test("a negative latency floors at zero", () => {
    assert.equal(usageDataPoint(event({ latencyMs: -5 })).doubles[2], 0);
  });

  test("a non-string network still yields a string blob", () => {
    const point = usageDataPoint(
      event({ network: undefined as unknown as string }),
    );
    assert.equal(point.blobs[1], "");
  });
});

describe("the sampling index", () => {
  test("carries pool, network and endpoint", () => {
    assert.equal(
      usageIndex(event()),
      "public/finney/onfinality-finney-rpc",
      "AE samples per index value, so the index has to be the full grouping " +
        "key or a low-volume endpoint is the first thing sampled away",
    );
  });

  test("a request with no endpoint still gets a stable index", () => {
    assert.equal(usageIndex(event({ endpointId: null })), "public/finney/none");
    assert.equal(usageIndex(event({ endpointId: "" })), "public/finney/none");
  });

  test("the fullnode gate indexes separately from the public pool", () => {
    // The two pools are isolated by ADR 0021; sharing an index value would
    // let one pool's volume sample the other's away.
    assert.equal(
      usageIndex(event({ pool: "fullnode", network: "fullnode" })),
      "fullnode/fullnode/onfinality-finney-rpc",
    );
  });

  test("truncates to AE's 96-BYTE ceiling, not 96 characters", () => {
    // An over-long index makes AE reject the whole data point, which reads
    // from the query side as "the proxy stopped receiving traffic" -- the
    // exact indistinguishable-from-healthy failure this issue is about.
    const long = "a".repeat(200);
    assert.equal(truncateIndex(long).length, 96);
    assert.ok(
      new TextEncoder().encode(usageIndex(event({ endpointId: long })))
        .length <= 96,
    );
  });

  test("never truncates mid-codepoint", () => {
    // A byte slice through a multi-byte sequence decodes to U+FFFD, which
    // would give two inputs that should share an index two different ones.
    const truncated = truncateIndex("é".repeat(80)); // 160 bytes
    assert.ok(new TextEncoder().encode(truncated).length <= 96);
    assert.ok(!truncated.includes("�"));
    assert.equal(truncated, "é".repeat(48));
  });

  test("leaves a value already inside the ceiling untouched", () => {
    assert.equal(truncateIndex("public/finney/fx"), "public/finney/fx");
  });
});

describe("recordRpcUsageEvent", () => {
  test("writes one data point and reports that it did", () => {
    const written: unknown[] = [];
    const ok = recordRpcUsageEvent(
      { writeDataPoint: (point: unknown) => written.push(point) },
      event(),
    );
    assert.equal(ok, true);
    assert.equal(written.length, 1);
    assert.deepEqual(written[0], usageDataPoint(event()));
  });

  test("no binding is a no-op, not a crash", () => {
    // Local dev, CI, and any self-hoster without the dataset. The proxy
    // degrades to "no analytics", never to "broken".
    assert.equal(recordRpcUsageEvent(undefined, event()), false);
    assert.equal(recordRpcUsageEvent(null, event()), false);
    assert.equal(
      recordRpcUsageEvent(
        {} as unknown as { writeDataPoint: () => void },
        event(),
      ),
      false,
    );
  });

  test("a throwing binding never reaches the caller", () => {
    // The one way a synchronous writeDataPoint could land in the request
    // path.
    const result = recordRpcUsageEvent(
      {
        writeDataPoint() {
          throw new Error("dataset unavailable");
        },
      },
      event(),
    );
    assert.equal(result, false);
  });
});
