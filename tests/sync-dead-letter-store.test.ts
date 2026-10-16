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
const publishedAt = 1_792_000_000_123;
type Envelope = {
  version: number;
  queue: string;
  message_id: string;
  published_at: number;
  attempts: number;
  representation: string;
  body_bytes: number;
  body_sha256: string;
  payload: string;
};

function message(body: unknown, id = "a", attempts = 1) {
  return { id, body, timestamp: new Date(publishedAt), attempts };
}

function envelopes(f: ReturnType<typeof syncDeadLetterKv>): Envelope[] {
  return [...f.values.values()].map((value) => JSON.parse(value) as Envelope);
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("complete JSON and compressed byte observations are verified before acknowledgment", async () => {
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
    let acked = false;
    const putsBefore = f.puts.length;
    await handleDeadLetterBatch(
      {
        queue,
        messages: [
          {
            ...message(value, id, 7),
            ack() {
              const put = f.puts[putsBefore]!;
              assert.equal(f.gets.at(-1)!.key, put.key);
              assert.equal(f.gets.at(-1)!.type, "stream");
              assert.equal(f.values.get(put.key), put.value);
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
    const put = f.puts[putsBefore]!;
    const bytes =
      id === "json" ? Buffer.from(JSON.stringify(body)) : compressed;
    const expected = {
      version: 1,
      queue,
      message_id: id,
      published_at: publishedAt,
      attempts: 7,
      representation: id === "json" ? "json" : "bytes",
      body_bytes: bytes.length,
      body_sha256: sha256(bytes),
      payload: bytes.toString("base64"),
    };
    assert.equal(put.value, JSON.stringify(expected));
    assert.equal(put.key, `sync-quarantine:v1:${sha256(put.value)}`);
    assert.equal(put.options, undefined, "preservation has no expiration");
    assert.deepEqual(Buffer.from(expected.payload, "base64"), bytes);
  }
});

test("an identical observation is idempotent and needs no second write", async () => {
  const f = syncDeadLetterKv();
  const m = message({ value: 1 });
  await preserveSyncDeadLetter(f.kv, queue, m);
  const first = [...f.values.entries()];
  await preserveSyncDeadLetter(f.kv, queue, m);
  assert.deepEqual([...f.values.entries()], first);
  assert.equal(f.puts.length, 1);
  assert.equal(f.gets.length, 3);
});

test("different attempts and conflicting identities retain separate complete observations", async () => {
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
  assert.equal(f.values.size, 6);
  assert.equal(new Set(f.puts.map((put) => put.key)).size, 6);
  const retained = envelopes(f);
  assert.deepEqual(retained.map((entry) => entry.attempts), [1, 2, 1, 1, 1, 1]);
  assert.deepEqual(
    retained.map((entry) => Buffer.from(entry.payload, "base64").toString()),
    [
      '{"value":1}',
      '{"value":1}',
      '{"value":2}',
      '{"value":1}',
      '{"value":1}',
      '{"value":1}',
    ],
  );
  assert.equal(retained[5]!.representation, "bytes");
});

test("store read and write failures never acknowledge an unverified observation", async () => {
  for (const operation of ["read", "put", "readback"] as const) {
    const f = syncDeadLetterKv();
    const acks: string[] = [];
    if (operation === "put")
      f.hooks.beforePut = () => {
        throw new Error("store unavailable");
      };
    else
      f.hooks.read = (key, call) => {
        if (operation === "read" || call === 2)
          throw new Error("store unavailable");
        return f.values.get(key) ?? null;
      };
    await assert.rejects(
      handleDeadLetterBatch(
        { queue, messages: [{ ...message({}), ack: () => acks.push("ack") }] },
        undefined,
        1,
        f.kv,
      ),
      /store unavailable/,
    );
    assert.deepEqual(acks, [], operation);
    assert.equal(f.values.size, operation === "readback" ? 1 : 0);
  }
});

test("a failed message and the remainder of a partial batch stay unacknowledged", async () => {
  const f = syncDeadLetterKv();
  const acks: string[] = [];
  const messages = ["a", "b", "c"].map((id) => ({
    ...message({ lane: "neurons" }, id),
    ack: () => acks.push(id),
  }));
  f.hooks.beforePut = (_key, _value, call) => {
    if (call === 2) throw new Error("store unavailable");
  };
  await assert.rejects(
    handleDeadLetterBatch({ queue, messages }, undefined, 1, f.kv),
    /store unavailable/,
  );
  assert.deepEqual(acks, ["a"]);
  assert.deepEqual(envelopes(f).map((entry) => entry.message_id), ["a"]);
  delete f.hooks.beforePut;
  await handleDeadLetterBatch(
    { queue, messages: messages.slice(1).map((m) => ({ ...m, attempts: 2 })) },
    undefined,
    2,
    f.kv,
  );
  assert.deepEqual(acks, ["a", "b", "c"]);
  assert.deepEqual(envelopes(f).map((entry) => entry.attempts), [1, 2, 2]);
});

test("a lost write response or acknowledgment leaves recoverable observations on retry", async () => {
  for (const failure of ["write-response", "ack"] as const) {
    const f = syncDeadLetterKv();
    let fail = true;
    let acks = 0;
    if (failure === "write-response")
      f.hooks.afterPut = () => {
        if (fail) throw new Error("response lost");
      };
    const m = {
      ...message({ lane: "neurons" }),
      ack() {
        if (fail && failure === "ack") throw new Error("ack lost");
        acks++;
      },
    };
    await assert.rejects(
      handleDeadLetterBatch({ queue, messages: [m] }, undefined, 1, f.kv),
      /lost/,
    );
    assert.equal(acks, 0);
    assert.equal(f.values.size, 1);
    fail = false;
    await handleDeadLetterBatch({ queue, messages: [m] }, undefined, 2, f.kv);
    assert.equal(acks, 1);
    assert.equal(
      f.puts.length,
      1,
      "an exact redelivery reuses the verified value",
    );
    await handleDeadLetterBatch(
      { queue, messages: [{ ...m, attempts: 2 }] },
      undefined,
      3,
      f.kv,
    );
    assert.equal(
      f.values.size,
      2,
      "a later attempt remains a separate observation",
    );
  }
});

test("missing or stale readback never establishes preservation", async () => {
  for (const stale of [null, "stale bytes"]) {
    const f = syncDeadLetterKv();
    f.hooks.read = () => stale;
    await assert.rejects(preserveSyncDeadLetter(f.kv, queue, message({})));
    assert.equal(f.puts.length, stale === null ? 1 : 0);
  }
});

test("stored envelopes are streamed within a fixed budget and release their readers", async () => {
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
  f.hooks.afterPut = (key) => {
    assert.ok(f.values.has(key));
    f.hooks.stream = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("stream failed"));
        },
      });
  };
  let acked = false;
  await assert.rejects(
    handleDeadLetterBatch(
      {
        queue,
        messages: [
          {
            ...message({}),
            ack: () => {
              acked = true;
            },
          },
        ],
      },
      undefined,
      1,
      f.kv,
    ),
    /stream failed/,
  );
  assert.equal(acked, false);
  assert.equal(f.values.size, 1);
  assert.deepEqual(f.streams, [{ reads: 1, cancels: 1, releases: 1 }]);
});

test("matching claimed hashes cannot hide corrupted envelopes or payload bytes", async () => {
  const good = syncDeadLetterKv();
  const m = message({ value: "original" });
  await preserveSyncDeadLetter(good.kv, queue, m);
  const [key, serialized] = [...good.values.entries()][0]!;
  const envelope = JSON.parse(serialized) as Envelope;
  for (const changed of [
    { ...envelope, payload: Buffer.from("different").toString("base64") },
    { ...envelope, body_sha256: "0".repeat(64) },
    { ...envelope, body_bytes: envelope.body_bytes + 1 },
    { ...envelope, representation: "bytes" },
    { ...envelope, queue: "other-queue" },
    { ...envelope, message_id: "other-id" },
    { ...envelope, published_at: publishedAt + 1 },
    { ...envelope, attempts: 2 },
    { ...envelope, version: 2 },
  ]) {
    const f = syncDeadLetterKv();
    const corrupted = JSON.stringify(changed);
    f.values.set(key, corrupted);
    await assert.rejects(preserveSyncDeadLetter(f.kv, queue, m));
    assert.equal(
      f.puts.length,
      0,
      "a mismatched value must never be overwritten",
    );
    assert.equal(f.values.get(key), corrupted);
  }
  const f = syncDeadLetterKv();
  f.values.set(key, `${serialized}\n`);
  await assert.rejects(preserveSyncDeadLetter(f.kv, queue, m));
  assert.equal(
    f.puts.length,
    0,
    "verification compares the exact stored bytes",
  );
});

test("corruption after a successful put still prevents acknowledgment", async () => {
  const f = syncDeadLetterKv();
  f.hooks.afterPut = (key, value) => {
    const envelope = JSON.parse(value) as Envelope;
    f.values.set(key, JSON.stringify({ ...envelope, payload: "AA==" }));
  };
  let acked = false;
  await assert.rejects(
    handleDeadLetterBatch(
      {
        queue,
        messages: [
          {
            ...message({}),
            ack: () => {
              acked = true;
            },
          },
        ],
      },
      undefined,
      1,
      f.kv,
    ),
  );
  assert.equal(acked, false);
});

test("invalid identity, publishing time and attempt metadata stay unacknowledged", async () => {
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
    await assert.rejects(
      handleDeadLetterBatch(
        {
          queue,
          messages: [
            {
              ...invalid,
              ack: () => {
                acked = true;
              },
            },
          ],
        },
        undefined,
        1,
        f.kv,
      ),
    );
    assert.equal(acked, false);
  }
  await assert.rejects(preserveSyncDeadLetter(undefined, queue, valid));
  await assert.rejects(preserveSyncDeadLetter(f.kv, "sync-batches", valid));
  assert.equal(f.gets.length, 0);
  assert.equal(f.puts.length, 0);
  await preserveSyncDeadLetter(f.kv, queue, {
    ...valid,
    id: "a".repeat(256),
    timestamp: new Date(0),
    attempts: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(envelopes(f)[0]!.published_at, 0);
});

test("unsupported JSON values cannot be silently dropped or coerced", async () => {
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
});

test("supported JSON primitives and nested values retain their UTF-8 serialization", async () => {
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

test("body limits count bytes and the maximum observation stays bounded", async () => {
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
  assert.ok(Buffer.byteLength(put.value) <= 192 * 1024);
  assert.match(put.key, /^sync-quarantine:v1:[a-f0-9]{64}$/);
});

test("failed preservation, partial retry and duplicate delivery keep the existing incident open", async () => {
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
  const messages = ["a", "b"].map((id) => ({
    ...message({ lane: "hotkey-alpha", rows: [] }, id),
    ack: () => acks.push(id),
  }));
  const now = publishedAt + 10_000;
  f.hooks.beforePut = (_key, _value, call) => {
    if (call === 2) throw new Error("store unavailable");
  };
  await assert.rejects(
    handleDeadLetterBatch({ queue, messages }, health, now - 2000, f.kv),
    /store unavailable/,
  );
  assert.equal(observed.length, 1, "failure still records a stale observation");
  assert.deepEqual(acks, ["a"]);
  assert.equal(f.values.size, 1);
  delete f.hooks.beforePut;
  await handleDeadLetterBatch(
    { queue, messages: [messages[1]!] },
    health,
    now - 1000,
    f.kv,
  );
  await handleDeadLetterBatch({ queue, messages }, health, now, f.kv);
  assert.deepEqual(acks, ["a", "b", "a", "b"]);
  assert.equal(observed.length, 3);
  assert.equal(
    f.values.size,
    2,
    "duplicate observations are not unique messages",
  );
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
