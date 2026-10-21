// Pure synthetic mechanism tests. These do not import pg, inflate bytes,
// open a socket, launch a service, or qualify any native owner behavior.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  assertFailureAuthLifecycle,
  assertFailureUnfixedAuthControl,
  assertFailureSuccessfulLifecycle,
  assertFailureQueryLifecycle,
  assertFailureDecoderLifecycle,
} from "./failure-lifecycle-assertions.ts";
let serial = 0;
const fresh = () => import(`./failure-lifecycle-observer.ts?pure=${++serial}`);
const hash = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function deferred() {
  let resolve!: (value?: any) => void, reject!: (error: any) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class SyntheticMethods {
  processID = 123;
  _ended = false;
  streamClose: (() => void)[] = [];
  connection = {
    stream: {
      destroyed: false,
      on: (event: string, fn: () => void) => {
        if (event === "close") this.streamClose.push(fn);
      },
    },
  };
  events = new Map<string, (() => void)[]>();
  calls: { method: string; receiver: unknown; args: unknown[] }[] = [];
  connectResult = Promise.resolve();
  queryResult: any = Promise.resolve({ rows: [] });
  endResult: any = Promise.resolve();
  thrown: unknown;
  on(event: string, fn: () => void) {
    this.events.set(event, [...(this.events.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string) {
    for (const fn of this.events.get(event) ?? []) fn();
  }
  connect(...args: any[]) {
    this.calls.push({ method: "connect", receiver: this, args });
    return this.connectResult;
  }
  query(...args: any[]) {
    this.calls.push({ method: "query", receiver: this, args });
    if (this.thrown) throw this.thrown;
    return this.queryResult;
  }
  end(...args: any[]) {
    this.calls.push({ method: "end", receiver: this, args });
    this._ended = true;
    this.connection.stream.destroyed = true;
    for (const fn of this.streamClose) fn();
    this.emit("end");
    return this.endResult;
  }
}
async function authFixture(
  options: {
    code?: string;
    omitEnd?: boolean;
    duplicateEnd?: boolean;
    endError?: boolean;
    queryAfter?: boolean;
    success?: boolean;
    helper?: string;
  } = {},
) {
  const observer = await fresh();
  observer.beginFailureLifecycle("auth-rejection");
  const client = new SyntheticMethods();
  const failure = Object.assign(new Error("private synthetic detail"), {
    code: options.code ?? "28P01",
  });
  client.connectResult = options.success
    ? Promise.resolve()
    : Promise.reject(failure);
  if (options.endError)
    client.endResult = Promise.reject(new Error("hidden teardown error"));
  observer.observeFailurePgClient(
    client,
    SyntheticMethods,
    options.helper ?? "createPgSql",
  );
  await client.connect().catch(() => undefined);
  if (options.queryAfter) await client.query("private SQL", []);
  if (!options.omitEnd) await client.end().catch(() => undefined);
  else {
    client._ended = true;
    client.connection.stream.destroyed = true;
    for (const fn of client.streamClose) fn();
    client.emit("end");
  }
  if (options.duplicateEnd) await client.end().catch(() => undefined);
  observer.finishFailureLifecycle();
  await flush();
  return {
    observer,
    client,
    snapshot: observer.readFailureLifecycle(),
    failure,
  };
}
test("pg forwarding preserves actual receiver, argument identity, Promise identity, values and rejection object", async () => {
  const observer = await fresh();
  observer.beginFailureLifecycle("query-cancellation");
  const client = new SyntheticMethods();
  observer.observeFailurePgClient(client, SyntheticMethods, "createPgSql");
  const connected = client.connect();
  assert.equal(connected, client.connectResult);
  await connected;
  const values = [{ exact: "identity" }];
  const row = { rows: [{ value: 1 }] };
  client.queryResult = Promise.resolve(row);
  const query = client.query("SELECT $1", values);
  assert.equal(query, client.queryResult);
  assert.equal(await query, row);
  assert.equal(client.calls[1]!.receiver, client);
  assert.equal(client.calls[1]!.args[1], values);
  const rejection = Object.assign(new Error("original"), { code: "57014" });
  client.queryResult = Promise.reject(rejection);
  const failed = client.query("SELECT $1", values);
  assert.equal(failed, client.queryResult);
  await assert.rejects(failed, (error) => error === rejection);
  const end = client.end();
  assert.equal(end, client.endResult);
  await end;
  observer.finishFailureLifecycle();
  assert.equal(
    observer.readFailureLifecycle().clients[0].operations[2].sqlstate,
    "57014",
  );
});
test("pg forwarding preserves synchronous throw identity", async () => {
  const observer = await fresh();
  const client = new SyntheticMethods();
  const thrown = new Error("original throw");
  client.thrown = thrown;
  observer.observeFailurePgClient(client, SyntheticMethods, "createPgSql");
  assert.throws(
    () => client.query("SELECT 1", []),
    (error) => error === thrown,
  );
  assert.equal(
    observer.readFailureLifecycle().clients[0].operations[0].status,
    "threw",
  );
});
test("auth requires real rejected connect and exactly one settled end per constructed client", async () => {
  const { snapshot } = await authFixture();
  assert.deepEqual(assertFailureAuthLifecycle(snapshot), {
    clients: 1,
    rejectedConnects: 1,
    settledEnds: 1,
  });
});
for (const [name, options] of Object.entries({
  "missing end even though auth socket closed": { omitEnd: true },
  "duplicate end": { duplicateEnd: true },
  "hidden end rejection": { endError: true },
  "wrong SQLSTATE": { code: "08006" },
  "connection refusal is not auth": { code: "ECONNREFUSED" },
  "query after rejection": { queryAfter: true },
  "successful connect is not fault witness": { success: true },
}))
  test(`auth negative control: ${name}`, async () => {
    const { snapshot } = await authFixture(options);
    assert.throws(() => assertFailureAuthLifecycle(snapshot));
  });
// Await outside synchronous assertion callback.
test("no constructed client and missing helper witnesses fail", async () => {
  const { snapshot } = await authFixture();
  assert.throws(() => assertFailureAuthLifecycle({ ...snapshot, clients: [] }));
  assert.throws(() => assertFailureAuthLifecycle(snapshot, ["pgReadStore"]));
});
test("every real constructed client remains visible including a leaked second client", async () => {
  const { observer, snapshot } = await authFixture();
  const second = new SyntheticMethods();
  second.connectResult = Promise.reject(
    Object.assign(new Error(), { code: "28P01" }),
  );
  observer.observeFailurePgClient(second, SyntheticMethods, "pgLaneHealthDb");
  await second.connect().catch(() => undefined);
  const all = observer.readFailureLifecycle();
  assert.equal(all.clients.length, 2);
  assert.equal(snapshot.clients.length, 1);
  assert.throws(() => assertFailureAuthLifecycle(all));
});
test("Client identity, prewrapped own methods and duplicate attachment are refused", async () => {
  const observer = await fresh();
  const client = new SyntheticMethods();
  assert.throws(() =>
    observer.observeFailurePgClient({}, SyntheticMethods, "createPgSql"),
  );
  const own = new SyntheticMethods();
  own.connect = own.connect.bind(own);
  assert.throws(() =>
    observer.observeFailurePgClient(own, SyntheticMethods, "createPgSql"),
  );
  observer.observeFailurePgClient(client, SyntheticMethods, "createPgSql");
  assert.throws(() =>
    observer.observeFailurePgClient(client, SyntheticMethods, "createPgSql"),
  );
});
test("unsupported callback return is forwarded unchanged and cannot qualify", async () => {
  const observer = await fresh();
  const client = new SyntheticMethods();
  client.queryResult = undefined;
  observer.observeFailurePgClient(client, SyntheticMethods, "createPgSql");
  const callback = () => {};
  assert.equal(client.query("SELECT 1", [], callback), undefined);
  assert.equal(client.calls[0]!.args[2], callback);
  assert.ok(
    observer
      .readFailureLifecycle()
      .violations.includes("non-native-promise-return"),
  );
});
async function queryFixture(
  message = "canceling statement due to user request",
) {
  const observer = await fresh();
  observer.beginFailureLifecycle("query-cancellation");
  const client = new SyntheticMethods();
  observer.observeFailurePgClient(client, SyntheticMethods, "createPgSql");
  await client.connect();
  client.queryResult = Promise.reject(
    Object.assign(new Error(message), { code: "57014" }),
  );
  await client
    .query("SELECT 'private selected query'", [])
    .catch(() => undefined);
  await client.end();
  observer.finishFailureLifecycle();
  await flush();
  return {
    snapshot: observer.readFailureLifecycle(),
    target: {
      querySha256: hash("SELECT 'private selected query'"),
      backendPid: 123,
    },
  };
}
test("query code is captured before downstream message-only conversion and bound to PID plus exact SQL hash", async () => {
  const { snapshot, target } = await queryFixture();
  assert.equal(
    assertFailureQueryLifecycle(snapshot, target).targetedQueryRejections,
    1,
  );
  assert.ok(!JSON.stringify(snapshot).includes("private"));
});
for (const [name, edit] of Object.entries({
  "wrong PID": (snapshot: any, target: any) => {
    target.backendPid++;
  },
  "wrong SQL": (snapshot: any, target: any) => {
    target.querySha256 = "0".repeat(64);
  },
  "true signal without rejection": (snapshot: any) => {
    snapshot.clients[0].operations[1].status = "fulfilled";
  },
  "wrong SQLSTATE": (snapshot: any) => {
    snapshot.clients[0].operations[1].sqlstate = "40001";
  },
  "no SQLSTATE": (snapshot: any) => {
    snapshot.clients[0].operations[1].sqlstate = null;
  },
  "hidden end failure": (snapshot: any) => {
    snapshot.clients[0].operations[2].status = "rejected";
  },
  "pending teardown": (snapshot: any) => {
    snapshot.clients[0].operations[2].status = "pending";
  },
  "no actual end event": (snapshot: any) => {
    snapshot.clients[0].endEvents = 0;
  },
  "no actual transport close": (snapshot: any) => {
    snapshot.clients[0].streamCloseEvents = 0;
  },
}))
  test(`query negative control: ${name}`, async () => {
    const { snapshot, target } = await queryFixture();
    edit(snapshot, target);
    assert.throws(() => assertFailureQueryLifecycle(snapshot, target));
  });
class SyntheticInflater {
  bytesWritten = 0;
  readableLength = 0;
  destroyed = false;
  events = new Map<string, (() => void)[]>();
  calls: any[] = [];
  output: Uint8Array | null = null;
  on(event: string, fn: () => void) {
    this.events.set(event, [...(this.events.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string) {
    for (const fn of this.events.get(event) ?? []) fn();
  }
  write(...args: any[]) {
    this.calls.push(["write", this, args]);
    return false;
  }
  end(...args: any[]) {
    this.calls.push(["end", this, args]);
    return this;
  }
  read(...args: any[]) {
    this.calls.push(["read", this, args]);
    return this.output;
  }
  push(...args: any[]) {
    this.calls.push(["push", this, args]);
    return false;
  }
  destroy(...args: any[]) {
    this.calls.push(["destroy", this, args]);
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}
async function decoderFixture(pending = false) {
  const observer = await fresh();
  observer.beginFailureLifecycle("decoder-refusal");
  const wire = Uint8Array.from([1, 2, 3, ...new Uint8Array(97)]);
  observer.observeFailureMessage("bad", wire);
  const inflater = new SyntheticInflater();
  observer.observeFailureInflater(inflater, wire, 10);
  const first = deferred();
  const reader = {
    next() {
      return first.promise;
    },
    cancel() {
      inflater.destroy();
      first.resolve({ done: true });
    },
    return() {
      inflater.destroy();
      first.resolve({ done: true });
      return Promise.resolve({ done: true });
    },
  };
  observer.observeFailureReader(reader, inflater);
  if (pending) {
    const returned = reader.next();
    assert.equal(returned, first.promise);
    await flush();
  } else {
    // Synthetic counters only: no decoded allocation and no fake codec in a native fixture.
    inflater.push({ byteLength: 79_393_025 });
    inflater.output = { byteLength: 79_393_025 } as any;
    inflater.read(8192);
  }
  reader.cancel();
  await flush();
  if (!pending)
    for (const id of ["left", "right"]) {
      observer.observeFailureMessage(id, new Uint8Array([id.length]));
      observer.observeFailureWriter(id);
      const client = new SyntheticMethods();
      observer.observeFailurePgClient(client, SyntheticMethods, "createPgSql");
      await client.connect();
      await client.query("SELECT 1", []);
      await client.end();
    }
  observer.finishFailureLifecycle();
  return {
    observer,
    inflater,
    reader,
    snapshot: observer.readFailureLifecycle(),
  };
}
test("inflater wrappers preserve original callback/receiver/arguments and return values", async () => {
  const observer = await fresh();
  observer.beginFailureLifecycle("decoder-refusal");
  const inflater = new SyntheticInflater();
  observer.observeFailureInflater(inflater, new Uint8Array(100), 10);
  const chunk = new Uint8Array([1, 2]);
  const callback = () => {};
  assert.equal(inflater.write(chunk, callback), false);
  assert.equal(inflater.calls[0][1], inflater);
  assert.equal(inflater.calls[0][2][0], chunk);
  assert.equal(inflater.calls[0][2][1], callback);
  assert.equal(inflater.end(callback), inflater);
  assert.equal(inflater.calls[1][2][0], callback);
  const error = new Error("original destroy");
  assert.equal(inflater.destroy(error), inflater);
  assert.equal(inflater.calls[2][2][0], error);
});
test("decoder cancellation oracle separates no writer from actual destruction and settlement", async () => {
  const { snapshot } = await decoderFixture();
  assert.equal(assertFailureDecoderLifecycle(snapshot).refusedWriterCalls, 0);
});
test("reader forwarding preserves original delayed Promise and observes done settlement", async () => {
  const { snapshot } = await decoderFixture(true);
  assert.equal(snapshot.readers[0].pendingNext, 0);
  assert.equal(snapshot.readers[0].nextDone, 1);
  assert.equal(snapshot.readers[0].nextSettled, 1);
});
for (const [name, edit] of Object.entries({
  "no cancel": (s: any) => {
    s.readers[0].cancel = null;
  },
  "already destroyed before cancel": (s: any) => {
    s.readers[0].cancel.before.destroyed = true;
  },
  "not synchronously destroyed": (s: any) => {
    s.readers[0].cancel.after.destroyed = false;
  },
  "no close": (s: any) => {
    s.readers[0].closes = 0;
  },
  "pending next unresolved": (s: any) => {
    s.readers[0].pendingNext = 1;
  },
  "later compressed write": (s: any) => {
    s.readers[0].current.writes++;
  },
  "later input consumption": (s: any) => {
    s.readers[0].current.consumed++;
  },
  "later native output": (s: any) => {
    s.readers[0].current.produced++;
  },
  "later drain": (s: any) => {
    s.readers[0].current.drained++;
  },
  "writer called": (s: any) => {
    s.dispatches[0].messages[0].writerCalls = 1;
  },
  "below budget": (s: any) => {
    s.readers[0].cancel.before.drained = 1;
  },
  "tail completed": (s: any) => {
    s.readers[0].nativeEnds = 1;
  },
}))
  test(`decoder negative control: ${name}`, async () => {
    const { snapshot } = await decoderFixture();
    edit(snapshot);
    assert.throws(() => assertFailureDecoderLifecycle(snapshot));
  });
test("actual later observer advancement cannot be hidden by a final unchanged snapshot", async () => {
  const { observer, inflater } = await decoderFixture();
  inflater.push(new Uint8Array(1));
  assert.throws(() =>
    assertFailureDecoderLifecycle(observer.readFailureLifecycle()),
  );
});
test("offset byte views use exact custody and immutable construction association", async () => {
  const observer = await fresh();
  observer.beginFailureLifecycle("decoder-refusal");
  const backing = new Uint8Array([9, 1, 2, 3, 9]);
  const view = backing.subarray(1, 4);
  observer.observeFailureMessage("first", view);
  const inflater = new SyntheticInflater();
  observer.observeFailureInflater(inflater, view.slice(), 1);
  observer.observeFailureMessage("later", new Uint8Array([4]));
  const state = observer.readFailureLifecycle();
  assert.equal(state.readers[0].messageId, "first");
  assert.equal(state.readers[0].wireSha256, hash(view));
});
test("duplicate wire custody fails rather than inventing a message attribution", async () => {
  const observer = await fresh();
  observer.beginFailureLifecycle("decoder-refusal");
  const bytes = new Uint8Array([1, 2]);
  observer.observeFailureMessage("first", bytes);
  observer.observeFailureMessage("second", bytes);
  observer.observeFailureInflater(new SyntheticInflater(), bytes, 1);
  assert.ok(
    observer
      .readFailureLifecycle()
      .violations.includes("reader-wire-association-ambiguous"),
  );
});
test("fixed scenario binding rejects missing, arbitrary, changed and overlapping values", async () => {
  const observer = await fresh();
  for (const env of [
    {},
    { FAILURE_LIFECYCLE_SCENARIO: "anything" },
    { FAILURE_LIFECYCLE_SCENARIO: 1 },
  ])
    assert.throws(() => observer.beginFailureLifecycleFromEnv(env));
  observer.beginFailureLifecycleFromEnv({
    FAILURE_LIFECYCLE_SCENARIO: "auth-rejection",
  });
  assert.throws(() => observer.beginFailureLifecycle("auth-rejection"));
  observer.finishFailureLifecycle();
  assert.throws(() => observer.beginFailureLifecycle("query-cancellation"));
});
test("read-only endpoint accepts only exact synthetic URL plus GET", async () => {
  const observer = await fresh();
  const endpoint =
    "https://qualification.invalid/__qualification/failure-lifecycle";
  for (const url of [
    endpoint + "?other",
    endpoint + "/",
    endpoint.replace("qualification.invalid", "other.invalid"),
    endpoint.replace("https:", "http:"),
  ])
    assert.equal(observer.failureLifecycleResponse(new Request(url)), null);
  assert.equal(
    observer.failureLifecycleResponse(
      new Request(endpoint, { method: "POST" }),
    )!.status,
    405,
  );
  const response = observer.failureLifecycleResponse(new Request(endpoint))!;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    (await response.json()).kind,
    "supplemental-source-bound-lifecycle-v1",
  );
});
test("byte-identical replay retains earlier dispatch evidence without resetting failures", async () => {
  const observer = await fresh();
  const bytes = new Uint8Array([1, 2]);
  for (let i = 0; i < 2; i++) {
    observer.beginFailureLifecycle("query-cancellation");
    observer.observeFailureMessage("same-id", bytes);
    observer.finishFailureLifecycle();
  }
  assert.deepEqual(
    observer.readFailureLifecycle().dispatches.map((row: any) => row.ordinal),
    [1, 2],
  );
  assert.equal(
    observer.readFailureLifecycle().dispatches[0].messages[0].wireSha256,
    observer.readFailureLifecycle().dispatches[1].messages[0].wireSha256,
  );
});

test("pg-cloudflare normal end can close without setting its destroyed flag", async () => {
  const { snapshot } = await authFixture();
  snapshot.clients[0].streamDestroyed = false;
  assert.equal(assertFailureAuthLifecycle(snapshot).settledEnds, 1);
});

test("unfixed native-control oracle requires auth evidence and detects precisely missing client.end", async () => {
  const { snapshot } = await authFixture({ omitEnd: true });
  assert.equal(
    assertFailureUnfixedAuthControl(snapshot).fixedLifecycleOracle,
    "rejected-missing-end",
  );
  const fixed = await authFixture();
  assert.throws(() => assertFailureUnfixedAuthControl(fixed.snapshot));
  const refused = await authFixture({ omitEnd: true, code: "08006" });
  assert.throws(() => assertFailureUnfixedAuthControl(refused.snapshot));
  assert.throws(() =>
    assertFailureUnfixedAuthControl({ ...snapshot, clients: [] }),
  );
});

for (const message of [
  "canceling statement due to statement timeout",
  "unrecognized cancellation reason",
  "",
]) {
  test(`57014 cannot disguise another cancellation cause: ${message || "missing message"}`, async () => {
    const { snapshot, target } = await queryFixture(message);
    assert.throws(
      () => assertFailureQueryLifecycle(snapshot, target),
      /natural timeout cannot qualify/,
    );
    if (message) assert.ok(!JSON.stringify(snapshot).includes(message));
  });
}

test("successful-control oracle requires actual connect/query/end success and an explicit writer", async () => {
  const { snapshot } = await decoderFixture();
  assert.equal(
    assertFailureSuccessfulLifecycle(snapshot, "decoder-refusal")
      .successfulQueries,
    2,
  );
  const hidden = structuredClone(snapshot);
  hidden.clients[0].operations[2].status = "rejected";
  assert.throws(() =>
    assertFailureSuccessfulLifecycle(hidden, "decoder-refusal"),
  );
  assert.throws(() => assertFailureDecoderLifecycle(hidden));
  const noWriter = structuredClone(snapshot);
  for (const dispatch of noWriter.dispatches)
    for (const message of dispatch.messages) message.writerCalls = 0;
  assert.throws(() =>
    assertFailureSuccessfulLifecycle(noWriter, "decoder-refusal"),
  );
  assert.throws(() =>
    assertFailureSuccessfulLifecycle(
      { ...snapshot, clients: [] },
      "decoder-refusal",
    ),
  );
});
