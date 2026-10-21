import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  gzip,
  maximumExpansionFixture,
  smallAndFramingFixtures,
  stored,
  valid,
  type Fixture,
} from "./helpers/strict-gzip-corpus.ts";
import {
  createStrictGzipNativeFixture,
  STRICT_GZIP_TESTED_SOURCE_SHA256,
} from "./helpers/strict-gzip-native.ts";
import {
  strictGzipPolicyDifferences,
  strictGzipPriorQualification,
} from "./fixtures/strict-gzip-policy-differences.ts";
import type { Observation, Snapshot } from "./fixtures/strict-gzip-observer.ts";

type NativeResult = {
  ok: boolean;
  cancelled: boolean;
  error?: string;
  bytes: number;
  reads: number;
  sha256: string;
  stalls: { afterReads: number; samples: Snapshot[] }[];
  cancellation?: { before: Snapshot; after: Snapshot; returned: boolean };
  pendingTest?: {
    settledBeforeCancel: boolean;
    concurrentError?: string;
    synchronouslyDestroyed: boolean;
    firstDone?: boolean;
    returnDone?: boolean;
    nextAfterCancelDone?: boolean;
    before: Snapshot;
    after: Snapshot;
  };
  refusal?: {
    overflowBytes: number;
    before: Snapshot;
    immediatelyAfterCancel: Snapshot;
    after: Snapshot;
    doneAfterCancel: boolean;
    afterDoneProbe: Snapshot;
    endEventsAtRefusal: number;
  };
  last: Snapshot;
  observation: Observation["state"];
  timing: {
    wallMilliseconds: number;
    intentionalStallMilliseconds: number;
    meaning: string;
  };
  reference?: {
    ok: boolean;
    bytes: number;
    sha256?: string;
    error?: string;
  };
};

// Synthetic resource fixture size; importing the application's limits or
// consumer would expand this deliberately isolated primitive test graph.
const MAX_DECODED = 79_393_024;
let fixture: Awaited<ReturnType<typeof createStrictGzipNativeFixture>>;

beforeAll(async () => {
  fixture = await createStrictGzipNativeFixture();
}, 60_000);

afterAll(async () => {
  await fixture?.dispose();
});

async function inspect(
  sample: Fixture,
  mode = "decode",
  budget = Number.MAX_SAFE_INTEGER,
  compare = Boolean(sample.compare),
) {
  fixture.assertNoNetwork();
  const response = await fixture.runtime.dispatchFetch(
    `https://strict-gzip.fixture.invalid/?mode=${mode}&budget=${budget}&compare=${compare ? 1 : 0}`,
    { method: "POST", body: sample.wire },
  );
  expect(response.status).toBe(200);
  const result = (await response.json()) as NativeResult;
  fixture.assertNoNetwork();
  const observed = result.observation;
  expect(observed.violations).toEqual([]);
  expect(observed.callbackThrows).toEqual([]);
  expect(observed.maxPending).toBeLessThanOrEqual(1);
  expect(observed.maxInput).toBeLessThanOrEqual(4096);
  expect(observed.maxOutput).toBeLessThanOrEqual(8192);
  expect(observed.maxPush).toBeLessThanOrEqual(8192);
  expect(observed.maxQueued).toBeLessThanOrEqual(16_384);
  for (const event of observed.events) {
    expect(event.consumed).toBeLessThanOrEqual(event.submitted);
    expect(event.drained).toBeLessThanOrEqual(event.produced);
    if (event.at === "call") {
      expect(event.queued).toBe(0);
      expect(event.phase).toBe("decode");
    }
  }
  return result;
}

function disposition(result: { ok: boolean; error?: string }) {
  return result.ok
    ? "accepted"
    : result.error?.includes("TEST_EXPANSION_LIMIT")
      ? "resource-refusal"
      : "malformed";
}

function expectRefusal(
  result: NativeResult,
  budget: number,
  totalDecoded: number,
  rawDeflateBytes: number,
) {
  expect(disposition(result)).toBe("resource-refusal");
  expect(result.bytes).toBeLessThanOrEqual(budget);
  expect(result.refusal!.overflowBytes).toBeGreaterThan(0);
  expect(result.refusal!.overflowBytes).toBeLessThanOrEqual(8192);
  const drained = result.bytes + result.refusal!.overflowBytes;
  expect(drained).toBeGreaterThan(budget);
  expect(drained).toBeLessThanOrEqual(budget + 8192);
  expect(result.refusal!.before.drained).toBe(drained);
  expect(result.last.produced).toBeLessThanOrEqual(drained + 16_384);
  expect(result.last.produced).toBeLessThan(totalDecoded);
  expect(result.last.consumed).toBeLessThan(rawDeflateBytes);
  expect(result.refusal!.endEventsAtRefusal).toBe(0);
  expect(result.observation.ends).toBe(0);
  expect(result.refusal!.doneAfterCancel).toBe(true);
  for (const snapshot of [
    result.refusal!.immediatelyAfterCancel,
    result.refusal!.after,
    result.refusal!.afterDoneProbe,
    result.last,
  ]) {
    for (const key of [
      "submitted",
      "consumed",
      "produced",
      "drained",
      "writes",
      "reads",
    ] as const)
      expect(snapshot[key]).toBe(result.refusal!.before[key]);
    expect(snapshot.destroyed).toBe(true);
  }
}

