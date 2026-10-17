import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { gzipSync } from "node:zlib";
import {
  preserveSyncDeadLetter,
  readSyncDeadLetterEnvelope,
  SYNC_QUARANTINE_MAX_BYTES,
} from "../src/sync-dead-letter-store.ts";
import { handleDeadLetterBatch } from "../src/dead-letter.ts";
import { syncDeadLetterKv } from "./helpers/sync-dead-letter-kv.ts";
import {
  laneAlarmIssueBody,
  laneAlarmLossComment,
  laneAlarmPlan,
} from "../src/lane-alarm.ts";
import type { LaneHealthRecord } from "../src/lane-health.ts";

const queue = "sync-batches-dlq";
const prefix = "sync-quarantine:v1:";
const publishedAt = 1_792_000_000_123;
type Fixture = ReturnType<typeof syncDeadLetterKv>;
type Custody = {
  version: number;
  kind: "custody";
  queue: string;
  message_id: string;
  published_at: number;
  representation: string;
  body_bytes: number;
  body_sha256: string;
  payload: string;
};
type Observation = {
  version: number;
  kind: "observation";
  custody_sha256: string;
  attempts: number;
};
type ListPage = {
  keys: { name: string }[];
  list_complete: boolean;
};

function message(body: unknown, id = "a", attempts = 1) {
  return {
    id,
    body,
    timestamp: new Date(publishedAt),
    attempts,
    retry() {},
  };
}

function trackedMessage(
  body: unknown,
  id: string,
  acks: string[],
  retries: string[],
  attempts = 1,
) {
  return {
    ...message(body, id, attempts),
    ack: () => acks.push(id),
    retry: () => retries.push(id),
  };
}

function records(f: Fixture): (Custody | Observation)[] {
  return [...f.values.values()].map(
    (value) => JSON.parse(value) as Custody | Observation,
  );
}

function envelopes(f: Fixture): Custody[] {
  return records(f).filter((entry) => entry.kind === "custody");
}

