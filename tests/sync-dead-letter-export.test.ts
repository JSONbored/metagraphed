import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleD1StateExport } from "../src/d1-state-export.ts";
import { handleSyncDeadLetterExport } from "../src/sync-dead-letter-export.ts";
import { handleRequest } from "../workers/api.ts";

const prefix = "sync-quarantine:v1:";
const secret = "existing-export-test-secret";
const raw = new Uint8Array([0, 255, 128, 13, 10, 34, 1]);
function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
const listing = { kind: "dead-letter", operation: "list" };
const reading = {
  kind: "dead-letter",
  operation: "read",
  sha256: sha(raw),
  bytes: raw.length,
};
const readKey = prefix + reading.sha256;
const custodySha256 = "b".repeat(64);
const observation = new TextEncoder().encode(
  JSON.stringify({
    version: 2,
    kind: "observation",
    custody_sha256: custodySha256,
    attempts: 7,
  }),
);
const observationReading = {
  ...reading,
  sha256: sha(observation),
  bytes: observation.length,
  custody_sha256: custodySha256,
  attempts: 7,
};
const observationKey =
  prefix + custodySha256 + ":0000000000000007:" + observationReading.sha256;

function storedStream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from(bytes));
      controller.close();
    },
  });
}

function fixture(bytes = raw) {
  async function getValue(_key: string, _as: unknown): Promise<unknown> {
    return storedStream(bytes);
  }
  const page = { keys: [], list_complete: true };
  const get = vi.fn(getValue);
  const list = vi.fn(async (_options: unknown): Promise<unknown> => page);
  const kv = { get, list } as unknown as Pick<KVNamespace, "get" | "list">;
  return {
    get,
    list,
    env: { STATE_EXPORT_SECRET: secret, METAGRAPH_CONTROL: kv },
  };
}

const request = (input: unknown, token = secret, method = "POST") =>
  new Request("https://example.com/api/v1/internal/state-export", {
    method,
    headers: { "x-state-export-token": token },
    ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });

async function unavailable(response: Response) {
  expect(response.status).toBe(502);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: "quarantine content is unavailable or changed",
  });
}