test("only the exact inactive primitive is bundled with fixture code", () => {
  expect(fixture.proof.source_sha256).toBe(STRICT_GZIP_TESTED_SOURCE_SHA256);
  expect(fixture.proof.source_sha256).toBe(
    strictGzipPriorQualification.currentSourceSha256,
  );
  expect(fixture.proof.inputs).toHaveLength(3);
  fixture.assertNoNetwork();
  console.info("strict-gzip-primitive-proof", JSON.stringify(fixture.proof));
});

for (const sample of smallAndFramingFixtures()) {
  test(`native framing: ${sample.name}`, async () => {
    const result = await inspect(
      sample,
      "decode",
      sample.expectedBytes ?? Number.MAX_SAFE_INTEGER,
    );
    expect(result.ok).toBe(sample.accepted);
    if (sample.accepted) {
      expect(result.bytes).toBe(sample.expectedBytes);
      expect(result.sha256).toBe(sample.expectedSha256);
      expect(result.observation.instances).toBe(1);
      expect(result.observation.callbacks).toBe(result.observation.writes);
      expect(result.last.produced).toBe(result.last.drained);
      if (sample.compare) {
        expect(result.reference!.ok).toBe(true);
        expect(result.reference!.bytes).toBe(result.bytes);
        expect(result.reference!.sha256).toBe(result.sha256);
      }
    } else {
      expect(typeof result.error).toBe("string");
      if (sample.compare) expect(result.reference!.ok).toBe(false);
    }
  });
}

test("valid exact maximum output stays bounded through late consumer stalls", async () => {
  const sample = maximumExpansionFixture(MAX_DECODED);
  const result = await inspect(sample, "stall", MAX_DECODED, false);
  expect(result.ok).toBe(true);
  expect(result.bytes).toBe(MAX_DECODED);
  expect(result.sha256).toBe(sample.expectedSha256);
  expect(result.stalls.map((stall) => stall.afterReads)).toEqual([
    1024, 4096, 8192,
  ]);
  for (const stall of result.stalls) {
    const first = stall.samples[0];
    expect(first.writes).toBeGreaterThan(1);
    expect(first.reads).toBeGreaterThanOrEqual(1024);
    expect(first.submitted).toBeLessThan(
      sample.wire.length - result.observation.headerBytes,
    );
    for (const snapshot of stall.samples) {
      expect(snapshot.submitted).toBe(first.submitted);
      expect(snapshot.drained).toBe(first.drained);
      expect(snapshot.writes).toBe(first.writes);
      expect(snapshot.queued).toBeLessThanOrEqual(16_384);
      expect(snapshot.produced - first.produced).toBeLessThanOrEqual(16_384);
    }
  }
}, 60_000);

for (const mode of ["cancel", "destroy-error", "destroy-close"]) {
  test(`native lifecycle: ${mode}`, async () => {
    const sample = maximumExpansionFixture(8 * 1024 * 1024);
    const result = await inspect(sample, mode, Number.MAX_SAFE_INTEGER, false);
    expect(result.ok).toBe(false);
    expect(result.last.destroyed).toBe(true);
    expect(result.observation.closes).toBeGreaterThanOrEqual(1);
    if (mode === "cancel") {
      expect(result.cancelled).toBe(true);
      expect(result.cancellation!.returned).toBe(true);
      expect(result.cancellation!.after.submitted).toBe(
        result.cancellation!.before.submitted,
      );
      expect(result.cancellation!.after.drained).toBe(
        result.cancellation!.before.drained,
      );
    } else {
      expect(result.error).toMatch(
        mode === "destroy-error"
          ? /Synthetic native lifecycle error/
          : /closed early/i,
      );
    }
  });
}

