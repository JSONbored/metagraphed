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
import { afterAll } from "vitest";

import { resetModuleState } from "../../src/module-state-registry.ts";

afterAll(() => {
  resetModuleState();
});
