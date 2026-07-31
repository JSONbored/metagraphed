// Global setup file: restore module-level state between test FILES.
//
// Under vitest's default per-file isolation this is a no-op safety net — each
// file already gets a fresh module registry. It becomes load-bearing under
// `isolate: false` (metagraphed#8922), where every file in a worker shares one
// module registry and the Worker modules' process-lifetime state (in-isolate
// memos, circuit-breaker maps, the configureAnalytics/configureRpcProxy/
// configureAnalyticsRoutes DI seams) turns into a cross-file channel.
//
// afterAll, not afterEach: several files wire their fakes ONCE at module scope
// (tests/request-handlers-analytics.test.ts, tests/global-incidents-feed-source
// .test.ts) and rely on that wiring for every test in the file. Resetting per
// test would clobber them. Per file is the exact granularity the shared module
// registry needs — a file's mutations must not outlive the file.
import { afterAll, vi } from "vitest";

import { resetModuleState } from "../../src/module-state-registry.ts";

afterAll(() => {
  resetModuleState();
  // Timers are the other process-lifetime global that `isolate: false` turns
  // into a cross-file channel: ten files install vi.useFakeTimers(), and if any
  // of them fails to restore -- an assertion throwing past an inline
  // vi.useRealTimers() is enough -- every LATER file in that worker inherits a
  // clock nobody advances, and anything awaiting a real setTimeout hangs until
  // its timeout no matter how short a sleep it asked for.
  //
  // This is a defensive invariant, NOT the fix for the deliverChangeEvent retry
  // timeouts it was first written for. That hypothesis was wrong: this guard
  // reports zero leaks across a full green run, so no file was leaking a fake
  // clock and something else stopped those timers from firing. The webhook
  // tests were fixed by injecting a sleepFn instead. Kept because the failure
  // mode is real, silent, and expensive to diagnose from the far end -- the
  // warning below turns it into an attributable error instead of a mystery
  // 30s timeout in an unrelated file.
  //
  // Unconditional: vi.useRealTimers() is a no-op when timers are already real.
  // Reported before restoring, because the restore is what keeps the suite
  // green and would otherwise hide the file that needs fixing.
  if (vi.isFakeTimers()) {
    console.warn(
      "reset-module-state: a test file finished with FAKE timers still " +
        "installed. Under isolate:false that clock is inherited by the next " +
        "file in this worker, where anything awaiting a real setTimeout hangs " +
        "until its timeout. Restore them in a finally, not after the last " +
        "assertion.",
    );
  }
  vi.useRealTimers();
});