function receipts(f: Fixture): Observation[] {
  return records(f).filter((entry) => entry.kind === "observation");
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertOperationBudget(f: Fixture, deliveries: number): void {
  assert.ok(f.lists.length <= deliveries);
  assert.ok(f.gets.length <= deliveries * 4);
  assert.ok(f.puts.length <= deliveries * 2);
  assert.ok(f.gets.every((get) => get.type === "stream"));
  assert.ok(f.puts.every((put) => put.options === undefined));
}

test("JSON and binary custody have exact linked receipts before ACK", async () => {
  const f = syncDeadLetterKv();
  const body = {
    lane: "nominator-positions",
    rows: [{ coldkey: "界", amount: "12345678901234567890" }],
  };
  const compressed = gzipSync(JSON.stringify(body));
  for (const [id, value] of [
    ["json", body],
    ["bytes", compressed],
    ["buffer", Uint8Array.from(compressed).buffer],
    ["slice", Uint8Array.from([0, ...compressed, 0]).subarray(1, -1)],
  ] as const) {
    const bytes =
      id === "json" ? Buffer.from(JSON.stringify(body)) : compressed;
    const custody = JSON.stringify({
      version: 2,
      kind: "custody",
      queue,
      message_id: id,
      published_at: publishedAt,
      representation: id === "json" ? "json" : "bytes",
      body_bytes: bytes.length,
      body_sha256: sha256(bytes),
      payload: bytes.toString("base64"),
    });
    const custodySha256 = sha256(custody);
    const custodyKey = prefix + custodySha256;
    const observation = JSON.stringify({
      version: 2,
      kind: "observation",
      custody_sha256: custodySha256,
      attempts: 7,
    });
    const observationKey =
      custodyKey + ":0000000000000007:" + sha256(observation);
    const putsBefore = f.puts.length;
    let acked = false;
    await handleDeadLetterBatch(
      {
        queue,
        messages: [
          {
            ...message(value, id, 7),
            ack() {
              assert.equal(f.values.get(custodyKey), custody);
              assert.equal(f.values.get(observationKey), observation);
              assert.deepEqual(
                f.gets.slice(-2).map((get) => get.key),
                [custodyKey, observationKey],
              );
              acked = true;
            },
          },
        ],
      },
      undefined,
      publishedAt + 1000,
      f.kv,
    );
    assert.ok(acked);
    assert.deepEqual(
      f.puts.slice(putsBefore).map(({ key, value }) => [key, value]),
      [
        [custodyKey, custody],
        [observationKey, observation],
      ],
    );
    assert.deepEqual(f.lists.at(-1), { prefix: custodyKey + ":", limit: 1 });
    const retained = envelopes(f).find((entry) => entry.message_id === id)!;
    assert.deepEqual(Buffer.from(retained.payload, "base64"), bytes);
  }
  assertOperationBudget(f, 4);
});

test("redelivery reuses custody and the oldest visible receipt", async () => {
  const f = syncDeadLetterKv();
  const m = message({ value: 1 });
  await preserveSyncDeadLetter(f.kv, queue, m);
  const first = [...f.values.entries()];
  for (const attempts of [1, 3, 9])
    await preserveSyncDeadLetter(f.kv, queue, { ...m, attempts });
  assert.deepEqual([...f.values.entries()], first);
  assert.equal(f.puts.length, 2);
  assert.deepEqual(
    receipts(f).map((entry) => entry.attempts),
    [1],
  );
  assert.equal(envelopes(f).length, 1);
  assertOperationBudget(f, 4);
});

test("both records are staged before a cached miss fails confirmation", async () => {
  const f = syncDeadLetterKv();
  const acks: string[] = [];
  const retries: string[] = [];
  f.hooks.read = (_key, call) => {
    if (call > 2) assert.equal(f.puts.length, 2);
    return null;
  };
  f.hooks.list = () => ({ keys: [], list_complete: true });
  const m = trackedMessage({}, "a", acks, retries);
  await handleDeadLetterBatch({ queue, messages: [m] }, undefined, 1, f.kv);
  assert.deepEqual(acks, []);
  assert.deepEqual(retries, ["a"]);
  assert.equal(envelopes(f).length, 1);
  assert.deepEqual(
    receipts(f).map((entry) => entry.attempts),
    [1],
  );
  delete f.hooks.read;
  delete f.hooks.list;
  await handleDeadLetterBatch(
    { queue, messages: [{ ...m, attempts: 4 }] },
    undefined,
    2,
    f.kv,
  );
  assert.deepEqual(acks, ["a"]);
  assert.equal(f.puts.length, 2, "the original writes need no new receipt");
  assertOperationBudget(f, 2);
});

test("hidden receipts retain one body and eventually reuse the first", async () => {
  const f = syncDeadLetterKv();
  f.hooks.read = () => null;
  f.hooks.list = () => ({ keys: [], list_complete: true });
  for (const attempts of [1, 2, 3])
    await assert.rejects(
      preserveSyncDeadLetter(f.kv, queue, message({}, "a", attempts)),
      /readback differs/,
    );
  const bodyKeys = f.puts
    .filter((put) => JSON.parse(put.value).kind === "custody")
    .map((put) => put.key);
  assert.equal(new Set(bodyKeys).size, 1);
  assert.equal(envelopes(f).length, 1);
  assert.deepEqual(
    receipts(f).map((entry) => entry.attempts),
    [1, 2, 3],
  );
  const putsBefore = f.puts.length;
  delete f.hooks.read;
  delete f.hooks.list;
  await preserveSyncDeadLetter(f.kv, queue, message({}, "a", 8));
  assert.equal(f.puts.length, putsBefore);
  const firstReceipt = f.puts.find(
    (put) => JSON.parse(put.value).kind === "observation",
  )!;
  assert.equal(f.gets.at(-1)!.key, firstReceipt.key);
  assertOperationBudget(f, 4);
});

test("a cached empty listing checks the exact current receipt", async () => {
  const f = syncDeadLetterKv();
  const m = message({});
  await preserveSyncDeadLetter(f.kv, queue, m);
  f.hooks.list = () => ({ keys: [], list_complete: true });
  await preserveSyncDeadLetter(f.kv, queue, m);
  assert.equal(f.puts.length, 2);
  assert.equal(receipts(f).length, 1);
  assertOperationBudget(f, 2);
  const receipt = f.puts[1]!;
  const changed = receipt.value + "\n";
  f.values.set(receipt.key, changed);
  await assert.rejects(
    preserveSyncDeadLetter(f.kv, queue, m),
    /observation readback differs/,
  );
  assert.equal(
    f.puts.length,
    2,
    "a corrupt current receipt is not overwritten",
  );
  assert.equal(f.values.get(receipt.key), changed);
});

test("malformed or incomplete receipt listings refuse new writes", async () => {
  const good = syncDeadLetterKv();
  await preserveSyncDeadLetter(good.kv, queue, message({}));
  const receiptKey = good.puts[1]!.key;
  const receiptPrefix = good.puts[0]!.key + ":";
  const malformedNames = [
    "other:" + receiptKey,
    receiptKey + "\n",
    receiptPrefix + "1:" + "a".repeat(64),
    receiptPrefix + "0000000000000000:" + "a".repeat(64),
    receiptPrefix + "9999999999999999:" + "a".repeat(64),
    receiptPrefix + "0000000000000001:" + "A".repeat(64),
  ];
  const pages: unknown[] = [
    { keys: [], list_complete: false },
    { keys: [], list_complete: undefined },
    { keys: undefined, list_complete: true },
    { keys: [{ name: receiptKey }, { name: receiptKey }], list_complete: true },
    { keys: [{ name: 7 }], list_complete: true },
    { keys: [{}], list_complete: true },
    { keys: [null], list_complete: true },
    { keys: new Array(1), list_complete: true },
    ...malformedNames.map((name) => ({
      keys: [{ name }],
      list_complete: true,
    })),
  ];
  for (const page of pages) {
    const f = syncDeadLetterKv();
    f.hooks.list = () => page as ListPage;
    await assert.rejects(preserveSyncDeadLetter(f.kv, queue, message({})));
    assert.equal(f.puts.length, 0);
  }
});

test("listed receipts must match their bytes, digest and custody", async () => {
  const good = syncDeadLetterKv();
  const m = message({});
  await preserveSyncDeadLetter(good.kv, queue, m);
  const body = good.puts[0]!;
  const receipt = good.puts[1]!;
  const observation = JSON.parse(receipt.value) as Observation;
  for (const stored of [
    null,
    receipt.value + "\n",
    JSON.stringify({ ...observation, custody_sha256: "0".repeat(64) }),
    JSON.stringify({ ...observation, attempts: 2 }),
    JSON.stringify({ ...observation, kind: "custody" }),
    JSON.stringify({ ...observation, version: 1 }),
  ]) {
    const f = syncDeadLetterKv();
    f.values.set(body.key, body.value);
    if (stored !== null) f.values.set(receipt.key, stored);
    f.hooks.list = () => ({
      keys: [{ name: receipt.key }],
      list_complete: true,
    });
    await assert.rejects(
      preserveSyncDeadLetter(f.kv, queue, { ...m, attempts: 3 }),
      /observation readback differs/,
    );
    assert.equal(f.puts.length, 0);
    assert.equal(f.values.get(receipt.key), stored ?? undefined);
  }
  const f = syncDeadLetterKv();
  f.hooks.list = () => ({
    keys: [{ name: receipt.key.slice(0, -64) + "0".repeat(64) }],
    list_complete: true,
  });
  await assert.rejects(
    preserveSyncDeadLetter(f.kv, queue, m),
    /observation digest differs/,
  );
  assert.equal(f.puts.length, 0);
});

test("a receipt can confirm a body absent from the initial read", async () => {
  const f = syncDeadLetterKv();
  const m = message({});
  await preserveSyncDeadLetter(f.kv, queue, m);
  const body = f.puts[0]!;
  f.values.delete(body.key);
  await preserveSyncDeadLetter(f.kv, queue, { ...m, attempts: 5 });
  assert.equal(f.values.get(body.key), body.value);
  assert.equal(f.puts.length, 3);
  assert.equal(f.puts[2]!.key, body.key);
  assert.deepEqual(
    receipts(f).map((entry) => entry.attempts),
    [1],
  );
});

test("concurrent duplicates agree on bytes and discover the oldest receipt", async () => {
  for (const attempts of [
    [1, 1],
    [1, 2],
  ]) {
    const f = syncDeadLetterKv();
    await Promise.all(
      attempts.map((attempt) =>
        preserveSyncDeadLetter(f.kv, queue, message({}, "a", attempt)),
      ),
    );
    assert.equal(envelopes(f).length, 1);
    for (const key of new Set(f.puts.map((put) => put.key))) {
      const values = f.puts
        .filter((put) => put.key === key)
        .map((put) => put.value);
      assert.equal(new Set(values).size, 1);
    }
    assert.ok(receipts(f).some((entry) => entry.attempts === 1));
    const putsBefore = f.puts.length;
    await preserveSyncDeadLetter(f.kv, queue, message({}, "a", 7));
    assert.equal(f.puts.length, putsBefore);
    const oldest = f.puts.find((put) => {
      const entry = JSON.parse(put.value) as Custody | Observation;
      return entry.kind === "observation" && entry.attempts === 1;
    })!;
    assert.equal(f.gets.at(-1)!.key, oldest.key);
    assertOperationBudget(f, 3);
  }
});

test("conflicting body and identity values coexist without overwriting", async () => {
  const f = syncDeadLetterKv();
  const m = message({ value: 1 });
  for (const observation of [
    m,
    { ...m, attempts: 2 },
    { ...m, body: { value: 2 } },
    { ...m, id: "different" },
    { ...m, timestamp: new Date(publishedAt + 1) },
    { ...m, body: Buffer.from(JSON.stringify(m.body)) },
  ])
    await preserveSyncDeadLetter(f.kv, queue, observation);
  assert.equal(envelopes(f).length, 5);
  assert.equal(receipts(f).length, 5);
  assert.equal(f.puts.length, 10);
  const retained = envelopes(f);
  assert.deepEqual(
    retained.map((entry) => Buffer.from(entry.payload, "base64").toString()),
    ['{"value":1}', '{"value":2}', '{"value":1}', '{"value":1}', '{"value":1}'],
  );
  assert.equal(retained[4]!.representation, "bytes");
});

test("storage failures retry only the unconfirmed message", async () => {
  for (const operation of ["read", "list", "put", "readback"] as const) {
    const f = syncDeadLetterKv();
    const acks: string[] = [];
    const retries: string[] = [];
    if (operation === "put")
      f.hooks.beforePut = () => {
        throw new Error("store unavailable");
      };
    else if (operation === "list")
      f.hooks.list = () => {
        throw new Error("store unavailable");
      };
    else
      f.hooks.read = (key, call) => {
        if (operation === "read" || call > 2)
          throw new Error("store unavailable");
        return f.values.get(key) ?? null;
      };
    const m = trackedMessage({}, "a", acks, retries);
    await handleDeadLetterBatch({ queue, messages: [m] }, undefined, 1, f.kv);
    assert.deepEqual(acks, [], operation);
    assert.deepEqual(retries, ["a"], operation);
    assert.equal(f.values.size, operation === "readback" ? 2 : 0);
  }
});

test("first and middle failures leave successful batch mates independent", async () => {
  for (const failed of ["a", "b"]) {
    const f = syncDeadLetterKv();
    const acks: string[] = [];
    const retries: string[] = [];
    const messages = ["a", "b", "c"].map((id) =>
      trackedMessage({ lane: "neurons" }, id, acks, retries),
    );
    f.hooks.beforePut = (_key, value) => {
      const entry = JSON.parse(value) as Custody | Observation;
      if (entry.kind === "custody" && entry.message_id === failed)
        throw new Error("store unavailable");
    };
    await handleDeadLetterBatch({ queue, messages }, undefined, 1, f.kv);
    assert.deepEqual(
      acks,
      ["a", "b", "c"].filter((id) => id !== failed),
    );
    assert.deepEqual(retries, [failed]);
    assert.equal(envelopes(f).length, 2);
    delete f.hooks.beforePut;
    const retry = messages.find((m) => m.id === failed)!;
    await handleDeadLetterBatch(
      { queue, messages: [{ ...retry, attempts: 2 }] },
      undefined,
      2,
      f.kv,
    );
    assert.equal(envelopes(f).length, 3);
    assert.equal(acks.at(-1), failed);
  }
});

test("failed retry registration rejects after processing batch mates", async () => {
  const f = syncDeadLetterKv();
  const acks: string[] = [];
  const retries: string[] = [];
  const first = trackedMessage({}, "a", acks, retries);
  first.retry = () => {
    throw new Error("retry unavailable");
  };
  f.hooks.beforePut = (_key, value) => {
    const entry = JSON.parse(value) as Custody | Observation;
    if (entry.kind === "custody" && entry.message_id === "a")
      throw new Error("store unavailable");
  };
  const second = trackedMessage({}, "b", acks, retries);
  await assert.rejects(
    handleDeadLetterBatch(
      { queue, messages: [first, second] },
      undefined,
      1,
      f.kv,
    ),
    /retries could not be registered/,
  );
  assert.deepEqual(acks, ["b"]);
  assert.deepEqual(retries, []);
});

test("lost write responses and ACKs preserve recoverable custody", async () => {
  for (const failure of ["body-response", "receipt-response", "ack"] as const) {
    const f = syncDeadLetterKv();
    const acks: string[] = [];
    const retries: string[] = [];
    let fail = true;
    f.hooks.afterPut = (_key, value) => {
      const entry = JSON.parse(value) as Custody | Observation;
      const selected = failure === "body-response" ? "custody" : "observation";
      if (fail && failure !== "ack" && entry.kind === selected)
        throw new Error("write response lost");
    };
    const m = {
      ...trackedMessage({}, "a", acks, retries),
      ack() {
        if (fail && failure === "ack") throw new Error("ack lost");
        acks.push("a");
      },
    };
    await handleDeadLetterBatch({ queue, messages: [m] }, undefined, 1, f.kv);
    assert.deepEqual(acks, []);
    assert.deepEqual(retries, ["a"]);
    assert.equal(envelopes(f).length, 1);
    const putsBefore = f.puts.length;
    fail = false;
    await handleDeadLetterBatch(
      { queue, messages: [{ ...m, attempts: 4 }] },
      undefined,
      2,
      f.kv,
    );
    assert.deepEqual(acks, ["a"]);
    assert.equal(envelopes(f).length, 1);
    assert.equal(receipts(f).length, 1);
    const extraPut = failure === "body-response" ? 1 : 0;
    assert.equal(f.puts.length, putsBefore + extraPut);
    const expectedAttempt = failure === "body-response" ? 4 : 1;
    assert.equal(receipts(f)[0]!.attempts, expectedAttempt);
  }
});

test("missing or stale readback cannot establish preservation", async () => {
  for (const stale of [null, "stale bytes"]) {
    const f = syncDeadLetterKv();
    f.hooks.read = () => stale;
    await assert.rejects(preserveSyncDeadLetter(f.kv, queue, message({})));
    assert.equal(f.puts.length, stale === null ? 2 : 0);
  }
});

test("stored bytes use a fixed budget and release their readers", async () => {
  const f = syncDeadLetterKv();
  const bytes = "a".repeat(SYNC_QUARANTINE_MAX_BYTES);
  f.values.set("bounded", bytes);
  f.hooks.stream = (value) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(value.slice(0, 100)));
        controller.enqueue(Buffer.from(value.slice(100)));
        controller.close();
      },
    });
  assert.deepEqual(
    await readSyncDeadLetterEnvelope(f.kv, "bounded"),
    Buffer.from(bytes),
  );
  assert.deepEqual(f.streams, [{ reads: 3, cancels: 1, releases: 1 }]);
  f.values.set("oversized", bytes + "b");
  await assert.rejects(readSyncDeadLetterEnvelope(f.kv, "oversized"), /budget/);
  assert.deepEqual(f.streams[1], { reads: 2, cancels: 1, releases: 1 });
  assert.equal(f.puts.length, 0);
});

