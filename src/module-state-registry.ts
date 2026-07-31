// Registry of module-level mutable state that outlives a single test file.
//
// The Worker modules deliberately keep process-lifetime state: in-isolate memos
// (readHealthMetaKv, latestPointer), circuit-breaker health maps (RPC_HEALTH),
// and dependency-injection seams wired once at api.ts load
// (configureAnalytics/configureRpcProxy/configureAnalyticsRoutes). On a real
// isolate that is exactly right — it is what makes a warm isolate cheap.
//
// Under vitest's default per-file isolation that state is invisible to tests:
// every file gets a fresh module registry, so whatever a file mutates dies with
// it. With `isolate: false` (metagraphed#8922 — it cuts the coverage pass CPU by
// ~72%) the module registry is shared by every file in a worker, and that same
// state becomes a cross-file channel:
//
//   tests/request-handlers-analytics-routes.test.ts installs a fake
//   `readHealthMetaKv` returning last_run_at=2026-06-24 via
//   configureAnalyticsRoutes() in a beforeEach, and never restores it. The next
//   file to run in that worker inherits the fake, so
//   tests/health-serving.test.ts's uptime route observes 2026-06-24 where its
//   own fixture says 2026-06-22.
//
// Rather than 25 ad-hoc test-only exports, each module owning such state
// registers ONE reset here at module scope, and tests/setup/reset-module-state.ts
// calls resetModuleState() in an afterAll — so a file's mutations never outlive
// the file. scripts/validate-module-state-resets.ts computes the set of modules
// declaring module-level mutable state and fails when one has not registered,
// so this cannot silently rot as modules are added.
//
// Resets run in registration order, which is module-evaluation order. A reset
// must therefore be self-contained: it may not depend on another module's reset
// having already run.

type ModuleStateReset = () => void;

const moduleStateResets = new Map<string, ModuleStateReset>();

/**
 * Register a module's state reset. `key` is the module's repo-relative path
 * (e.g. "workers/storage.ts") — re-registering the same key replaces the prior
 * reset rather than accumulating duplicates, so a module re-evaluated inside a
 * test (vi.resetModules) never queues two resets.
 */
export function registerModuleStateReset(
  key: string,
  reset: ModuleStateReset,
): void {
  moduleStateResets.set(key, reset);
}

/**
 * Restore every registered module to its post-load baseline. Called between test
 * FILES (not between tests) — a file's own beforeEach/afterEach still owns
 * within-file setup, and resetting per test would clobber the files that wire
 * their fakes once at module scope.
 */
export function resetModuleState(): void {
  for (const reset of moduleStateResets.values()) reset();
}

/** The registered module keys, sorted — used by the validator and its tests. */
export function registeredModuleStateKeys(): string[] {
  return [...moduleStateResets.keys()].sort();
}
