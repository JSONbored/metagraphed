import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createPooledPgRuntime,
  type PgPool,
  type PooledPgClient,
  type PooledPgOptions,
  type PgTransaction,
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

  test.each([
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "INSERT INTO items VALUES ($1)",
  ])(
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
      [
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        "INSERT INTO items VALUES ($1)",
        "COMMIT",
      ],
    );
    assert.deepEqual(
      b.calls.map((call) => call.text),
      [
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        "INSERT INTO items VALUES ($1)",
        "COMMIT",
      ],
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
      [
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        "INSERT INTO items VALUES ($1)",
        "SELECT 1",
        "COMMIT",
      ],
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
        ["BEGIN ISOLATION LEVEL READ COMMITTED", "SELECT broken", "ROLLBACK"],
      );
      assert.deepEqual(c.releases, [rollbackFails]);
    },
  );

  test.each(["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT"])(
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
        phase === "BEGIN ISOLATION LEVEL READ COMMITTED"
          ? ["BEGIN ISOLATION LEVEL READ COMMITTED"]
          : ["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT"],
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

describe("leased transaction callbacks", () => {
  test("returns scoped query results on one lease and closes the escaped scope", async () => {
    const f = fixture();
    const c = client();
    const query = c.connection.query;
    c.connection.query = async (text, values) => {
      await query(text, values);
      return {
        rows: text === "SELECT missing" ? [] : [{ value: 7 }],
        rowCount: 2,
      };
    };
    f.clients.push(c.connection);
    let escaped!: PgTransaction;
    const result = await f.runtime.transaction(
      async (tx) => {
        escaped = tx;
        assert.deepEqual(await tx.query("SELECT ?", [7]), [{ value: 7 }]);
        assert.deepEqual(await tx.first("SELECT first"), { value: 7 });
        assert.equal(await tx.first("SELECT missing"), null);
        assert.deepEqual(await tx.run("UPDATE items SET value=?", [7]), {
          changes: 2,
        });
        return "completed";
      },
      { isolation: "repeatable read" },
    );
    assert.equal(result, "completed");
    assert.equal(c.calls[0]!.text, "BEGIN ISOLATION LEVEL REPEATABLE READ");
    assert.equal(c.calls.at(-1)!.text, "COMMIT");
    assert.deepEqual(c.releases, [false]);
    const count = c.calls.length;
    await assert.rejects(escaped.query("SELECT late"), /scope is closed/);
    await assert.rejects(escaped.first("SELECT late"), /scope is closed/);
    await assert.rejects(escaped.run("UPDATE late"), /scope is closed/);
    assert.equal(c.calls.length, count);
  });

  test("rejects unsupported isolation before taking a pool connection", async () => {
    const f = fixture();
    await assert.rejects(
      f.runtime.transaction(async () => {}, {
        isolation: "read uncommitted" as "read committed",
      }),
      /Unsupported/,
    );
    assert.deepEqual(f.calls, []);
  });

  test("settles an unawaited operation before commit and process shutdown", async () => {
    const f = fixture();
    const wait = deferred<void>();
    const c = client({}, wait.promise);
    f.clients.push(c.connection);
    const completed = f.runtime.transaction(async (tx) => {
      void tx.run("INSERT INTO items VALUES (?)", [1]);
      return 42;
    });
    await c.entered;
    const closing = f.runtime.close();
    assert.equal(
      c.calls.some((call) => call.text === "COMMIT"),
      false,
    );
    assert.equal(f.ended(), 0);
    wait.resolve();
    assert.equal(await completed, 42);
    await closing;
    assert.equal(c.calls.at(-1)!.text, "COMMIT");
    assert.equal(f.ended(), 1);
  });

  test("seals callback admission while already-issued operations drain", async () => {
    const f = fixture();
    const wait = deferred<void>();
    const c = client({}, wait.promise);
    f.clients.push(c.connection);
    let escaped!: PgTransaction;
    const completed = f.runtime.transaction(async (tx) => {
      escaped = tx;
      void tx.run("INSERT INTO items VALUES (?)", [1]);
    });
    await c.entered;
    await Promise.resolve();
    await assert.rejects(
      escaped.run("INSERT INTO late VALUES (?)", [2]),
      /scope is closed/,
    );
    assert.equal(
      c.calls.some((call) => call.text.includes("late")),
      false,
    );
    assert.equal(
      c.calls.some((call) => call.text === "COMMIT"),
      false,
    );
    wait.resolve();
    await completed;
    assert.equal(c.calls.at(-1)!.text, "COMMIT");
  });

  test("rolls back unawaited statement failures before releasing the lease", async () => {
    const f = fixture();
    const failure = new Error("detached query failed");
    const c = client({ "SELECT broken": failure });
    f.clients.push(c.connection);
    await assert.rejects(
      f.runtime.transaction(async (tx) => {
        void tx.query("SELECT broken");
        return "callback completed";
      }),
      (error) => error === failure,
    );
    assert.deepEqual(
      c.calls.map((call) => call.text),
      ["BEGIN ISOLATION LEVEL READ COMMITTED", "SELECT broken", "ROLLBACK"],
    );
    assert.deepEqual(c.releases, [false]);
  });

  test("rolls back an issued failure even when the callback catches it", async () => {
    const f = fixture();
    const failure = new Error("query failed");
    const c = client({ "SELECT broken": failure });
    f.clients.push(c.connection);
    let escaped!: PgTransaction;
    await assert.rejects(
      f.runtime.transaction(async (tx) => {
        escaped = tx;
        await tx.query("SELECT broken").catch(() => undefined);
        return "ignored";
      }),
      (error) => error === failure,
    );
    assert.deepEqual(
      c.calls.map((call) => call.text),
      ["BEGIN ISOLATION LEVEL READ COMMITTED", "SELECT broken", "ROLLBACK"],
    );
    await assert.rejects(escaped.query("SELECT late"), /scope is closed/);
  });

  test("drains issued work before rolling back the callback's original error", async () => {
    const f = fixture();
    const failure = new Error("callback failed");
    const wait = deferred<void>();
    const c = client({}, wait.promise);
    f.clients.push(c.connection);
    const completed = f.runtime.transaction(async (tx) => {
      void tx.run("INSERT INTO items VALUES (?)", [1]);
      throw failure;
    });
    const observed = assert.rejects(completed, (error) => error === failure);
    await c.entered;
    assert.equal(
      c.calls.some((call) => call.text === "ROLLBACK"),
      false,
    );
    wait.resolve();
    await observed;
    assert.equal(c.calls.at(-1)!.text, "ROLLBACK");
    assert.deepEqual(c.releases, [false]);
  });

  test("uses the same uncertain-commit handling for callback writes", async () => {
    const f = fixture();
    const failure = new Error("commit receipt lost");
    const c = client({ COMMIT: failure });
    f.clients.push(c.connection);
    await assert.rejects(
      f.runtime.transaction(async (tx) => {
        await tx.run("INSERT INTO items VALUES (?)", [1]);
      }),
      (error) => error === failure,
    );
    assert.deepEqual(
      c.calls.map((call) => call.text),
      [
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        "INSERT INTO items VALUES ($1)",
        "COMMIT",
      ],
    );
    assert.deepEqual(c.releases, [true]);
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
