// Poller-container control (#9146) -- the part of the lane that is testable.
//
// SPLIT FROM workers/poller-container.ts ON PURPOSE. That module extends
// `Container` from @cloudflare/containers, which imports `cloudflare:workers`
// -- a module this repo's plain-vitest harness cannot load (no
// @cloudflare/vitest-pool-workers here, same constraint chain-firehose-hub.ts
// documents). Importing the class into a test therefore fails at module load,
// before a single assertion runs.
//
// Rather than mark this function with a v8 ignore and lose its coverage, the
// control logic lives here and imports nothing from the Container runtime.
// The namespace is reached structurally, so every branch -- unbound, wrong
// stub type, boot failure -- is exercised by tests/poller-container.test.ts.

/**
 * Ensure the singleton poller is running. Safe to call on every cron tick.
 *
 * Returns what happened so the cron log distinguishes "already up" from
 * "restarted" -- a container that is restarting every tick is a crash loop,
 * and it looks identical to a healthy one unless the transition is logged.
 */
export async function ensurePollerRunning(env: Env): Promise<{
  ok: boolean;
  detail: string;
}> {
  const ns = env.POLLER_CONTAINER;
  if (!ns) return { ok: false, detail: "POLLER_CONTAINER not bound" };
  try {
    // The binding is declared as a plain DurableObjectNamespace (env-extra.d.ts
    // is a .d.ts and cannot import the class without pulling the Container
    // runtime into every type-only consumer), so the Container-specific method
    // is reached through a narrow structural type rather than a broad `any`.
    const stub = ns.get(ns.idFromName("global")) as unknown as {
      startAndWaitForPorts?: () => Promise<unknown>;
    };
    if (typeof stub.startAndWaitForPorts !== "function") {
      return { ok: false, detail: "stub is not a Container" };
    }
    await stub.startAndWaitForPorts();
    return { ok: true, detail: "running" };
  } catch (error) {
    // Never throw from a cron: one failed tick must not stop the others in
    // the same scheduled handler.
    const detail = String((error as Error)?.message);
    console.error("[poller-container] ensure failed", detail);
    return { ok: false, detail };
  }
}
