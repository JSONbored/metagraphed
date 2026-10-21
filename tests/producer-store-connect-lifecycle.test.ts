import { describe, expect, it, vi } from "vitest";
import { createProducerStore } from "../src/producer-store.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fake() {
  return {
    connect: vi.fn(async () => {}),
    query: vi.fn(async (_text: string, _values?: unknown[]) => ({
      rows: [{ value: 1 }],
      rowCount: 1,
    })),
    end: vi.fn(async () => {}),
  };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("producer-store connection readiness", () => {
  it("does not construct or connect an unused store", async () => {
    const clientFactory = vi.fn(() => fake());
    await createProducerStore("fixture", { clientFactory }).close();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("awaits one shared connect before any concurrent operation can query", async () => {
    const client = fake();
    const connecting = deferred();
    client.connect.mockImplementation(() => connecting.promise);
    const store = createProducerStore("fixture", {
      clientFactory: () => client,
    });
    const first = store.query("SELECT ?", [1]);
    const second = store.first("SELECT ?", [2]);
    await flush();
    expect(client.query).not.toHaveBeenCalled();
    connecting.resolve();
    await expect(first).resolves.toEqual([{ value: 1 }]);
    await expect(second).resolves.toEqual({ value: 1 });
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT $1",
      "SELECT $1",
    ]);
    await store.close();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("rejects all concurrent operations with the same failed-connect error", async () => {
    const client = fake();
    const connecting = deferred();
    const failure = new Error("connect failed");
    client.connect.mockImplementation(() => connecting.promise);
    const store = createProducerStore("fixture", {
      clientFactory: () => client,
    });
    const pending = Promise.allSettled([
      store.query("SELECT 1"),
      store.run("UPDATE fixture"),
    ]);
    connecting.reject(failure);
    expect(await pending).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(client.query).not.toHaveBeenCalled();
    await store.close();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it.each(["query", "first", "run", "transaction"] as const)(
    "keeps a rejected handshake for later %s until owner close",
    async (method) => {
      const client = fake();
      const failure = new Error("connect failed");
      client.connect.mockRejectedValue(failure);
      const store = createProducerStore("fixture", {
        clientFactory: () => client,
      });
      await expect(store.query("SELECT 1")).rejects.toBe(failure);
      const retry =
        method === "transaction"
          ? store.transaction([{ text: "UPDATE fixture" }])
          : store[method]("SELECT 2");
      await expect(retry).rejects.toBe(failure);
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(client.query).not.toHaveBeenCalled();
      expect(client.end).not.toHaveBeenCalled();
      await store.close();
      expect(client.end).toHaveBeenCalledTimes(1);
    },
  );

  it("also shares a synchronous connection failure", async () => {
    const client = fake();
    const failure = new Error("synchronous connect failure");
    client.connect.mockImplementation(() => {
      throw failure;
    });
    const store = createProducerStore("fixture", {
      clientFactory: () => client,
    });
    await expect(store.query("SELECT 1")).rejects.toBe(failure);
    await expect(store.query("SELECT 2")).rejects.toBe(failure);
    expect(client.query).not.toHaveBeenCalled();
    await store.close();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("clears rejected readiness on close so a later owner operation can reconnect", async () => {
    const failed = fake();
    const fresh = fake();
    const failure = new Error("connect failed");
    failed.connect.mockRejectedValue(failure);
    const clientFactory = vi
      .fn()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(fresh);
    const store = createProducerStore("fixture", { clientFactory });
    await expect(store.query("SELECT 1")).rejects.toBe(failure);
    await store.close();
    await expect(store.query("SELECT 2")).resolves.toEqual([{ value: 1 }]);
    await store.close();
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(failed.end).toHaveBeenCalledTimes(1);
    expect(fresh.connect).toHaveBeenCalledTimes(1);
    expect(fresh.end).toHaveBeenCalledTimes(1);
  });

  it("still awaits teardown and tolerates async end rejection", async () => {
    const client = fake();
    const ending = deferred();
    client.end.mockImplementation(() => ending.promise);
    const store = createProducerStore("fixture", {
      clientFactory: () => client,
    });
    await store.run("UPDATE fixture");
    let settled = false;
    const close = store.close().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    await store.close();
    expect(client.end).toHaveBeenCalledTimes(1);
    ending.reject(new Error("teardown failed"));
    await close;
  });

  it("keeps successful transaction order and result counts", async () => {
    const client = fake();
    const store = createProducerStore("fixture", {
      clientFactory: () => client,
    });
    await expect(
      store.transaction([
        { text: "UPDATE fixture SET value = ?", values: [1] },
      ]),
    ).resolves.toEqual([{ changes: 1 }]);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "UPDATE fixture SET value = $1",
      "COMMIT",
    ]);
    await store.close();
  });

  it("keeps the original transaction error when rollback rejects", async () => {
    const client = fake();
    const failure = new Error("write failed");
    client.query.mockImplementation(async (sql) => {
      if (sql.startsWith("UPDATE")) throw failure;
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [], rowCount: 0 };
    });
    const store = createProducerStore("fixture", {
      clientFactory: () => client,
    });
    await expect(store.transaction([{ text: "UPDATE fixture" }])).rejects.toBe(
      failure,
    );
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "UPDATE fixture",
      "ROLLBACK",
    ]);
    await store.close();
  });
});