for (const mode of ["pending-return", "pending-cancel"]) {
  test(`pending native read: ${mode}`, async () => {
    const empty = Buffer.alloc(0);
    const sample = valid(
      "pending-empty-blocks",
      empty,
      gzip(empty, { raw: stored(empty, 20_000) }),
    );
    const result = await inspect(sample, mode, Number.MAX_SAFE_INTEGER, false);
    expect(result.cancelled).toBe(true);
    expect(result.pendingTest!.settledBeforeCancel).toBe(false);
    expect(result.pendingTest!.concurrentError).toMatch(/Concurrent gzip read/);
    expect(result.pendingTest!.synchronouslyDestroyed).toBe(true);
    expect(result.pendingTest!.firstDone).toBe(true);
    expect(result.pendingTest!.nextAfterCancelDone).toBe(true);
    if (mode === "pending-return")
      expect(result.pendingTest!.returnDone).toBe(true);
    expect(result.pendingTest!.after.submitted).toBe(
      result.pendingTest!.before.submitted,
    );
    expect(result.pendingTest!.after.drained).toBe(0);
  });
}

test("proposed resource-first policy leaves an unread tail beyond bounded witness and prefetch", async () => {
  const sample = maximumExpansionFixture(MAX_DECODED + 16_777_216);
  expect(sample.wire.byteLength).toBeLessThan(128_000);
  const result = await inspect(sample, "budget", MAX_DECODED, false);
  expectRefusal(
    result,
    MAX_DECODED,
    MAX_DECODED + 16_777_216,
    sample.wire.length - 18,
  );
  expect(result.last.submitted).toBeLessThan(
    sample.wire.length - result.observation.headerBytes,
  );
}, 60_000);

function corrupt(
  wire: Uint8Array,
  variant: (typeof strictGzipPolicyDifferences)[number]["name"],
) {
  const result = Buffer.from(wire);
  switch (variant) {
    case "bad-crc":
      result[result.length - 8] = result[result.length - 8]! ^ 1;
      return result;
    case "bad-isize":
      result[result.length - 4] = result[result.length - 4]! ^ 1;
      return result;
    case "truncated":
      return result.subarray(0, result.length - 1);
    case "trailing-zero":
      return Buffer.concat([result, Buffer.of(0)]);
  }
}

test("the original four equivalence failures remain explicit", () => {
  expect(strictGzipPriorQualification.equivalenceGate).toBe("failed-preserved");
  expect(strictGzipPolicyDifferences.map(({ priorTest }) => priorTest)).toEqual(
    [
      "native error/expansion precedence: bad-crc",
      "native error/expansion precedence: bad-isize",
      "native error/expansion precedence: truncated",
      "native error/expansion precedence: trailing-zero",
    ],
  );
});

for (const difference of strictGzipPolicyDifferences) {
  test(`proposed resource-first difference: ${difference.priorTest}`, async () => {
    const data = Buffer.alloc(65_537, 0x78);
    const base = gzip(data);
    const result = await inspect(
      {
        name: difference.name,
        wire: corrupt(base, difference.name),
        accepted: false,
      },
      "budget",
      32_768,
      true,
    );
    expectRefusal(result, 32_768, data.length, base.length - 18);
    // This deliberately records a changed policy, not a repaired equivalence
    // gate. The original standalone failing test and receipts are untouched.
    expect(disposition(result.reference!)).toBe("malformed");
    assert.notEqual(disposition(result), disposition(result.reference!));
    console.info(
      "strict-gzip-policy-difference",
      JSON.stringify({
        priorTest: difference.priorTest,
        priorEquivalenceGate: "failed-preserved",
        bounded: disposition(result),
        native: disposition(result.reference!),
      }),
    );
  });
  test(`in-budget malformed policy unchanged: ${difference.name}`, async () => {
    const base = gzip(Buffer.alloc(16_384, 0x78));
    const result = await inspect(
      {
        name: difference.name,
        wire: corrupt(base, difference.name),
        accepted: false,
      },
      "budget",
      32_768,
      true,
    );
    expect(disposition(result)).toBe("malformed");
    expect(disposition(result.reference!)).toBe("malformed");
    expect(result.refusal).toBeUndefined();
  });
}

test("valid scaled over-budget data is refused; malformed header remains malformed", async () => {
  const data = Buffer.alloc(65_537, 0x78);
  const sample = valid("valid-over-budget", data);
  const refused = await inspect(sample, "budget", 32_768, true);
  expectRefusal(refused, 32_768, data.length, sample.wire.length - 18);
  expect(disposition(refused.reference!)).toBe("resource-refusal");
  const badHeader = Buffer.from(sample.wire);
  badHeader[2] = 0;
  const malformed = await inspect(
    {
      name: "bad-header",
      wire: badHeader,
      accepted: false,
    },
    "budget",
    32_768,
    true,
  );
  expect(disposition(malformed)).toBe("malformed");
  expect(disposition(malformed.reference!)).toBe("malformed");
  expect(malformed.last.submitted).toBe(0);
  assert.equal(malformed.last.produced, 0);
});
