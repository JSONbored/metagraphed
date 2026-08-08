// A config for TARGETED test runs that do not touch the artifact sandbox.
//
// The main config's globalSetup (tests/setup/artifact-snapshot.ts) rm -rf's and
// re-rsyncs ONE snapshot directory derived deterministically from the repo
// root. Two `vitest run` invocations against the same worktree therefore
// clobber each other's snapshot and both die inside globalSetup, before any
// test executes -- which reads as a suite-wide failure rather than as
// contention.
//
// This drops the globalSetup so a single file can be re-run while something
// else is running. It is NOT a substitute for the real config: the three
// filesystem-mutating suites (artifacts, public-safety, refresh-build-summary)
// need the sandbox and must run under vitest.config.ts.
import base from "./vitest.config.ts";

const baseTest = (base as unknown as { test?: Record<string, unknown> }).test;

export default {
  ...base,
  test: { ...baseTest, globalSetup: [] },
};
