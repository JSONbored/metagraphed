// Supplemental source-bound observations only. This module never creates a pg
// client, connects a socket, constructs an inflater, or supplies a replacement.
import { createHash } from "node:crypto";

export type FailureScenario =
  "auth-rejection" | "query-cancellation" | "decoder-refusal";
type Method = (...args: any[]) => any;
type Operation = {
  method: "connect" | "query" | "end";
  call: number;
  settlement: number | null;
  status: "pending" | "fulfilled" | "rejected" | "threw" | "unsupported-return";
  sqlstate: string | null;
  cancellationCause: "user-request" | "statement-timeout" | "other" | null;
  querySha256: string | null;
  backendPid: number | null;
};
export type PgObservation = {
  id: number;
  helper: string;
  // No asynchronous per-message/dispatch attribution is inferred for pg.
  messageId: null;
  dispatch: null;
  operations: Operation[];
  endEvents: number;
  streamCloseEvents: number;
  clientEnded: boolean;
  streamDestroyed: boolean;
};
export type InflaterSnapshot = {
  submitted: number;
  consumed: number;
  produced: number;
  drained: number;
  writes: number;
  reads: number;
  ends: number;
  destroys: number;
  queued: number;
  destroyed: boolean;
};
export type ReaderObservation = {
  id: number;
  dispatch: number;
  messageId: string | null;
  wireSha256: string;
  wireBytes: number;
  headerBytes: number;
  nextCalls: number;
  pendingNext: number;
  nextSettled: number;
  nextDone: number;
  nextRejected: number;
  closes: number;
  nativeEnds: number;
  cancelCalls: number;
  returnCalls: number;
  cancel: null | {
    sequence: number;
    kind: "cancel" | "return";
    pendingNext: number;
    before: InflaterSnapshot;
    after: InflaterSnapshot | null;
  };
  current: InflaterSnapshot;
  advancementsAfterCancel: number;
};
export type FailureLifecycleSnapshot = {
  kind: "supplemental-source-bound-lifecycle-v1";
  scenario: FailureScenario | null;
  dispatches: {
    ordinal: number;
    finished: boolean;
    messages: {
      id: string;
      wireSha256: string | null;
      writerCalls: number;
    }[];
  }[];
  clients: PgObservation[];
  readers: ReaderObservation[];
  violations: string[];
  sequence: number;
};
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const snapshot: FailureLifecycleSnapshot = {
  kind: "supplemental-source-bound-lifecycle-v1",
  scenario: null,
  dispatches: [],
  clients: [],
  readers: [],
  violations: [],
  sequence: 0,
};
const clientUpdates: (() => void)[] = [];
const readerUpdates: (() => void)[] = [];
const seenClients = new WeakSet<object>();
const readers = new WeakMap<
  object,
  { state: ReaderObservation; sample: () => InflaterSnapshot }