test("stream failures remain fail closed and release their readers", async () => {
  const f = syncDeadLetterKv();
  f.values.set("failed", "bytes");
  f.hooks.stream = () =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("stream failed"));
      },
    });
  await assert.rejects(
    readSyncDeadLetterEnvelope(f.kv, "failed"),
    /stream failed/,
  );
  assert.deepEqual(f.streams, [{ reads: 1, cancels: 1, releases: 1 }]);
  assert.equal(f.puts.length, 0);
});

test("claimed hashes cannot hide changed custody or payload bytes", async () => {
  const good = syncDeadLetterKv();
  const m = message({ value: "original" });
  await preserveSyncDeadLetter(good.kv, queue, m);
  const { key, value } = good.puts[0]!;
  const envelope = JSON.parse(value) as Custody;
  for (const changed of [
    { ...envelope, payload: Buffer.from("different").toString("base64") },
    { ...envelope, body_sha256: "0".repeat(64) },
    { ...envelope, body_bytes: envelope.body_bytes + 1 },
    { ...envelope, representation: "bytes" },
    { ...envelope, queue: "other-queue" },
    { ...envelope, message_id: "other-id" },
    { ...envelope, published_at: publishedAt + 1 },
    { ...envelope, kind: "observation" },
    { ...envelope, version: 1 },
  ]) {
    const f = syncDeadLetterKv();
    const corrupted = JSON.stringify(changed);
    f.values.set(key, corrupted);
    await assert.rejects(preserveSyncDeadLetter(f.kv, queue, m));
    assert.equal(f.puts.length, 0);
    assert.equal(f.lists.length, 0);
    assert.equal(f.values.get(key), corrupted);
  }
  const f = syncDeadLetterKv();
  f.values.set(key, value + "\n");
  await assert.rejects(preserveSyncDeadLetter(f.kv, queue, m));
  assert.equal(f.puts.length, 0, "verification compares exact stored bytes");
});

