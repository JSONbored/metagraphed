import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createPooledPgRuntime,
  type PgPool,
  type PooledPgClient,
  type PooledPgOptions,
} from "../src/pg-pool.ts";

const options: PooledPgOptions = {
  connectionString: "postgresql://example/database",
  maxConnections: 2,
  connectionTimeoutMillis: 1000,
  idleTimeoutMillis: 10000,
  statementTimeoutMillis: 2000,
  onIdleError: () => {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const calls: { text: string; values?: unknown[] }[] = [];
  const clients: PooledPgClient[] = [];
  let result: { rows?: unknown[]; rowCount?: number | null } = {};
  let queryWait: Promise<void> = Promise.resolve();
  let acquisitionError: Error | undefined;
  let ended = 0;
  let idleError: ((error: Error) => void) | undefined;
  const pool: PgPool = {
    async query(text, values) {
      calls.push({ text, values });
      await queryWait;
      return result;
    },
    async connect() {
      if (acquisitionError) throw acquisitionError;
      return clients.shift()!;
    },
    async end() {
      ended += 1;
    },
    on(_event, listener) {
      idleError = listener;
    },
  };
  const runtime = createPooledPgRuntime(options, (config) => {
    assert.deepEqual(config, {
      connectionString: options.connectionString,
      max: 2,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 10000,
      statement_timeout: 2000,
    });
    return pool;
  });
  return {
    runtime,
    calls,
    clients,
    setResult(value: typeof result) {
      result = value;
    },
    setQueryWait(value: Promise<void>) {
      queryWait = value;
    },
    failAcquisition(error: Error) {
      acquisitionError = error;
    },
    ended: () => ended,
    emitIdleError(error: Error) {
      idleError!(error);
    },
    pool,
  };
}

function client(
  failures: Record<string, Error> = {},
  wait?: Promise<void>,
  waitFor = "INSERT INTO items VALUES ($1)",
) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const releases: (boolean | undefined)[] = [];
  const listeners = new Set<(error: Error) => void>();
  const entered = deferred<void>();
  const connection: PooledPgClient = {
    async query(text, values) {
      calls.push({ text, values });
      if (text === waitFor) {
        entered.resolve();
        await wait;
      }
      if (failures[text]) throw failures[text];
      return { rowCount: text.startsWith("INSERT") ? 1 : null };
    },
    release(discard) {
      releases.push(discard);
    },
    on(_event, listener) {
      listeners.add(listener);
    },
    removeListener(_event, listener) {
      listeners.delete(listener);
    },
  };
  return {
    connection,
    calls,
    releases,
    entered: entered.promise,
    emitError(error: Error) {
      for (const listener of listeners) listener(error);
    },
    listenerCount: () => listeners.size,
  };
}

describe("pooled PostgreSQL statements", () => {
  test("preserves parameters, row shapes, empty results and affected counts", async () => {
    const f = fixture();
    f.setResult({ rows: [{ value: "9007199254740993" }], rowCount: 3 });
    assert.deepEqual(await f.runtime.store.query("SELECT ? AS value", [4]), [
      { value: "9007199254740993" },
    ]);
    assert.deepEqual(await f.runtime.store.first("SELECT ? AS value", [5]), {
      value: "9007199254740993",
    });
    assert.deepEqual(
      await f.runtime.store.run("UPDATE items SET value = ?", [6]),
      { changes: 3 },
    );
    assert.deepEqual(f.calls, [
      { text: "SELECT $1 AS value", values: [4] },
      { text: "SELECT $1 AS value", values: [5] },
      { text: "UPDATE items SET value = $1", values: [6] },
    ]);
    f.setResult({});
    assert.deepEqual(await f.runtime.store.query("SELECT 1"), []);
    assert.equal(await f.runtime.store.first("SELECT 1"), null);
    assert.deepEqual(await f.runtime.store.run("DELETE FROM items"), {
      changes: 0,
    });
    assert.equal("close" in f.runtime.store, false);
    assert.equal(f.ended(), 0);
  });

  test("caps admission without retaining an unbounded pending queue", async () => {
    const f = fixture();
    const wait = deferred<void>();
    f.setQueryWait(wait.promise);
    const first = f.runtime.store.query("SELECT 1");
    const second = f.runtime.store.query("SELECT 2");
    await assert.rejects(f.runtime.store.query("SELECT 3"), /at capacity/);
    assert.equal(f.calls.length, 2);
    wait.resolve();
    await Promise.all([first, second]);
    await f.runtime.store.query("SELECT 4");
  });

  test("releases admission after a failed statement", async () => {
    const f = fixture();
    const wait = deferred<void>();
    f.setQueryWait(wait.promise);
    const pending = f.runtime.store.query("SELECT 1");
    wait.reject(new Error("query failed"));
    await assert.rejects(pending, /query failed/);
    f.setQueryWait(Promise.resolve());
    await f.runtime.store.query("SELECT 2");
  });

  test("forwards idle errors to the configured process handler", () => {
    const f = fixture();
    const errors: Error[] = [];
    createPooledPgRuntime(
      { ...options, onIdleError: (error) => errors.push(error) },
      () => f.pool,
    );
    const error = new Error("idle connection failed");
    f.emitIdleError(error);
    assert.deepEqual(errors, [error]);
  });
});

