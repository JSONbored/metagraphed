// No test may reach a host we do not operate.
//
// THE BUG THIS EXISTS TO STOP, which happened: a handler was switched from
// reading a served artifact to `loadNetworkParameters`, which reads a public
// Bittensor RPC. Its tests started making live calls to somebody else's node.
// They PASSED IN ISOLATION -- the node answered -- and failed only under file
// parallelism, which is the worst way to find out: the symptom looks like flake
// and the cause looks like nothing.
//
// The convention was already right (`withFetchStub` in subnet-burn.test.ts, the
// inline stub in account-balance-loader.test.ts). It was simply unenforced, and
// an unenforced convention is one PR away from being untrue.
//
// ## Why this cooperates with per-test stubs rather than replacing them
//
// Most tests that exercise an outbound loader install their own
// `globalThis.fetch` and assert on the request body. That is the right pattern
// and this guard must not fight it: it snapshots the ORIGINAL fetch and only
// refuses calls that reach THAT. A test which has replaced the global never
// touches this code at all, so nothing about those tests changes.
//
// The guard is restored before each test, so a test that replaces the global
// and forgets to restore it cannot leak its stub into the next file's tests --
// a second failure mode the old convention also left open.
import { beforeEach } from "vitest";

/** Hosts a test may legitimately reach: none. The loopback entries exist for
 * the workerd/miniflare harnesses, which serve the worker under test locally
 * rather than calling anybody's API. */
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

function hostOf(input: unknown): string | null {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as Request | undefined)?.url ?? "");
    if (!raw) return null;
    // A relative URL cannot leave the process; it is resolved by whatever
    // harness is serving it.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

const original = globalThis.fetch;

const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = hostOf(input);
  if (host !== null && !ALLOWED_HOSTS.has(host)) {
    throw new Error(
      `Outbound network call to ${host} from a test.\n\n` +
        "Tests must not depend on a host we do not operate: the result then " +
        "depends on whether that host answered, which is how a live-RPC read " +
        "reached this suite and showed up as parallel-run flake.\n\n" +
        "Fix it one of two ways:\n" +
        "  - inject the loader (preferred -- see handleSubnetOwnerCut's " +
        "`deps.loadParams`), so the code under test never builds a request; or\n" +
        "  - stub `globalThis.fetch` for the test (see withFetchStub in " +
        "tests/subnet-burn.test.ts), which also lets you assert the request.",
    );
  }
  return original(input as never, init as never);
}) as typeof fetch;

globalThis.fetch = guarded;

// Restore between tests so one test's stub cannot silently serve the next.
beforeEach(() => {
  globalThis.fetch = guarded;
});

/** Exported for the test that proves this guard can fail. */
export const __guard = { guarded, original, hostOf };
