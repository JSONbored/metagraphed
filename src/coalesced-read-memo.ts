/** Completed and pending reads share the existing TTL and environment identity.
 * Null/error results do not stay sticky. A late expired/reset flight cannot
 * delete or replace the newer entry that owns that environment. */
export function coalescedReadMemo<E extends object, T>(
  load: (env: E) => Promise<T | null>,
  ttlMs: number,
) {
  let entries = new WeakMap<
    E,
    { expiresAt: number; promise: Promise<T | null> }
  >();
  return {
    read(env: E, now = Date.now()): Promise<T | null> {
      const existing = entries.get(env);
      if (existing && now < existing.expiresAt) return existing.promise;
      const entry = {
        expiresAt: now + ttlMs,
        promise: Promise.resolve(null) as Promise<T | null>,
      };
      entry.promise = Promise.resolve()
        .then(() => load(env))
        .then(
          (value) => {
            if (value === null && entries.get(env) === entry)
              entries.delete(env);
            return value;
          },
          (error) => {
            if (entries.get(env) === entry) entries.delete(env);
            throw error;
          },
        );
      entries.set(env, entry);
      return entry.promise;
    },
    reset() {
      entries = new WeakMap();
    },
  };
}