describe("pooled transaction ownership", () => {
  test("refuses a connection that fails as its lease listener is installed", async () => {
    const f = fixture();
    const c = client();
    const error = new Error("lease already failed");
    c.connection.on = (_event, listener) => listener(error);
    f.clients.push(c.connection);
    await assert.rejects(
      f.runtime.store.transaction([]),
      (caught) => caught === error,
    );
    assert.deepEqual(c.calls, []);
    assert.deepEqual(c.releases, [true]);
  });

  test.each(["BEGIN", "INSERT INTO items VALUES ($1)"])(
    "discards a connection error during %s and removes its listener",
    async (phase) => {
      const f = fixture();
      const wait = deferred<void>();
      const c = client({}, wait.promise, phase);
      f.clients.push(c.connection);
      const pending = f.runtime.store.transaction([
        { text: "INSERT INTO items VALUES (?)", values: [1] },
      ]);
      await c.entered;
      const error = new Error("connection lost");
      c.emitError(error);
      c.emitError(new Error("later connection error"));
      wait.resolve();
      await assert.rejects(pending, (caught) => caught === error);
      assert.deepEqual(c.releases, [true]);
      assert.equal(c.listenerCount(), 0);
      assert.equal(
        c.calls.some(
          (call) => call.text === "ROLLBACK" || call.text === "COMMIT",
        ),
        false,
      );
    },
  );

  test("concurrent transactions and an ordinary query never share transaction state", async () => {
    const f = fixture();
    const wait = deferred<void>();
    const a = client({}, wait.promise);
    const b = client();
    f.clients.push(a.connection, b.connection);
    const first = f.runtime.store.transaction([
      { text: "INSERT INTO items VALUES (?)", values: [1] },
    ]);
    const second = f.runtime.store.transaction([
      { text: "INSERT INTO items VALUES (?)", values: [2] },
    ]);
    await second;
    await f.runtime.store.query("SELECT 3");
    wait.resolve();
    assert.deepEqual(await first, [{ changes: 1 }]);
    assert.deepEqual(
      a.calls.map((call) => call.text),
      ["BEGIN", "INSERT INTO items VALUES ($1)", "COMMIT"],
    );
    assert.deepEqual(
      b.calls.map((call) => call.text),
      ["BEGIN", "INSERT INTO items VALUES ($1)", "COMMIT"],
    );
    assert.deepEqual(a.calls[1]!.values, [1]);
    assert.deepEqual(b.calls[1]!.values, [2]);
    assert.deepEqual(f.calls, [{ text: "SELECT 3", values: [] }]);
    assert.deepEqual(a.releases, [false]);
    assert.deepEqual(b.releases, [false]);
  });

  test("keeps all statements ordered on the leased client", async () => {
    const f = fixture();
    const c = client();
    f.clients.push(c.connection);
    assert.deepEqual(
      await f.runtime.store.transaction([
        { text: "INSERT INTO items VALUES (?)", values: [1] },
        { text: "SELECT 1" },
      ]),
      [{ changes: 1 }, { changes: 0 }],
    );
    assert.deepEqual(
      c.calls.map((call) => call.text),
      ["BEGIN", "INSERT INTO items VALUES ($1)", "SELECT 1", "COMMIT"],
    );
  });

  test.each([false, true])(
    "preserves statement errors when rollback fails=%s",
    async (rollbackFails) => {
      const f = fixture();
      const error = new Error("statement failed");
      const failures: Record<string, Error> = { "SELECT broken": error };
      if (rollbackFails) failures.ROLLBACK = new Error("rollback failed");
      const c = client(failures);
      f.clients.push(c.connection);
      await assert.rejects(
        f.runtime.store.transaction([{ text: "SELECT broken" }]),
        (caught) => caught === error,
      );
      assert.deepEqual(
        c.calls.map((call) => call.text),
        ["BEGIN", "SELECT broken", "ROLLBACK"],
      );
      assert.deepEqual(c.releases, [rollbackFails]);
    },
  );

  test.each(["BEGIN", "COMMIT"])(
    "discards the client after an uncertain %s without retry",
    async (phase) => {
      const f = fixture();
      const error = new Error(`${phase} failed`);
      const c = client({ [phase]: error });
      f.clients.push(c.connection);
      await assert.rejects(
        f.runtime.store.transaction([]),
        (caught) => caught === error,
      );
      assert.deepEqual(
        c.calls.map((call) => call.text),
        phase === "BEGIN" ? ["BEGIN"] : ["BEGIN", "COMMIT"],
      );
      assert.deepEqual(c.releases, [true]);
    },
  );

  test("an acquisition failure has no client to release and frees admission", async () => {
    const f = fixture();
    f.failAcquisition(new Error("connection unavailable"));
    await assert.rejects(
      f.runtime.store.transaction([]),
      /connection unavailable/,
    );
    assert.equal(f.clients.length, 0);
    await f.runtime.store.query("SELECT 1");
  });
});

describe("process lifetime", () => {
  test("shutdown waits for admitted operations and closes once", async () => {
    const f = fixture();
    const wait = deferred<void>();
    f.setQueryWait(wait.promise);
    const pending = f.runtime.store.query("SELECT 1");
    const closing = f.runtime.close();
    assert.equal(f.runtime.close(), closing);
    await assert.rejects(f.runtime.store.query("SELECT 2"), /is closed/);
    assert.equal(f.ended(), 0);
    wait.resolve();
    await pending;
    await closing;
    assert.equal(f.ended(), 1);
  });

  test("the default driver can be created and shut down without connecting", async () => {
    const runtime = createPooledPgRuntime(options);
    await runtime.close();
  });

  test.each([
    "maxConnections",
    "connectionTimeoutMillis",
    "idleTimeoutMillis",
    "statementTimeoutMillis",
  ] as const)("rejects invalid %s before constructing a pool", (key) => {
    for (const value of [
      0,
      -1,
      1.5,
      Infinity,
      NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(
        () => createPooledPgRuntime({ ...options, [key]: value }),
        /positive safe integer/,
      );
    }
  });

  test("rejects an empty connection string", () => {
    assert.throws(
      () => createPooledPgRuntime({ ...options, connectionString: " " }),
      /connection string is required/,
    );
  });
});
