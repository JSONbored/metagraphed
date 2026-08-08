// Navigate across a supervised `wrangler dev` restart.
//
// tests/e2e/serve-e2e.ts restarts the dev server when wrangler dies of the
// upstream ProxyController "Network connection lost" crash, and its log line
// promises "Tests hitting the gap retry." That promise was not kept: the port
// stops answering for the seconds the restart takes, `page.goto` fails
// INSTANTLY with ERR_CONNECTION_REFUSED, and Playwright's retry starts soon
// enough to land in the same window and fail identically.
//
// Measured on main (#10013): the sticky-header spec failed on `673f567c`, and
// on its retry, three seconds after
//
//   [e2e-server] wrangler exited (code=1 signal=null) after 226648ms
//     -- restarting (1/10). Expected cause: ProxyController "Network
//     connection lost". Tests hitting the gap retry.
//
// The commit changed only src/mcp-server.ts and three schemas-src files --
// nothing that can affect how a table header pins at 1280px. The next commit
// went green with no fix. A required check that fails on unchanged code spends
// the signal it exists to provide, so the gap is closed here rather than by
// quarantining a spec that was never wrong.
//
// This waits for the restart INSTEAD of failing, and only for the one error
// class that means "nothing is listening yet". Any other navigation failure --
// a 500, a redirect loop, a genuine timeout -- propagates on the first try, so
// a real breakage is never masked into a slow pass.

import type { Page, Response } from "@playwright/test";

/**
 * How long a navigation may wait for the supervisor to bring the server back.
 *
 * Sized from serve-e2e.ts's own restart path, not guessed: `waitForPortFree`
 * polls for up to 15s (killing stray port holders at 2s) before wrangler is
 * even respawned, and booting a Worker plus its assets binding is the slower
 * part after that. 45s covers both with room, and still fails fast enough to
 * be readable when the server is genuinely gone -- the supervisor's own
 * FAST_EXIT_LIMIT is what fails the run in that case.
 */
export const SERVER_RESTART_BUDGET_MS = 45_000;

const POLL_MS = 500;

/**
 * Set once a full budget has elapsed with the server still refusing. Module
 * scope = per Playwright worker process, which is exactly the right blast
 * radius: one worker discovering the server is gone must not make the other
 * three re-derive it, and a fresh run starts fresh.
 *
 * Exported only so the unit test can clear it between cases.
 */
let serverPresumedGone = false;

export function __resetServerPresumedGone(): void {
  serverPresumedGone = false;
}

/**
 * Errors that mean "the port is not answering yet", as opposed to "the server
 * answered and something is wrong".
 *
 * Chromium reports the restart window as ERR_CONNECTION_REFUSED; the other two
 * are what a navigation in flight when wrangler dies surfaces instead, since
 * the socket is torn down mid-response rather than never opened.
 */
const SERVER_DOWN =
  /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ECONNREFUSED|socket hang up/i;

export function isServerUnavailable(error: unknown): boolean {
  return SERVER_DOWN.test(String((error as Error)?.message ?? ""));
}

/**
 * `page.goto`, but tolerant of the supervised restart window.
 *
 * Deliberately NOT applied to navigations a test makes while it has set the
 * context offline on purpose (offline.spec.ts) -- there, a refused connection
 * IS the thing under test, and retrying it would be retrying the assertion.
 */
export async function gotoThroughRestart(
  page: Page,
  url: string,
  options?: Parameters<Page["goto"]>[1],
  budgetMs = SERVER_RESTART_BUDGET_MS,
): Promise<Response | null> {
  // Once the budget has been spent WITHOUT the server returning, it is not
  // restarting -- it is gone. Waiting again on every later navigation turns a
  // dead server into a suite that fails one slow test at a time; measured by
  // killing the port holder mid-run, where each remaining test then took the
  // full 45s. The latch is per worker process (Playwright forks one per
  // worker), so the cost of discovering it is paid at most once each, and it
  // is deliberately NOT reset: nothing in a run brings the server back except
  // the supervisor, and the supervisor returning would have satisfied the wait.
  if (serverPresumedGone) return page.goto(url, options);

  const deadline = Date.now() + budgetMs;
  let attempts = 0;
  for (;;) {
    try {
      return await page.goto(url, options);
    } catch (error) {
      attempts += 1;
      // A failure the server ANSWERED (a 500, a redirect loop, a real timeout)
      // is never retried -- retrying it would turn a breakage into a slow pass.
      if (!isServerUnavailable(error)) throw error;
      if (Date.now() >= deadline) {
        // The full budget elapsed and the port never came back, so this is not
        // a restart. Latch, so the rest of this worker fails fast instead of
        // re-deriving it one budget at a time, and say what we waited for.
        serverPresumedGone = true;
        console.error(
          `[e2e] ${url}: server never came back within ${budgetMs}ms ` +
            `(${attempts} attempts). If serve-e2e.ts logged no restart, this ` +
            `is not the ProxyController crash. Later navigations in this ` +
            `worker will fail fast rather than wait again.`,
        );
        throw error;
      }
      await page.waitForTimeout(POLL_MS);
    }
  }
}
