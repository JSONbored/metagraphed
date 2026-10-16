import { Buffer } from "node:buffer";

/** A byte-preserving KV fixture with independently controllable read visibility. */
export function syncDeadLetterKv() {
  const values = new Map<string, string>();
  const gets: { key: string; type: unknown }[] = [];
  const puts: { key: string; value: string; options: unknown }[] = [];
  const streams: { reads: number; cancels: number; releases: number }[] = [];
  const hooks: {
    read?: (key: string, call: number) => string | null;
    beforePut?: (key: string, value: string, call: number) => void;
    afterPut?: (key: string, value: string, call: number) => void;
    stream?: (value: string) => ReadableStream<Uint8Array>;
  } = {};
  const kv = {
    async get(key: string, type: unknown) {
      gets.push({ key, type });
      const value = hooks.read
        ? hooks.read(key, gets.length)
        : (values.get(key) ?? null);
      if (type !== "stream")
        throw new Error(
          "Quarantine must verify stored bytes with a bounded stream",
        );
      if (value === null) return null;
      const stream =
        hooks.stream?.(value) ??
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from(value));
            controller.close();
          },
        });
      const reader = stream.getReader();
      const calls = { reads: 0, cancels: 0, releases: 0 };
      streams.push(calls);
      return {
        getReader() {
          return {
            read() {
              calls.reads++;
              return reader.read();
            },
            cancel() {
              calls.cancels++;
              return reader.cancel();
            },
            releaseLock() {
              calls.releases++;
              reader.releaseLock();
            },
          };
        },
      };
    },
    async put(key: string, value: string, options?: unknown) {
      puts.push({ key, value, options });
      hooks.beforePut?.(key, value, puts.length);
      values.set(key, value);
      hooks.afterPut?.(key, value, puts.length);
    },
  } as unknown as Pick<KVNamespace, "get" | "put">;
  return { kv, values, gets, puts, streams, hooks };
}
