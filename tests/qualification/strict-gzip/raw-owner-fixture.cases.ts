// Pure fixture controls; no native build, runtime, SQLite, sockets or providers.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedRawRequest,
  cleanupRawOwner,
  rawDigest,
  rawLane,
  rawPairBarrier,
  rawRecord,
  rawRpcPayload,
} from "./raw-owner-fixture.ts";
import { withinOwnerDeadline } from "./owner-deadline.ts";

const digest = (text: string) => rawDigest(text);
const first = () =>
  [digest("request-mainnet"), digest("response-mainnet")] as const;
const second = () =>
  [digest("request-testnet"), digest("response-testnet")] as const;

test("raw overlap holds both distinct lanes through observation", async () => {
  let resolveObservation!: () => void;
  const observed = new Promise<void>((resolve) => {
    resolveObservation = resolve;
  });
  const barrier = rawPairBarrier(() => observed, 100);
  let settled = 0;
  const mainnet = barrier.arrive("mainnet", ...first()).then(() => {
    settled++;
  });
  const testnet = barrier.arrive("testnet", ...second()).then(() => {
    settled++;
  });
  await Promise.resolve();
  assert.equal(settled, 0);
  assert.equal(barrier.receipt().pending, 2);
  assert.equal(barrier.receipt().released, false);
  resolveObservation();
  await Promise.all([mainnet, testnet]);
  assert.equal(settled, 2);
  const receipt = barrier.receipt();
  assert.equal(receipt.pending, 0);
  assert.equal(receipt.maximumPending, 2);
  assert.equal(receipt.failed, false);
  assert.ok(receipt.arrivals.every((row) => row.atMs < receipt.openedAtMs!));
  assert.equal(receipt.writerOverlapEstablished, false);
  barrier.close();
});

test("raw overlap rejects a missing second lane within its deadline", async () => {
  const barrier = rawPairBarrier(undefined, 5);
  await assert.rejects(
    barrier.arrive("mainnet", ...first()),
    /raw_owner_overlap_refused/,
  );
  assert.equal(barrier.receipt().failed, true);
  assert.equal(barrier.receipt().released, false);
  assert.equal(barrier.receipt().pending, 0);
  barrier.close();
});

test("raw overlap rejects duplicate lane identity and fails the waiting lane", async () => {
  const barrier = rawPairBarrier(undefined, 100);
  const pending = barrier.arrive("mainnet", ...first());
  const failed = assert.rejects(pending, /raw_owner_overlap_refused/);
  await assert.rejects(
    barrier.arrive("mainnet", ...second()),
    /raw_owner_overlap_identity/,
  );
  await failed;
  assert.equal(barrier.receipt().released, false);
  assert.equal(barrier.receipt().pending, 0);
  barrier.close();
});

test("raw overlap refuses duplicate network request or response digests", async () => {
  for (const digests of [
    [first()[0], second()[1]],
    [second()[0], first()[1]],
  ]) {
    const barrier = rawPairBarrier(undefined, 100);
    const failed = assert.rejects(
      barrier.arrive("mainnet", ...first()),
      /raw_owner_overlap_refused/,
    );
    await assert.rejects(
      barrier.arrive("testnet", digests[0]!, digests[1]!),
      /raw_owner_overlap_identity/,
    );
    await failed;
    assert.equal(barrier.receipt().released, false);
    barrier.close();
  }
});

test("raw observation failure never releases the pair as successful overlap", async () => {
  const barrier = rawPairBarrier(async () => {
    throw new Error("synthetic observer failure");
  }, 100);
  const waits = [
    assert.rejects(
      barrier.arrive("mainnet", ...first()),
      /raw_owner_overlap_refused/,
    ),
    assert.rejects(
      barrier.arrive("testnet", ...second()),
      /raw_owner_overlap_refused/,
    ),
  ];
  await Promise.all(waits);
  assert.equal(barrier.receipt().released, false);
  assert.equal(barrier.receipt().pending, 0);
  barrier.close();
});

