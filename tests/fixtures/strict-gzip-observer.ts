/**
 * DRAFT ONLY. Synchronous, test-only observation of the actual native inflater.
 * No TransformStream, output queue, async output tap, or replacement codec.
 * The optional callback gate is used only by separate lifecycle tests.
 */
type Callback = (error?: Error | null) => void;
type Inflater = {
  readableLength: number;
  bytesWritten: number;
  destroyed: boolean;
  write(chunk: Uint8Array, callback: Callback): unknown;
  end(callback: Callback): unknown;
  read(size: number): Uint8Array | null;
  push(chunk: Uint8Array | null, ...args: unknown[]): boolean;
  destroy(error?: Error): unknown;
  on(event: "error", callback: (error: Error) => void): unknown;
  on(event: "readable" | "end" | "close", callback: () => void): unknown;
};

export type Snapshot = {
  submitted: number;
  consumed: number;
  drained: number;
  produced: number;
  writes: number;
  reads: number;
  pending: number;
  queued: number;
  destroyed: boolean;
};

type WriteEvent = Snapshot & {
  operation: "write" | "end";
  phase: string;
  bytes: number;
  at: "call" | "callback" | "throw";
  error?: string;
};

export type Observation = ReturnType<typeof makeObservation>;
let active: Observation | undefined;

export function makeObservation() {
  let inflater: Inflater | undefined;
  let holdCallbacks = false;
  const heldCallbacks: (() => void)[] = [];
  let callbackEntered!: () => void;
  const firstHeldCallback = new Promise<void>((resolve) => {
    callbackEntered = resolve;
  });
  const state = {
    phase: "decode",
    instances: 0,
    headerBytes: 0,
    submitted: 0,
    drained: 0,
    produced: 0,
    writes: 0,
    reads: 0,
    pending: 0,
    maxPending: 0,
    maxInput: 0,
    maxOutput: 0,
    maxPush: 0,
    maxQueued: 0,
    callbacks: 0,
    endCallbacks: 0,
    callbackThrows: [] as string[],
    errors: [] as string[],
    closes: 0,
    ends: 0,
    events: [] as WriteEvent[],
    violations: [] as string[],
  };
  function snapshot(): Snapshot {
    const queued = inflater?.readableLength ?? 0;
    state.maxQueued = Math.max(state.maxQueued, queued);
    return {
      submitted: state.submitted,
      consumed: inflater?.bytesWritten ?? 0,
      drained: state.drained,
      produced: state.produced,
      writes: state.writes,
      reads: state.reads,
      pending: state.pending,
      queued,
      destroyed: inflater?.destroyed ?? false,
    };
  }
  function violate(message: string) {
    if (!state.violations.includes(message)) state.violations.push(message);
  }
  function attach(instance: Inflater, _owned: Uint8Array, start: number) {
    state.instances++;
    inflater = instance;
    state.headerBytes = start;
    if (state.instances !== 1) violate("More than one inflater instance");
    const originalWrite = instance.write;
    const originalEnd = instance.end;
    const originalRead = instance.read;
    const originalPush = instance.push;

    function operation(
      kind: "write" | "end",
      chunk: Uint8Array | undefined,
      callback: Callback,
    ) {
      const bytes = chunk?.byteLength ?? 0;
      const before = snapshot();
      if (before.pending !== 0)
        violate("Overlapping native write/end operations");
      if (before.queued !== 0) violate("Input submitted with output queued");
      if (state.phase !== "decode")
        violate(`Input submitted during ${state.phase}`);
      if (kind === "write") {
        if (bytes > 4096) violate("Native input write exceeds 4096");
        state.writes++;
        state.submitted += bytes;
        state.maxInput = Math.max(state.maxInput, bytes);
      }
      state.pending++;
      state.maxPending = Math.max(state.maxPending, state.pending);
      state.events.push({
        ...snapshot(),
        operation: kind,
        phase: state.phase,
        bytes,
        at: "call",
      });
      let called = false;
      const observedCallback: Callback = (error) => {
        if (called) violate("Native callback invoked more than once");
        called = true;
        state.pending--;
        if (kind === "write") state.callbacks++;
        else state.endCallbacks++;
        state.events.push({
          ...snapshot(),
          operation: kind,
          phase: state.phase,
          bytes,
          at: "callback",
          ...(error ? { error: String(error) } : {}),
        });
        // Preserve native callback timing, arguments, and synchronous stack.
        const forward = () => {
          try {
            callback(error);
          } catch (caught) {
            state.callbackThrows.push(String(caught));
            throw caught;
          }
        };
        if (holdCallbacks) {
          // Lifecycle-only control. Preserve the actual callback and error.
          // The expansion/stall tests never enable this control.
          heldCallbacks.push(forward);
          callbackEntered();
        } else forward();
      };
      try {
        return kind === "write"
          ? originalWrite.call(instance, chunk!, observedCallback)
          : originalEnd.call(instance, observedCallback);
      } catch (error) {
        if (!called) state.pending--;
        state.events.push({
          ...snapshot(),
          operation: kind,
          phase: state.phase,
          bytes,
          at: "throw",
          error: String(error),
        });
        throw error;
      }
    }
    instance.write = function (chunk, callback) {
      return operation("write", chunk, callback);
    };
    instance.end = function (callback) {
      return operation("end", undefined, callback);
    };
    instance.read = function (size) {
      const result = originalRead.call(instance, size);
      if (result !== null) {
        state.reads++;
        state.drained += result.byteLength;
        state.maxOutput = Math.max(state.maxOutput, result.byteLength);
        if (result.byteLength > 8192)
          violate("Native output read exceeds 8192");
      }
      snapshot();
      return result;
    };
    instance.push = function (chunk, ...args) {
      if (chunk !== null) {
        state.produced += chunk.byteLength;
        state.maxPush = Math.max(state.maxPush, chunk.byteLength);
        if (chunk.byteLength > 8192) violate("Native push exceeds 8192");
      }
      const result = originalPush.call(instance, chunk, ...args);
      snapshot();
      return result;
    };
    instance.on("readable", snapshot);
    instance.on("error", (error: Error) => {
      state.errors.push(String(error));
      snapshot();
    });
    instance.on("end", () => {
      state.ends++;
      snapshot();
    });
    instance.on("close", () => {
      state.closes++;
      snapshot();
    });
  }
  return {
    state,
    attach,
    snapshot,
    firstHeldCallback,
    holdCallbacks() {
      holdCallbacks = true;
    },
    releaseCallbacks() {
      holdCallbacks = false;
      for (const callback of heldCallbacks.splice(0)) callback();
    },
    destroy(error?: Error) {
      if (!inflater) throw new Error("Inflater has not been created");
      inflater.destroy(error);
    },
  };
}

export function activate(observation: Observation | undefined) {
  active = observation;
}

/** Inserted immediately after createInflateRaw(), before let at = start. */
export function observeInflater(
  inflater: Inflater,
  owned: Uint8Array,
  start: number,
) {
  if (!active) throw new Error("Missing active test observation");
  active.attach(inflater, owned, start);
}