test("corruption after either put prevents acknowledgment", async () => {
  for (const corrupt of ["custody", "observation"]) {
    const f = syncDeadLetterKv();
    f.hooks.afterPut = (key, value) => {
      const entry = JSON.parse(value) as Custody | Observation;
      if (entry.kind === corrupt) f.values.set(key, value + "\n");
    };
    const acks: string[] = [];
    const retries: string[] = [];
    const m = trackedMessage({}, "a", acks, retries);
    await handleDeadLetterBatch({ queue, messages: [m] }, undefined, 1, f.kv);
    assert.deepEqual(acks, []);
    assert.deepEqual(retries, ["a"]);
  }
});

test("legacy records cannot substitute for v2 custody", async () => {
  const f = syncDeadLetterKv();
  const legacy = JSON.stringify({
    version: 1,
    queue,
    message_id: "a",
    published_at: publishedAt,
    attempts: 1,
    representation: "json",
    body_bytes: 2,
    body_sha256: sha256("{}"),
    payload: Buffer.from("{}").toString("base64"),
  });
  const legacyKey = prefix + sha256(legacy);
  f.values.set(legacyKey, legacy);
  await preserveSyncDeadLetter(f.kv, queue, message({}));
  assert.equal(f.values.get(legacyKey), legacy);
  assert.equal(envelopes(f).length, 1);
  assert.equal(receipts(f).length, 1);
  assert.equal(f.puts.length, 2);
  assert.ok(f.gets.every((get) => get.key !== legacyKey));
});

