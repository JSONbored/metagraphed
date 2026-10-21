/**
 * Inactive primitive fixture. Receives compressed bytes, never original data.
 * This file is not a Worker entry in any production configuration.
 */
import { createHash } from "node:crypto";
import { readStrictGzip } from "../../src/strict-gzip-reader.ts";
import {
  activate,
  makeObservation,
  type Snapshot,
} from "./strict-gzip-observer.ts";

const turn = (milliseconds = 0) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Lifecycle timeout: ${label}`)),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function reference(wire: Uint8Array, budget: number) {
  // Only enabled for small known decoded outputs, including large metadata.
  // This differential is correctness-only; no memory bound follows from it.
  // The native DecompressionStream is untouched.
  const input = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new Uint8Array(wire));
      controller.close();
    },
  });
  const reader = input.pipeThrough(new DecompressionStream("gzip")).getReader();
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > 262_144 - bytes)
        throw new Error(
          "Reference fixture exceeded its diagnostic size ceiling",
        );
      if (result.value.byteLength > budget - bytes)
        throw new Error("TEST_EXPANSION_LIMIT");
      bytes += result.value.byteLength;
      hash.update(result.value);
    }
    return { ok: true, bytes, sha256: hash.digest("hex") };
  } catch (error) {
    return { ok: false, bytes, error: String(error) };
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "decode";
    const compare = url.searchParams.get("compare") === "1";
    const budget = Number(
      url.searchParams.get("budget") ?? Number.MAX_SAFE_INTEGER,
    );
    const started = Date.now();
    let stallMilliseconds = 0;
    const wire = new Uint8Array(await request.arrayBuffer());
    if (compare && wire.byteLength > 3_145_728)
      throw new Error("Reference input exceeds diagnostic metadata ceiling");
    const observation = makeObservation();
    const pendingMode = mode === "pending-return" || mode === "pending-cancel";
    if (pendingMode) observation.holdCallbacks();
    activate(observation);
    const hash = createHash("sha256");
    let iterator: ReturnType<typeof readStrictGzip> | undefined;
    let bytes = 0;
    let reads = 0;
    let ok = false;
    let cancelled = false;
    let error: string | undefined;
    let pendingTest: Record<string, unknown> | undefined;
    let refusal:
      | {
          overflowBytes: number;
          before: Snapshot;
          immediatelyAfterCancel: Snapshot;
          after: Snapshot;
          doneAfterCancel: boolean;
          afterDoneProbe: Snapshot;
          endEventsAtRefusal: number;
        }
      | undefined;
    const stalls: { afterReads: number; samples: Snapshot[] }[] = [];
    let cancellation:
      { before: Snapshot; after: Snapshot; returned: boolean } | undefined;
    try {
      iterator = readStrictGzip(wire);
      if (pendingMode) {
        let settled = false;
        const pending = iterator.next().then(
          (value) => {
            settled = true;
            return value;
          },
          (caught) => {
            settled = true;
            throw caught;
          },
        );
        await within(observation.firstHeldCallback, "first native callback");
        // The held callback belongs to an actual no-output raw write.
        // No native output is fabricated, withheld, or requeued.
        const settledBeforeCancel = settled;
        let concurrentError: string | undefined;
        try {
          await within(iterator.next(), "concurrent next rejection");
        } catch (caught) {
          concurrentError = String(caught);
        }
        observation.state.phase = "cancel";
        const before = observation.snapshot();
        let returned: Promise<IteratorResult<Uint8Array, void>> | undefined;
        if (mode === "pending-return") returned = iterator.return();
        else iterator.cancel();
        const synchronouslyDestroyed = observation.snapshot().destroyed;
        const firstResult = await within(pending, "cancelled pending next");
        const returnResult =
          returned && (await within(returned, "return completion"));
        observation.releaseCallbacks();
        await turn(0);
        pendingTest = {
          settledBeforeCancel,
          concurrentError,
          synchronouslyDestroyed,
          firstDone: firstResult.done,
          returnDone: returnResult?.done,
          nextAfterCancelDone: (await iterator.next()).done,
          before,
          after: observation.snapshot(),
        };
        cancelled = true;
      }
      while (!pendingMode) {
        const next = await iterator.next();
        if (next.done) {
          ok = true;
          break;
        }
        if (next.value.byteLength > budget - bytes) {
          // Proposed consumer policy only. The primitive has no byte budget.
          // Cancel without decoding the tail to replace resource refusal with
          // a later framing error. The old equivalence gate remains failed.
          observation.state.phase = "cancel";
          const before = observation.snapshot();
          const endEventsAtRefusal = observation.state.ends;
          iterator.cancel();
          const immediatelyAfterCancel = observation.snapshot();
          await turn(0);
          await turn(25);
          const after = observation.snapshot();
          const doneAfterCancel = (await iterator.next()).done === true;
          refusal = {
            overflowBytes: next.value.byteLength,
            before,
            immediatelyAfterCancel,
            after,
            doneAfterCancel,
            afterDoneProbe: observation.snapshot(),
            endEventsAtRefusal,
          };
          throw new Error("TEST_EXPANSION_LIMIT");
        }
        bytes += next.value.byteLength;
        reads++;
        hash.update(next.value);
        if (mode === "stall" && [1024, 4096, 8192].includes(reads)) {
          // Snapshot immediately on sink entry, before any settling turn.
          // No iterator.next() is outstanding throughout the complete delay.
          observation.state.phase = "stall";
          const stallStarted = Date.now();
          const samples = [observation.snapshot()];
          for (const delay of [0, 5, 25]) {
            await turn(delay);
            samples.push(observation.snapshot());
          }
          stalls.push({ afterReads: reads, samples });
          stallMilliseconds += Date.now() - stallStarted;
          observation.state.phase = "decode";
        }
        if (mode === "cancel" && reads === 256) {
          observation.state.phase = "cancel";
          const before = observation.snapshot();
          const returned = (await iterator.return()).done === true;
          await turn(25);
          cancellation = { before, after: observation.snapshot(), returned };
          cancelled = true;
          break;
        }
        if (mode === "destroy-error" && reads === 256) {
          observation.destroy(new Error("Synthetic native lifecycle error"));
          // The next demand must reject via the candidate's real error path.
        } else if (mode === "destroy-close" && reads === 256) {
          observation.destroy();
          // No error supplied: exercise close-before-end handling.
        }
      }
    } catch (caught) {
      error = String(caught);
    } finally {
      // Capture deferred native error/close callbacks, with the original
      // listener still installed. This is after operation completion only.
      observation.releaseCallbacks();
      await iterator?.return().catch((caught: unknown) => {
        error ??= String(caught);
      });
      await turn(0);
      await turn(0);
      activate(undefined);
    }
    const last = observation.snapshot();
    return Response.json({
      ok,
      cancelled,
      error,
      bytes,
      reads,
      sha256: hash.digest("hex"),
      stalls,
      cancellation,
      pendingTest,
      refusal,
      last,
      observation: observation.state,
      timing: {
        wallMilliseconds: Date.now() - started,
        intentionalStallMilliseconds: stallMilliseconds,
        meaning: "wall time only; not CPU or whole-isolate peak",
      },
      ...(compare ? { reference: await reference(wire, budget) } : {}),
    });
  },
};