describe("private quarantine export authorization", () => {
  it("checks the existing credential and POST before dispatch", async () => {
    const f = fixture();
    const denied = [
      await handleD1StateExport(request(reading, "wrong"), f.env),
      await handleD1StateExport(request(listing, ""), f.env),
      await handleD1StateExport(request(reading), {
        ...f.env,
        STATE_EXPORT_SECRET: undefined,
      }),
      await handleD1StateExport(request(listing, secret, "GET"), f.env),
    ];
    const statuses = denied.map((response) => response.status);
    expect(statuses).toEqual([401, 401, 503, 405]);
    for (const response of denied)
      expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.get).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    const accepted = await handleD1StateExport(request(listing), f.env);
    expect(accepted.status).toBe(200);
    expect(f.list).toHaveBeenCalledExactlyOnceWith({ prefix, limit: 100 });
  });

  it("rejects malformed and oversized JSON before any KV call", async () => {
    const f = fixture();
    for (const body of [
      "{",
      JSON.stringify({ ...listing, padding: "x".repeat(8192) }),
    ]) {
      const response = await handleD1StateExport(
        new Request("https://example.com/api/v1/internal/state-export", {
          method: "POST",
          headers: { "x-state-export-token": secret },
          body,
        }),
        f.env,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(f.get).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });

  it("authenticates before validating composite fields", async () => {
    const f = fixture();
    const incomplete = { ...reading, custody_sha256: custodySha256 };
    for (const input of [observationReading, incomplete]) {
      const response = await handleD1StateExport(request(input, "wrong"), f.env);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const authorized = await handleD1StateExport(request(incomplete), f.env);
    expect(authorized.status).toBe(400);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });

  it("preserves bytes and private headers through the proxy", async () => {
    const f = fixture();
    const env = {
      DATA_API: {
        fetch: (incoming: Request) => handleD1StateExport(incoming, f.env),
      },
    } as unknown as Env;
    const denied = await handleRequest(request(reading, "wrong"), env, {});
    expect(denied.status).toBe(401);
    expect(f.get).not.toHaveBeenCalled();
    const response = await handleRequest(request(reading), env, {});
    const headers = response.headers;
    expect(response.status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("content-length")).toBe(String(raw.length));
    expect(headers.get("x-content-sha256")).toBe(reading.sha256);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(raw);
    expect(f.get).toHaveBeenCalledExactlyOnceWith(readKey, "stream");
    expect(f.list).not.toHaveBeenCalled();
  });

  it("preserves observation bytes through the proxy", async () => {
    const f = fixture(observation);
    const env = {
      DATA_API: {
        fetch: (incoming: Request) => handleD1StateExport(incoming, f.env),
      },
    } as unknown as Env;
    const response = await handleRequest(request(observationReading), env, {});
    const headers = response.headers;
    expect(response.status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("content-length")).toBe(String(observation.length));
    expect(headers.get("x-content-sha256")).toBe(observationReading.sha256);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(observation);
    expect(f.get).toHaveBeenCalledExactlyOnceWith(observationKey, "stream");
    expect(f.list).not.toHaveBeenCalled();
  });
});

describe("bounded quarantine requests", () => {
  it.each([
    null,
    [],
    {},
    { ...listing, kind: "other" },
    { ...listing, operation: "delete" },
    { ...listing, key: "health:current" },
    { ...listing, cursor: "" },
    { ...listing, cursor: "x".repeat(2049) },
    { ...listing, cursor: 1 },
    { ...listing, cursor: null },
    { ...reading, sha256: "a".repeat(63) },
    { ...reading, sha256: "a".repeat(65) },
    { ...reading, sha256: "A".repeat(64) },
    { ...reading, sha256: "a".repeat(64) + "\n" },
    { ...reading, sha256: "../health:current" },
    { ...reading, bytes: 0 },
    { ...reading, bytes: -1 },
    { ...reading, bytes: 1.5 },
    { ...reading, bytes: "7" },
    { ...reading, bytes: null },
    { ...reading, bytes: false },
    { ...reading, bytes: 192 * 1024 + 1 },
    { ...reading, cursor: "cursor" },
    { ...reading, key: "health:current" },
    { ...reading, custody_sha256: custodySha256 },
    { ...reading, attempts: 7 },
    { ...observationReading, custody_sha256: null },
    { ...observationReading, custody_sha256: 1 },
    { ...observationReading, custody_sha256: "b".repeat(63) },
    { ...observationReading, custody_sha256: "b".repeat(65) },
    { ...observationReading, custody_sha256: "B".repeat(64) },
    { ...observationReading, custody_sha256: "g".repeat(64) },
    { ...observationReading, custody_sha256: "b".repeat(64) + "\n" },
    { ...observationReading, custody_sha256: "../health:current" },
    { ...observationReading, attempts: null },
    { ...observationReading, attempts: "7" },
    { ...observationReading, attempts: false },
    { ...observationReading, attempts: 0 },
    { ...observationReading, attempts: -1 },
    { ...observationReading, attempts: 1.5 },
    { ...observationReading, attempts: Number.MAX_SAFE_INTEGER + 1 },
    { ...observationReading, attempts: Infinity },
    { ...observationReading, attempts: NaN },
    { ...listing, custody_sha256: custodySha256, attempts: 7 },
  ])("rejects invalid requests before KV: %j", async (input) => {
    const f = fixture();
    const response = await handleSyncDeadLetterExport(input, f.env);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.get).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each([listing, reading, observationReading])(
    "requires a store: %j",
    async (input) => {
      const response = await handleSyncDeadLetterExport(input, {});
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: "quarantine export is not provisioned",
      });
    },
  );
});

describe("quarantine prefix listing", () => {
  it("lists only digests and forwards opaque cursors", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce({
      keys: [{ name: prefix + reading.sha256, metadata: { body: "private" } }],
      list_complete: false,
      cursor: "next:page/opaque==",
    });
    const first = await handleSyncDeadLetterExport(listing, f.env);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({
      version: 1,
      envelopes: [{ sha256: reading.sha256 }],
      list_complete: false,
      cursor: "next:page/opaque==",
    });
    f.list.mockResolvedValueOnce({
      keys: [],
      list_complete: true,
      cursor: "provider-complete-cursor-must-not-leak",
    });
    const second = await handleSyncDeadLetterExport(
      { ...listing, cursor: "next:page/opaque==" },
      f.env,
    );
    expect(await second.json()).toEqual({
      version: 1,
      envelopes: [],
      list_complete: true,
    });
    expect(f.list.mock.calls).toEqual([
      [{ prefix, limit: 100 }],
      [{ prefix, limit: 100, cursor: "next:page/opaque==" }],
    ]);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("traverses mixed pages and strips provider metadata", async () => {
    const f = fixture();
    const lastSha256 = "c".repeat(64);
    f.list.mockResolvedValueOnce({
      keys: [
        { name: readKey, metadata: { payload: "private-custody" } },
        { name: observationKey, metadata: { payload: "private-observation" } },
      ],
      list_complete: false,
      cursor: "mixed:page/opaque==",
    });
    const first = await handleSyncDeadLetterExport(listing, f.env);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      version: 1,
      envelopes: [
        { sha256: reading.sha256 },
        {
          sha256: observationReading.sha256,
          custody_sha256: custodySha256,
          attempts: 7,
        },
      ],
      list_complete: false,
      cursor: "mixed:page/opaque==",
    });
    f.list.mockResolvedValueOnce({
      keys: [
        {
          name: prefix + custodySha256 + ":9007199254740991:" + lastSha256,
          metadata: { payload: "private-last-observation" },
        },
      ],
      list_complete: true,
      cursor: "complete-cursor-must-not-leak",
    });
    const second = await handleSyncDeadLetterExport(
      { ...listing, cursor: "mixed:page/opaque==" },
      f.env,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      version: 1,
      envelopes: [
        {
          sha256: lastSha256,
          custody_sha256: custodySha256,
          attempts: Number.MAX_SAFE_INTEGER,
        },
      ],
      list_complete: true,
    });
    expect(f.list.mock.calls).toEqual([
      [{ prefix, limit: 100 }],
      [{ prefix, limit: 100, cursor: "mixed:page/opaque==" }],
    ]);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("accepts the bounded maximum cursor and a full 100-key page", async () => {
    const f = fixture();
    const envelopes = Array.from({ length: 100 }, (_, i) => ({
      sha256: i.toString(16).padStart(64, "0"),
    }));
    f.list.mockResolvedValueOnce({
      keys: envelopes.map(({ sha256 }) => ({ name: prefix + sha256 })),
      list_complete: false,
      cursor: "n".repeat(2048),
    });
    const response = await handleSyncDeadLetterExport(
      { ...listing, cursor: "p".repeat(2048) },
      f.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      envelopes,
      list_complete: false,
      cursor: "n".repeat(2048),
    });
    expect(f.list).toHaveBeenCalledExactlyOnceWith({
      prefix,
      limit: 100,
      cursor: "p".repeat(2048),
    });
  });

  it.each([
    null,
    {},
    { keys: null, list_complete: true },
    { keys: [], list_complete: "true" },
    { keys: [], cursor: "valid-but-no-completion-flag" },
    { keys: [], list_complete: false },
    { keys: [], list_complete: false, cursor: "" },
    { keys: [], list_complete: false, cursor: 1 },
    { keys: [], list_complete: false, cursor: "x".repeat(2049) },
    { keys: [{ name: "health:current" }], list_complete: true },
    { keys: [{ name: prefix + "a".repeat(63) }], list_complete: true },
    { keys: [{ name: prefix + "A".repeat(64) }], list_complete: true },
    { keys: [{ name: prefix + "a".repeat(64) + "\n" }], list_complete: true },
    { keys: [{ name: null }], list_complete: true },
    {
      keys: Array.from({ length: 101 }, () => ({
        name: prefix + reading.sha256,
      })),
      list_complete: true,
    },
  ])("rejects malformed provider pages: %j", async (page) => {
    const f = fixture();
    f.list.mockResolvedValueOnce(page);
    await unavailable(await handleSyncDeadLetterExport(listing, f.env));
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each([
    custodySha256 + ":" + observationReading.sha256,
    custodySha256 + ":0000000000000007:extra:" + observationReading.sha256,
    "b".repeat(63) + ":0000000000000007:" + observationReading.sha256,
    "b".repeat(65) + ":0000000000000007:" + observationReading.sha256,
    "B".repeat(64) + ":0000000000000007:" + observationReading.sha256,
    "g".repeat(64) + ":0000000000000007:" + observationReading.sha256,
    custodySha256 + ":0000000000000000:" + observationReading.sha256,
    custodySha256 + ":9007199254740992:" + observationReading.sha256,
    custodySha256 + ":00000000000000x1:" + observationReading.sha256,
    custodySha256 + ":-000000000000001:" + observationReading.sha256,
    custodySha256 + ":7:" + observationReading.sha256,
    custodySha256 + ":000000000000007:" + observationReading.sha256,
    custodySha256 + ":00000000000000007:" + observationReading.sha256,
    custodySha256 + ":0000000000007e00:" + observationReading.sha256,
    custodySha256 + ":0000000000000007:" + "a".repeat(63),
    custodySha256 + ":0000000000000007:" + "A".repeat(64),
    custodySha256 + ":0000000000000007:" + observationReading.sha256 + "\n",
  ])("rejects malformed composite keys: %s", async (suffix) => {
    const f = fixture();
    f.list.mockResolvedValueOnce({
      keys: [{ name: readKey }, { name: prefix + suffix }],
      list_complete: true,
    });
    await unavailable(await handleSyncDeadLetterExport(listing, f.env));
    expect(f.list).toHaveBeenCalledExactlyOnceWith({ prefix, limit: 100 });
    expect(f.get).not.toHaveBeenCalled();
  });

  it("sanitizes provider listing failures", async () => {
    const f = fixture();
    f.list.mockRejectedValueOnce(new Error("provider-private-payload"));
    await unavailable(await handleSyncDeadLetterExport(listing, f.env));
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.get).not.toHaveBeenCalled();
  });
});

describe("exact quarantine envelope reads", () => {
  it.each([
    { attempts: 1, padded: "0000000000000001" },
    { attempts: 7, padded: "0000000000000007" },
    { attempts: Number.MAX_SAFE_INTEGER, padded: "9007199254740991" },
  ])(
    "reads attempt $attempts at its fixed key",
    async ({ attempts, padded }) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          version: 2,
          kind: "observation",
          custody_sha256: custodySha256,
          attempts,
        }),
      );
      const f = fixture(bytes);
      const input = {
        ...observationReading,
        sha256: sha(bytes),
        attempts,
        bytes: undefined,
      };
      const response = await handleSyncDeadLetterExport(input, f.env);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get("x-content-sha256")).toBe(input.sha256);
      expect(f.get).toHaveBeenCalledExactlyOnceWith(
        prefix + custodySha256 + ":" + padded + ":" + input.sha256,
        "stream",
      );
      expect(f.list).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "missing", value: () => null },
    {
      name: "same-size corruption",
      value: () => storedStream(new Uint8Array(observation.length).fill(7)),
    },
    {
      name: "over budget",
      value: () => storedStream(new Uint8Array(192 * 1024 + 1)),
    },
  ])("rejects $name composite content", async ({ value }) => {
    const f = fixture();
    f.get.mockResolvedValueOnce(value());
    await unavailable(
      await handleSyncDeadLetterExport(observationReading, f.env),
    );
    expect(f.get).toHaveBeenCalledExactlyOnceWith(observationKey, "stream");
    expect(f.list).not.toHaveBeenCalled();
  });

  it("checks a composite receipt's supplied size", async () => {
    const f = fixture(observation);
    await unavailable(
      await handleSyncDeadLetterExport(
        { ...observationReading, bytes: observation.length + 1 },
        f.env,
      ),
    );
    expect(f.get).toHaveBeenCalledExactlyOnceWith(observationKey, "stream");
    expect(f.list).not.toHaveBeenCalled();
  });

  it("reads a digest without a caller-supplied size", async () => {
    const f = fixture();
    const response = await handleSyncDeadLetterExport(
      { kind: "dead-letter", operation: "read", sha256: reading.sha256 },
      f.env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(raw.length));
    expect(response.headers.get("x-content-sha256")).toBe(reading.sha256);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(raw);
    expect(f.get).toHaveBeenCalledExactlyOnceWith(readKey, "stream");
  });

  it.each([1, 192 * 1024])("reads %i verified bytes", async (length) => {
    const bytes = new Uint8Array(length).fill(233);
    const f = fixture(bytes);
    const input = { ...reading, sha256: sha(bytes), bytes: length };
    const inputKey = prefix + input.sha256;
    const response = await handleSyncDeadLetterExport(input, f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-length")).toBe(String(length));
    expect(response.headers.get("x-content-sha256")).toBe(input.sha256);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(f.get).toHaveBeenCalledExactlyOnceWith(inputKey, "stream");
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing", value: () => null },
    { name: "undefined", value: () => undefined },
    { name: "empty", value: () => storedStream(new Uint8Array(0)) },
    { name: "truncated", value: () => storedStream(raw.slice(0, -1)) },
    {
      name: "too long",
      value: () => storedStream(new Uint8Array(raw.length + 1)),
    },
    {
      name: "over budget",
      value: () => storedStream(new Uint8Array(192 * 1024 + 1)),
    },
    {
      name: "same-size corruption",
      value: () => storedStream(new Uint8Array(raw.length).fill(7)),
    },
    { name: "invalid provider type", value: () => "provider-private-payload" },
  ])("rejects $name content without retry", async ({ value }) => {
    const f = fixture();
    f.get.mockResolvedValueOnce(value());
    await unavailable(await handleSyncDeadLetterExport(reading, f.env));
    expect(f.get).toHaveBeenCalledExactlyOnceWith(readKey, "stream");
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each([0, 192 * 1024 + 1])(
    "rejects an actual size of %i without a caller-supplied size",
    async (length) => {
      const bytes = new Uint8Array(length);
      const f = fixture(bytes);
      const input = {
        kind: "dead-letter",
        operation: "read",
        sha256: sha(bytes),
      };
      const response = await handleSyncDeadLetterExport(input, f.env);
      await unavailable(response);
      expect(f.get).toHaveBeenCalledTimes(1);
      expect(f.list).not.toHaveBeenCalled();
    },
  );

  it("checks supplied size even with the correct digest", async () => {
    const f = fixture();
    const input = { ...reading, bytes: raw.length + 1 };
    const response = await handleSyncDeadLetterExport(input, f.env);
    await unavailable(response);
    expect(f.get).toHaveBeenCalledTimes(1);
  });

  it("cancels at the byte ceiling without reading further chunks", async () => {
    const f = fixture();
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(pulls <= 2 ? 96 * 1024 : 1));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    f.get.mockResolvedValueOnce(stream);
    const input = {
      kind: "dead-letter",
      operation: "read",
      sha256: reading.sha256,
    };
    const response = await handleSyncDeadLetterExport(input, f.env);
    await unavailable(response);
    expect(pulls).toBe(3);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(f.get).toHaveBeenCalledExactlyOnceWith(readKey, "stream");
  });

  it("releases an errored stream and sanitizes its private error", async () => {
    const f = fixture();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("provider-private-payload"));
      },
    });
    f.get.mockResolvedValueOnce(stream);
    await unavailable(await handleSyncDeadLetterExport(reading, f.env));
    expect(stream.locked).toBe(false);
    expect(f.get).toHaveBeenCalledTimes(1);
  });

  it("releases the reader when stream cancellation fails", async () => {
    const f = fixture();
    const cancel = vi.fn(async () => {
      throw new Error("provider-private-payload");
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(192 * 1024 + 1));
      },
      cancel,
    });
    f.get.mockResolvedValueOnce(stream);
    await unavailable(await handleSyncDeadLetterExport(reading, f.env));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it("sanitizes read failures without retry or a fallback", async () => {
    const f = fixture();
    f.get.mockRejectedValueOnce(new Error("provider-private-payload"));
    await unavailable(await handleSyncDeadLetterExport(reading, f.env));
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.list).not.toHaveBeenCalled();
  });
});