test("invalid delivery metadata retries before touching storage", async () => {
  const f = syncDeadLetterKv();
  const valid = message({});
  for (const invalid of [
    { ...valid, id: undefined },
    { ...valid, id: 7 as unknown as string },
    { ...valid, id: "" },
    { ...valid, id: "a".repeat(257) },
    { ...valid, timestamp: undefined },
    { ...valid, timestamp: new Date(Number.NaN) },
    { ...valid, timestamp: new Date(-1) },
    { ...valid, timestamp: { getTime: () => publishedAt } as unknown as Date },
    { ...valid, attempts: undefined },
    { ...valid, attempts: 0 },
    { ...valid, attempts: -1 },
    { ...valid, attempts: 1.5 },
    { ...valid, attempts: Number.NaN },
    { ...valid, attempts: Number.POSITIVE_INFINITY },
    { ...valid, attempts: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    let acked = false;
    let retried = false;
    await handleDeadLetterBatch(
      {
        queue,
        messages: [
          {
            ...invalid,
            ack: () => {
              acked = true;
            },
            retry: () => {
              retried = true;
            },
          },
        ],
      },
      undefined,
      1,
      f.kv,
    );
    assert.equal(acked, false);
    assert.equal(retried, true);
  }
  await assert.rejects(preserveSyncDeadLetter(undefined, queue, valid));
  await assert.rejects(preserveSyncDeadLetter(f.kv, "sync-batches", valid));
  assert.equal(f.gets.length, 0);
  assert.equal(f.puts.length, 0);
  assert.equal(f.lists.length, 0);
  await preserveSyncDeadLetter(f.kv, queue, {
    ...valid,
    id: "a".repeat(256),
    timestamp: new Date(0),
    attempts: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(envelopes(f)[0]!.published_at, 0);
  assert.equal(receipts(f)[0]!.attempts, Number.MAX_SAFE_INTEGER);
});

test("unsupported JSON cannot be silently dropped or coerced", async () => {
  const f = syncDeadLetterKv();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse: unknown[] = [];
  sparse.length = 1;
  const sparseWithExtra = Object.assign(new Array(1), { extra: true });
  const sparseWithNumericKey = Object.assign(new Array(1), {
    4294967295: true,
  });
  for (const body of [
    undefined,
    () => 1,
    Symbol("value"),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    new Date(publishedAt),
    new Map([["a", 1]]),
    new Set([1]),
    new Uint16Array([1]),
    Object.setPrototypeOf([], null),
    Object.create({ inherited: 1 }),
    { toJSON: () => ({ replacement: true }) },
    { missing: undefined },
    { callback: () => 1 },
    { number: Number.NEGATIVE_INFINITY },
    [undefined],
    [1n],
    { [Symbol("hidden")]: 1 },
    Object.defineProperty({}, "hidden", { value: 1 }),
    Object.defineProperty({}, "value", { enumerable: true, get: () => 1 }),
    sparse,
    sparseWithExtra,
    sparseWithNumericKey,
    cycle,
  ])
    await assert.rejects(preserveSyncDeadLetter(f.kv, queue, message(body)));
  assert.equal(f.gets.length, 0);
  assert.equal(f.puts.length, 0);
  assert.equal(f.lists.length, 0);
});

test("supported JSON retains its observed UTF-8 serialization", async () => {
  const f = syncDeadLetterKv();
  const shared = { value: 1 };
  const bodies = [
    null,
    true,
    false,
    0,
    1.25,
    "界",
    [],
    {},
    [null, { a: [1, "界"] }],
    { first: shared, second: shared },
    Object.assign(Object.create(null), { value: 1 }),
  ];
  for (const [index, body] of bodies.entries())
    await preserveSyncDeadLetter(f.kv, queue, message(body, String(index)));
  assert.deepEqual(
    envelopes(f).map((entry) =>
      JSON.parse(Buffer.from(entry.payload, "base64").toString()),
    ),
    bodies.map((body) => JSON.parse(JSON.stringify(body))),
  );
});

test("body limits count bytes and maximum custody stays bounded", async () => {
  const f = syncDeadLetterKv();
  for (const body of [new Uint8Array(128 * 1024 + 1), "界".repeat(50_000)])
    await assert.rejects(preserveSyncDeadLetter(f.kv, queue, message(body)));
  assert.equal(f.puts.length, 0);
  await preserveSyncDeadLetter(
    f.kv,
    queue,
    message(new Uint8Array(128 * 1024), "\u0000".repeat(256)),
  );
  const put = f.puts[0]!;
  const envelope = envelopes(f)[0]!;
  assert.equal(envelope.body_bytes, 128 * 1024);
  assert.equal(envelope.payload.length, 174_764);
  assert.ok(Buffer.byteLength(put.value) <= SYNC_QUARANTINE_MAX_BYTES);
  assert.match(put.key, /^sync-quarantine:v1:[a-f0-9]{64}$/);
  assertOperationBudget(f, 1);
});

test("a 100-message batch stays within 700 storage operations", async () => {
  const f = syncDeadLetterKv();
  const acks: string[] = [];
  const retries: string[] = [];
  const messages = Array.from({ length: 100 }, (_, index) =>
    trackedMessage({ index }, String(index), acks, retries),
  );
  await handleDeadLetterBatch({ queue, messages }, undefined, 1, f.kv);
  assert.equal(acks.length, 100);
  assert.deepEqual(retries, []);
  assert.equal(envelopes(f).length, 100);
  assert.equal(receipts(f).length, 100);
  assertOperationBudget(f, 100);
  assert.ok(f.gets.length + f.puts.length + f.lists.length <= 700);
});

test("preservation retries keep the existing incident open", async () => {
  const f = syncDeadLetterKv();
  const observed: LaneHealthRecord[] = [];
  const health = {
    async query() {
      return [];
    },
    async run(text: string, values: unknown[] = []) {
      if (text.startsWith("INSERT INTO lane_health"))
        observed.push({
          lane: String(values[0]),
          verdict: "stale",
          age_ms: null,
          detail: String(values[3]),
          checked_at: Number(values[4]),
        });
      return { changes: 1 };
    },
  };
  const acks: string[] = [];
  const retries: string[] = [];
  const messages = ["a", "b"].map((id) =>
    trackedMessage({ lane: "hotkey-alpha", rows: [] }, id, acks, retries),
  );
  const now = publishedAt + 10_000;
  f.hooks.beforePut = (_key, value) => {
    const entry = JSON.parse(value) as Custody | Observation;
    if (entry.kind === "custody" && entry.message_id === "b")
      throw new Error("store unavailable");
  };
  await handleDeadLetterBatch({ queue, messages }, health, now - 2000, f.kv);
  assert.equal(observed.length, 1, "failure still records a stale observation");
  assert.deepEqual(acks, ["a"]);
  assert.deepEqual(retries, ["b"]);
  assert.equal(envelopes(f).length, 1);
  delete f.hooks.beforePut;
  await handleDeadLetterBatch(
    { queue, messages: [{ ...messages[1]!, attempts: 2 }] },
    health,
    now - 1000,
    f.kv,
  );
  await handleDeadLetterBatch({ queue, messages }, health, now, f.kv);
  assert.deepEqual(acks, ["a", "b", "a", "b"]);
  assert.equal(observed.length, 3);
  assert.equal(envelopes(f).length, 2);
  assert.equal(receipts(f).length, 2);
  const latest = observed[2]!;
  assert.equal(
    latest.checked_at,
    now,
    "the observation clock is independent of publication",
  );
  assert.ok(envelopes(f).every((entry) => entry.published_at === publishedAt));
  const plan = laneAlarmPlan({
    latest: { [queue]: latest },
    runs: {
      [queue]: { since: observed[0]!.checked_at, ticks: observed.length },
    },
    unknownRuns: {},
    observedMaxGap: {},
    openAlarms: { [queue]: { issue: 12640, updatedAt: now - 500 } },
    nowMs: now,
    minStaleMs: 0,
  });
  assert.deepEqual(plan.open, []);
  assert.deepEqual(plan.close, []);
  assert.deepEqual(
    plan.update.map((entry) => entry.issue),
    [12640],
  );
  const body = laneAlarmIssueBody(
    {
      lane: queue,
      kind: "stale",
      since: observed[0]!.checked_at,
      ticks: observed.length,
      detail: latest.detail,
      age_ms: null,
      cadence_ms: null,
    },
    now,
  );
  assert.match(body, /3 retained dead-letter observation\(s\)/);
  assert.match(body, /not unique messages or confirmed permanent losses/);
  const comment = laneAlarmLossComment(queue, latest);
  assert.ok(comment.includes(latest.detail!));
  assert.match(comment, /may repeat previously seen messages/);
  assert.match(
    comment,
    /does not establish unique-message counts, durable preservation or confirmed permanent loss/,
  );
  assert.doesNotMatch(body + comment, /lost more|were acked|count of losses/);
});
