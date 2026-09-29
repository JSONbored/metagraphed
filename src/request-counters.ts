import { AsyncLocalStorage } from "node:async_hooks";
import { registerModuleStateReset } from "./module-state-registry.ts";

// Failure deltas belong to the response that performed the read. Sharing them
// across the isolate can label healthy data degraded and disable its cache.
const counters = new AsyncLocalStorage<Map<string, number>>();

/** Fresh scope for one HTTP response or one tool in a concurrent MCP batch. */
export function withRequestCounters<T>(run: () => Promise<T>): Promise<T> {
  return counters.run(new Map(), run);
}

/** Keep direct, unscoped reader use compatible with its existing delta API. */
export function createRequestCounter(owner: string) {
  let unscoped = 0;
  registerModuleStateReset(owner, () => {
    unscoped = 0;
  });
  return {
    current(): number {
      const scope = counters.getStore();
      return scope ? (scope.get(owner) ?? 0) : unscoped;
    },
    increment(): void {
      const scope = counters.getStore();
      if (scope) scope.set(owner, (scope.get(owner) ?? 0) + 1);
      else unscoped += 1;
    },
  };
}
