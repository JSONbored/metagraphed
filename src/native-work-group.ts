export interface NativeWorkOptions {
  name: string;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
}
export interface NativeWorkScope {
  invoke<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    onAbort?: () => void,
  ): Promise<T>;
}

/** Shared bounded lifetime for native queue/scheduled work; never owns a pool. */
export function createNativeWorkGroup(options: NativeWorkOptions) {
  for (const value of [
    options.executionTimeoutMillis,
    options.drainTimeoutMillis,
  ])
    if (!Number.isSafeInteger(value) || value <= 0 || value > 3600000)
      throw new RangeError(
        "Native work deadlines must be positive bounded milliseconds",
      );
  let open = true;
  let drained = false;
  let draining: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let drainReason: Error | undefined;
  const active = new Set<Promise<unknown>>();
  const consumers = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const counts = new Map<string, number>();
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!open)
      return Promise.reject(new Error(`${options.name} transport is closed`));
    const task = Promise.resolve().then(operation);
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => {});
    return task;
  };
  return {
    track,
    get state(): "ready" | "closing" | "closed" {
      return open ? "ready" : drained ? "closed" : "closing";
    },
    run<T>(
      key: string,
      maxConcurrent: number,
      atCapacity: () => T,
      operation: (scope: NativeWorkScope) => Promise<T>,
    ): Promise<T> {
      if (!open)
        return Promise.reject(new Error(`${options.name} transport is closed`));
      if (
        !Number.isSafeInteger(maxConcurrent) ||
        maxConcurrent <= 0 ||
        maxConcurrent > 100
      )
        return Promise.reject(
          new RangeError("Native work concurrency is invalid"),
        );
      if ((counts.get(key) ?? 0) >= maxConcurrent)
        return Promise.resolve(atCapacity());
      counts.set(key, (counts.get(key) ?? 0) + 1);
      let operationDone = false;
      let consumerPending = false;
      let invoked = false;
      let released = false;
      const release = () => {
        if (operationDone && !consumerPending && !released) {
          released = true;
          counts.set(key, counts.get(key)! - 1);
        }
      };
      return track(async () => {
        try {
          return await operation({
            async invoke<T>(
              consume: (signal: AbortSignal) => Promise<T>,
              onAbort?: () => void,
            ): Promise<T> {
              if (invoked || operationDone)
                throw new Error("Native work scope is closed");
              invoked = true;
              consumerPending = true;
              const controller = new AbortController();
              controllers.add(controller);
              if (drainReason) controller.abort(drainReason);
              const pending = Promise.resolve().then(() => {
                if (controller.signal.aborted) throw controller.signal.reason;
                return consume(controller.signal);
              });
              const finished = pending
                .then(
                  () => undefined,
                  () => undefined,
                )
                .finally(() => {
                  controllers.delete(controller);
                  consumers.delete(finished);
                  consumerPending = false;
                  release();
                });
              consumers.add(finished);
              let onSignal!: () => void;
              const aborted = new Promise<never>((_resolve, reject) => {
                onSignal = () => {
                  try {
                    onAbort?.();
                  } finally {
                    reject(controller.signal.reason);
                  }
                };
                if (controller.signal.aborted) onSignal();
                else
                  controller.signal.addEventListener("abort", onSignal, {
                    once: true,
                  });
              });
              const timer = setTimeout(
                () =>
                  controller.abort(
                    new Error(`${options.name} execution deadline exceeded`),
                  ),
                options.executionTimeoutMillis,
              );
              try {
                return await Promise.race([pending, aborted]);
              } finally {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", onSignal);
              }
            },
          });
        } finally {
          operationDone = true;
          release();
        }
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      open = false;
      draining ??= (async () => {
        while (active.size || consumers.size)
          await Promise.allSettled([...active, ...consumers]);
        drained = true;
      })();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          drainReason = new Error(
            `${options.name} drain deadline exceeded; unfinished operations remain`,
          );
          for (const controller of controllers) controller.abort(drainReason);
          reject(drainReason);
        }, options.drainTimeoutMillis);
      });
      closing = Promise.race([draining, deadline]).finally(() =>
        clearTimeout(timer),
      );
      void closing.catch(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}