test("raw synthetic responses retain distinct network records and exactly 25 bodies/events", () => {
  const eventsKey = `0x${"ab".repeat(32)}`;
  for (const network of ["mainnet", "testnet"] as const) {
    const lane = rawLane(network, network === "mainnet" ? 100 : 200);
    const rows = Array.from({ length: 25 }, (_, index) =>
      rawRecord(lane, lane.first + index, 1),
    );
    const calls = [
      ...rows.map((row, index) => ({
        jsonrpc: "2.0",
        id: index,
        method: "chain_getBlock",
        params: [row.block_hash],
      })),
      ...rows.map((row, index) => ({
        jsonrpc: "2.0",
        id: index + 25,
        method: "state_getStorage",
        params: [eventsKey, row.block_hash],
      })),
    ];
    const payload = rawRpcPayload(lane, calls, eventsKey);
    assert.equal(payload.calls, 50);
    assert.equal(payload.method, "batch");
    const parsed = JSON.parse(payload.bytes.toString());
    for (let index = 0; index < 25; index++) {
      assert.deepEqual(parsed[index].result.block.header, rows[index]!.header);
      assert.deepEqual(
        parsed[index].result.block.extrinsics,
        rows[index]!.extrinsics,
      );
      assert.equal(parsed[index + 25].result, rows[index]!.events);
    }
    assert.throws(() => rawRpcPayload(lane, calls.slice(1), eventsKey));
    assert.throws(() =>
      rawRpcPayload(lane, [...calls.slice(0, 49), calls[0]], eventsKey),
    );
  }
});

test("raw synthetic RPC refuses unexpected methods and oversized request bodies", async () => {
  const lane = rawLane("mainnet", 100);
  assert.throws(() =>
    rawRpcPayload(
      lane,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "unexpected",
        params: [],
      },
      "unused",
    ),
  );
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(boundedRawRequest(stream), /fixture bound/);
  assert.equal(cancelled, true);
});

test("raw synthetic request reader preserves exact bounded bytes", async () => {
  const expected = Buffer.from('{"synthetic":true}');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(expected.subarray(0, 3));
      controller.enqueue(expected.subarray(3));
      controller.close();
    },
  });
  assert.deepEqual(await boundedRawRequest(stream), expected);
});

test("raw event timeout still closes the barrier and attempts every cleanup step", async () => {
  const barrier = rawPairBarrier(undefined, 100);
  const laneRefused = assert.rejects(
    barrier.arrive("mainnet", ...first()),
    /raw_owner_overlap_refused/,
  );
  const pendingEvent = new Promise<never>(() => {});
  await assert.rejects(
    withinOwnerDeadline(pendingEvent, 5),
    /deadline exceeded/,
  );
  const attempted: string[] = [];
  const failures = await cleanupRawOwner(
    {
      barrier: () => {
        attempted.push("barrier");
        barrier.close();
      },
      completion: () => {
        attempted.push("completion");
        return pendingEvent;
      },
      observer: () => {
        attempted.push("observer");
      },
      runtime: () => {
        attempted.push("runtime");
      },
      files: () => {
        attempted.push("files");
      },
    },
    5,
  );
  await laneRefused;
  assert.deepEqual(attempted, [
    "barrier",
    "completion",
    "observer",
    "runtime",
    "files",
  ]);
  assert.deepEqual(failures, ["completion"]);
  assert.equal(barrier.receipt().released, false);
  assert.equal(barrier.receipt().pending, 0);
});

test("raw cleanup retains failures and reaches disposal/files after earlier failures", async () => {
  const attempted: string[] = [];
  let disposed = false;
  const failures = await cleanupRawOwner(
    {
      barrier: () => {
        attempted.push("barrier");
        throw new Error("synthetic gate failure");
      },
      observer: async () => {
        attempted.push("observer");
        throw new Error("synthetic inspector failure");
      },
      runtime: async () => {
        attempted.push("runtime");
        await new Promise<never>(() => {});
        disposed = true;
      },
      files: () => {
        attempted.push("files");
      },
    },
    5,
  );
  assert.deepEqual(attempted, ["barrier", "observer", "runtime", "files"]);
  assert.deepEqual(failures, ["barrier", "observer", "runtime"]);
  assert.equal(
    disposed,
    false,
    "A disposal timeout cannot be recorded as successful disposal",
  );
});

test("raw cleanup rejection is never converted into successful custody", async () => {
  const attempted: string[] = [];
  const failures = await cleanupRawOwner(
    {
      completion: async () => {
        attempted.push("completion");
        throw new Error("synthetic event failure");
      },
      observer: () => {
        attempted.push("observer");
      },
      runtime: () => {
        attempted.push("runtime");
      },
      files: async () => {
        attempted.push("files");
        throw new Error("synthetic removal failure");
      },
    },
    5,
  );
  assert.deepEqual(attempted, ["completion", "observer", "runtime", "files"]);
  assert.deepEqual(failures, ["completion", "files"]);
});
