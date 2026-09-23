import type { R2SqlReader } from "./r2-sql.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

interface ProjectionComputeContext {
  query: R2SqlReader;
  now: number;
}

// A native producer supplies its pinned query engine and one capture time.
// Context is invocation-local; bindings cannot install an executable callback.
let contexts = new WeakMap<Env, ProjectionComputeContext>();
registerModuleStateReset("src/projection-compute-context.ts", () => {
  contexts = new WeakMap();
});

export function projectionComputeEnv(
  env: Env,
  context: ProjectionComputeContext,
): Env {
  if (!Number.isSafeInteger(context.now) || context.now < 0)
    throw new RangeError("Invalid projection capture time");
  const scoped = { ...env };
  contexts.set(scoped, context);
  return scoped;
}

export function projectionQuery(env: Env): R2SqlReader | undefined {
  return contexts.get(env)?.query;
}

export function projectionNow(env: Env): number {
  return contexts.get(env)?.now ?? Date.now();
}