>();
let activeDispatch: FailureLifecycleSnapshot["dispatches"][number] | undefined;
function violate(code: string) {
  if (!snapshot.violations.includes(code) && snapshot.violations.length < 32)
    snapshot.violations.push(code);
}
function tick() {
  return ++snapshot.sequence;
}
function sqlstate(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const property = Object.getOwnPropertyDescriptor(error, "code");
  return property &&
    "value" in property &&
    typeof property.value === "string" &&
    /^[0-9A-Z]{5}$/.test(property.value)
    ? property.value
    : null;
}
function cancellationCause(error: unknown): Operation["cancellationCause"] {
  if (sqlstate(error) !== "57014") return null;
  const property = Object.getOwnPropertyDescriptor(error as object, "message");
  const message = property && "value" in property ? property.value : null;
  if (message === "canceling statement due to user request")
    return "user-request";
  if (message === "canceling statement due to statement timeout")
    return "statement-timeout";
  return "other";
}
// Attach side observers without substituting a Promise/thenable or altering
// arguments. A failing observer is recorded, not thrown into native work.
function watch(
  result: any,
  yes: (value: any) => void,
  no: (error: any) => void,
): boolean {
  try {
    Promise.prototype.then.call(
      result,
      (value: any) => {
        try {
          yes(value);
        } catch {
          violate("observer-fulfillment-failed");
        }
      },
      (error: any) => {
        try {
          no(error);
        } catch {
          violate("observer-rejection-failed");
        }
      },
    );
    return true;
  } catch {
    violate("non-native-promise-return");
    return false;
  }
}
function wrap(
  target: any,
  name: string,
  invoke: (original: Method, receiver: any, args: any[]) => any,
) {
  const original: Method = target[name];
  if (typeof original !== "function")
    throw new Error("Failure lifecycle method absent");
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function (this: any, ...args: any[]) {
      return invoke(original, this, args);
    },
  });
}
export function beginFailureLifecycle(scenario: FailureScenario) {
  if (
    !["auth-rejection", "query-cancellation", "decoder-refusal"].includes(
      scenario,
    )
  )
    throw new Error("Failure lifecycle scenario refused");
  if (
    activeDispatch ||
    snapshot.dispatches.length >= 4 ||
    (snapshot.scenario !== null && snapshot.scenario !== scenario)
  )
    throw new Error("Failure lifecycle overlapping or changed scenario");
  snapshot.scenario = scenario;
  activeDispatch = {
    ordinal: snapshot.dispatches.length + 1,
    finished: false,
    messages: [],
  };
  snapshot.dispatches.push(activeDispatch);
}
export function beginFailureLifecycleFromEnv(env: unknown) {
  const scenario = (env as { FAILURE_LIFECYCLE_SCENARIO?: FailureScenario })
    ?.FAILURE_LIFECYCLE_SCENARIO;
  beginFailureLifecycle(scenario as FailureScenario);
}
export function failureLifecycleResponse(request: Request): Response | null {
  if (
    request.url !==
    "https://qualification.invalid/__qualification/failure-lifecycle"
  )
    return null;
  if (request.method !== "GET") return new Response(null, { status: 405 });
  return Response.json(readFailureLifecycle(), {
    headers: { "Cache-Control": "no-store" },
  });
}
export function finishFailureLifecycle() {
  if (!activeDispatch) throw new Error("Failure lifecycle dispatch absent");
  activeDispatch.finished = true;
  activeDispatch = undefined;
}
export function observeFailureMessage(id: string, body: unknown) {
  const dispatch = activeDispatch;
  if (
    !dispatch ||
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 200 ||
    dispatch.messages.length >= 10 ||
    dispatch.messages.some((row) => row.id === id)
  ) {
    violate("message-scope-invalid");
    return;
  }
  const bytes =
    body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : ArrayBuffer.isView(body)
        ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
        : null;
  dispatch.messages.push({
    id,
    wireSha256: bytes ? digest(bytes) : null,
    writerCalls: 0,
  });
}
export function observeFailureWriter(id: string) {
  const row = activeDispatch?.messages.find((message) => message.id === id);
  if (!row) violate("writer-scope-absent");
  else row.writerCalls++;
}
export function observeFailurePgClient(
  client: any,
  Client: any,
  helper: string,
) {
  if (
    !client ||
    typeof Client !== "function" ||
    Object.getPrototypeOf(client) !== Client.prototype ||
    seenClients.has(client) ||
    snapshot.clients.length >= 128 ||
    !["createPgSql", "pgReadStore", "pgLaneHealthDb"].includes(helper)
  )
    throw new Error("Failure lifecycle real Client identity refused");
  for (const method of ["connect", "query", "end"])
    if (
      Object.hasOwn(client, method) ||
      client[method] !== Client.prototype[method]
    )
      throw new Error("Failure lifecycle pg method identity refused");
  seenClients.add(client);
  const state: PgObservation = {
    id: snapshot.clients.length + 1,
    helper,
    messageId: null,
    dispatch: null,
    operations: [],
    endEvents: 0,
    streamCloseEvents: 0,
    clientEnded: false,
    streamDestroyed: false,
  };
  snapshot.clients.push(state);
  const update = () => {
    state.clientEnded = client._ended === true;
    state.streamDestroyed = client.connection?.stream?.destroyed === true;
  };
  clientUpdates.push(update);
  client.on("end", () => {
    state.endEvents++;
    update();
  });
  client.connection.stream.on("close", () => {
    state.streamCloseEvents++;
    update();
  });
  for (const method of ["connect", "query", "end"] as const) {
    wrap(client, method, (original, receiver, args) => {
      if (receiver !== client) violate("pg-receiver-changed");
      if (state.operations.length >= 32) {
        violate("pg-operation-cap");
        return Reflect.apply(original, receiver, args);
      }
      const operation: Operation = {
        method,
        call: tick(),
        settlement: null,
        status: "pending",
        sqlstate: null,
        cancellationCause: null,
        querySha256:
          method === "query" && typeof args[0] === "string"
            ? digest(args[0])
            : null,
        backendPid:
          Number.isSafeInteger(client.processID) && client.processID > 0
            ? client.processID
            : null,
      };
      state.operations.push(operation);
      if (
        (method !== "query" && args.length !== 0) ||
        (method === "query" &&
          (args.length !== 2 ||
            typeof args[0] !== "string" ||
            !Array.isArray(args[1])))
      )
        violate("pg-call-shape-changed");
      const settle = (status: Operation["status"], error?: unknown) => {
        operation.status = status;
        operation.settlement = tick();
        operation.sqlstate = sqlstate(error);
        operation.cancellationCause = cancellationCause(error);
        update();
      };
      try {
        const result = Reflect.apply(original, receiver, args);
        if (
          !watch(
            result,
            () => settle("fulfilled"),
            (error) => settle("rejected", error),
          )
        )
          settle("unsupported-return");
        return result;
      } catch (error) {
        settle("threw", error);
        throw error;
      }
    });
  }
}
export function observeFailureInflater(
  inflater: any,
  owned: Uint8Array,
  start: number,
) {
  if (!activeDispatch || readers.has(inflater) || snapshot.readers.length >= 40)
    throw new Error("Failure lifecycle inflater scope refused");
  const wireSha256 = digest(owned);
  const matches = activeDispatch.messages.filter(
    (message) => message.wireSha256 === wireSha256,
  );
  if (matches.length !== 1) violate("reader-wire-association-ambiguous");
  const state: ReaderObservation = {
    id: snapshot.readers.length + 1,
    dispatch: activeDispatch.ordinal,
    messageId: matches.length === 1 ? matches[0]!.id : null,
    wireSha256,
    wireBytes: owned.length,
    headerBytes: start,
    nextCalls: 0,
    pendingNext: 0,
    nextSettled: 0,
    nextDone: 0,
    nextRejected: 0,
    closes: 0,
    nativeEnds: 0,
    cancelCalls: 0,
    returnCalls: 0,
    cancel: null,
    advancementsAfterCancel: 0,
    current: {
      submitted: 0,
      consumed: 0,
      produced: 0,
      drained: 0,
      writes: 0,
      reads: 0,
      ends: 0,
      destroys: 0,
      queued: 0,
      destroyed: false,
    },
  };
  const sample = (): InflaterSnapshot => {
    state.current.consumed = inflater.bytesWritten;
    state.current.queued = inflater.readableLength;
    state.current.destroyed = inflater.destroyed === true;
    if (state.cancel?.after) {
      for (const key of [
        "submitted",
        "consumed",
        "produced",
        "drained",
        "writes",
        "reads",
        "ends",
      ] as const)
        if (state.current[key] !== state.cancel.before[key]) {
          state.advancementsAfterCancel++;
          break;
        }
    }
    return { ...state.current };
  };
  readers.set(inflater, { state, sample });
  snapshot.readers.push(state);
  readerUpdates.push(sample);
  for (const method of ["write", "end", "read", "push", "destroy"] as const) {
    wrap(inflater, method, (original, receiver, args) => {
      if (receiver !== inflater) violate("inflater-receiver-changed");
      if (method === "write") {
        state.current.writes++;
        state.current.submitted += args[0]?.byteLength ?? 0;
      }
      if (method === "end") state.current.ends++;
      if (method === "destroy") state.current.destroys++;
      if (method === "push" && args[0] !== null)
        state.current.produced += args[0]?.byteLength ?? 0;
      const result = Reflect.apply(original, receiver, args);
      if (method === "read" && result !== null) {
        state.current.reads++;
        state.current.drained += result.byteLength;
      }
      sample();
      return result;
    });
  }
  inflater.on("close", () => {
    state.closes++;
    sample();
  });
  inflater.on("end", () => {
    state.nativeEnds++;
    sample();
  });
}
export function observeFailureReader(reader: any, inflater: any) {
  const observed = readers.get(inflater);
  if (!observed) throw new Error("Failure lifecycle inflater absent");
  const { state, sample } = observed;
  for (const method of ["next", "cancel", "return"] as const) {
    wrap(reader, method, (original, receiver, args) => {
      if (receiver !== reader) violate("reader-receiver-changed");
      if (method === "next") {
        state.nextCalls++;
        state.pendingNext++;
      } else {
        if (method === "cancel") state.cancelCalls++;
        else state.returnCalls++;
        if (!state.cancel)
          state.cancel = {
            sequence: tick(),
            kind: method,
            pendingNext: state.pendingNext,
            before: sample(),
            after: null,
          };
      }
      try {
        const result = Reflect.apply(original, receiver, args);
        if (method === "next") {
          if (
            !watch(
              result,
              (value) => {
                state.pendingNext--;
                state.nextSettled++;
                if (value?.done === true) state.nextDone++;
                sample();
              },
              () => {
                state.pendingNext--;
                state.nextSettled++;
                state.nextRejected++;
                sample();
              },
            )
          )
            violate("reader-next-return-invalid");
        } else if (state.cancel && !state.cancel.after)
          state.cancel.after = sample();
        return result;
      } catch (error) {
        if (method === "next") {
          state.pendingNext--;
          state.nextSettled++;
          state.nextRejected++;
        }
        throw error;
      }
    });
  }
}
export function readFailureLifecycle(): FailureLifecycleSnapshot {
  for (const update of clientUpdates) update();
  for (const update of readerUpdates) update();
  return JSON.parse(JSON.stringify(snapshot));
}
