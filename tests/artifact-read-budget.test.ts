import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactReadBudget,
  ArtifactReadTimeoutError,
} from "../src/artifact-read-budget.ts";
import { archiveObjectStore } from "../src/archive-object-store.ts";
import { RetainedHistoryUnavailableError } from "../src/retained-history-store.ts";

const budgets: ArtifactReadBudget[] = [];
beforeEach(() => vi.useFakeTimers({ now: 1_000 }));
afterEach(() => {
  for (const budget of budgets.splice(0)) budget.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function budget() {
  const value = new ArtifactReadBudget(20);
  budgets.push(value);
  return value;
}

describe("shared artifact read budget", () => {
  it("reuses one timer and removes each successful operation's listener", async () => {
    const value = budget();
    const add = vi.spyOn(value.signal, "addEventListener");
    const remove = vi.spyOn(value.signal, "removeEventListener");
    expect(await value.run(() => 7)).toBe(7);
    expect(await value.run(async () => 8)).toBe(8);
    expect(vi.getTimerCount()).toBe(1);
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(2);
    for (const call of add.mock.calls)
      expect(remove).toHaveBeenCalledWith("abort", call[1]);
    value.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves timely errors and removes their listeners", async () => {
    const value = budget();
    const add = vi.spyOn(value.signal, "addEventListener");
    const remove = vi.spyOn(value.signal, "removeEventListener");
    const error = new Error("storage rejected");
    await expect(
      value.run(() => {
        throw error;
      }),
    ).rejects.toBe(error);
    await expect(value.run(() => Promise.reject(error))).rejects.toBe(error);
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(value.signal.aborted).toBe(false);
    value.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("manual close prevents an already queued callback from starting", async () => {
    const value = budget();
    const operation = vi.fn(() => 1);
    const pending = value.run(operation);
    value.close();
    await expect(pending).rejects.toBeInstanceOf(ArtifactReadTimeoutError);
    expect(operation).not.toHaveBeenCalled();
    expect(value.signal.aborted).toBe(true);
    expect(() => value.check()).toThrow(ArtifactReadTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks elapsed time before starting without waiting for the timer", async () => {
    const value = budget();
    const operation = vi.fn(() => 1);
    const pending = value.run(operation);
    vi.setSystemTime(1_020);
    await expect(pending).rejects.toBeInstanceOf(ArtifactReadTimeoutError);
    expect(operation).not.toHaveBeenCalled();
    expect(value.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "checks elapsed time after a callback settles (reject=%s)",
    async (reject) => {
      const value = budget();
      const pending = value.run(() => {
        vi.setSystemTime(1_021);
        if (reject) throw new Error("late rejection");
        return "late value";
      });
      await expect(pending).rejects.toBeInstanceOf(ArtifactReadTimeoutError);
      expect(value.signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("aborts a callback that never settles and cleans its listener", async () => {
    const value = budget();
    const add = vi.spyOn(value.signal, "addEventListener");
    const remove = vi.spyOn(value.signal, "removeEventListener");
    const operation = vi.fn(() => new Promise<never>(() => {}));
    const rejected = expect(value.run(operation)).rejects.toBeInstanceOf(
      ArtifactReadTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(operation).toHaveBeenCalledOnce();
    expect(value.signal.aborted).toBe(true);
    expect(value.signal.reason).toBeInstanceOf(RetainedHistoryUnavailableError);
    expect(value.signal.reason.code).toBe("history_unavailable");
    expect(value.signal.reason.message).toContain("configured time budget");
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const KEY = "metagraph/projections/example.json";
function legacyFixture(response: Response) {
  const metadata = {
    key: KEY,
    version: "legacy-version",
    size: 11,
    etag: "legacy-etag",
    httpEtag: '"legacy-etag"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date("2026-10-17T00:00:00Z"),
    httpMetadata: { contentType: "application/json" },
    customMetadata: { source: "legacy" },
    range: { offset: 0, length: 11 },
    storageClass: "Standard",
    ssecKeyMd5: "legacy-key-hash",
  };
  const prototype = {};
  for (const [name, value] of Object.entries(metadata))
    Object.defineProperty(prototype, name, { get: () => value });
  Object.defineProperties(prototype, {
    body: { get: () => response.body! },
    bodyUsed: { get: () => response.bodyUsed },
    arrayBuffer: { value: () => response.arrayBuffer() },
    bytes: { value: () => response.bytes() },
    text: { value: () => response.text() },
    json: { value: <T>() => response.json<T>() },
    blob: { value: () => response.blob() },
    writeHttpMetadata: {
      value(this: R2Object, headers: Headers) {
        headers.set("x-legacy-key", this.key);
      },
    },
  });
  const object = Object.create(prototype) as R2ObjectBody;
  const get = vi.fn(async (_key: string, _options?: R2GetOptions) => object);
  const all = vi.fn(async () => ({ success: true, results: [] }));
  const prepare = vi.fn(() => ({ bind: () => ({ all }) }));
  const store = archiveObjectStore({
    ARCHIVE_OBJECT_STORAGE: "native-read-legacy",
    D1_STATE: { prepare } as unknown as D1Database,
    METAGRAPH_ARCHIVE: { get, head: async () => null },
  });
  return { metadata, object, get, all, store };
}

describe("native archive's budget-aware read port", () => {
  it("preserves prototype metadata and live body getters in legacy fallback", async () => {
    const fixture = legacyFixture(new Response('{"ok":true}'));
    expect(Object.keys(fixture.object)).toEqual([]);
    const value = await fixture.store.getWithBudget(KEY, budget());
    expect(value).not.toBeNull();
    for (const [name, expected] of Object.entries(fixture.metadata))
      expect(value?.[name as keyof R2Object]).toEqual(expected);
    expect(fixture.get).toHaveBeenCalledWith(KEY, undefined);
    const headers = new Headers();
    value!.writeHttpMetadata(headers);
    expect(headers.get("x-legacy-key")).toBe(KEY);
    expect(value!.bodyUsed).toBe(false);
    expect(await value!.json()).toEqual({ ok: true });
    expect(value!.bodyUsed).toBe(true);
    expect(fixture.object.bodyUsed).toBe(true);
  });

  it("cancels and unlocks a prefetched legacy reader even if cancel hangs", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
      },
      cancel,
    });
    const fixture = legacyFixture(new Response(source));
    const deadline = budget();
    const value = await fixture.store.getWithBudget(KEY, deadline);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.locked).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
    await expect(value!.json()).rejects.toBeInstanceOf(ArtifactReadTimeoutError);
    expect(fixture.get).toHaveBeenCalledOnce();
    expect(fixture.all).toHaveBeenCalledOnce();
    await value!.body.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});
