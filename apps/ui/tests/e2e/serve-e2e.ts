#!/usr/bin/env node
// Supervisor for the e2e `wrangler dev` server.
//
// WHY THIS EXISTS
//
// `wrangler dev` exits mid-run, killing the whole e2e suite. The comment at
// the top of playwright.config.ts recorded the symptom (a bare `✘ [ERROR]`
// with an empty message, then ERR_CONNECTION_REFUSED for every remaining
// route) and noted the cause was unknown, pending the wrangler log CI
// uploads on failure. That log says:
//
//   Error in ProxyController: Error inside ProxyWorker
//     at ProxyController2.emitErrorEvent (wrangler/wrangler-dist/cli.js)
//     at async #handleLoopbackCustomFetchService (miniflare/dist/src/index.js)
//     cause: { message: 'Network connection lost.' }
//
// The ProxyWorker's connection drops, and wrangler escalates that to a fatal
// error and tears the dev server down. Nothing about it is specific to this
// app -- it happens partway through a run of independent page loads, on main
// as readily as on a branch, and no assertion ever fails. A browser
// automation harness drops connections constantly (a navigation supersedes
// in-flight requests, a context closes with requests outstanding), so the
// trigger is ordinary and unavoidable from this side.
//
// What IS ours is the blast radius. One dropped connection ~60s into a
// ~4-minute run currently costs every test after it, retries included,
// because the port simply stops answering. Restarting the process turns that
// back into what it should have been: a couple of retried tests.
//
// This is a MITIGATION, not a diagnosis of a bug in our code, and it is
// deliberately noisy -- each restart prints, so "wrangler is crashing a lot"
// stays visible in the log rather than being silently papered over.
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

const port = process.argv[2];
if (!port) {
  console.error("[e2e-server] usage: node tests/e2e/serve-e2e.ts <port>");
  process.exit(1);
}

// A crash loop must fail the run rather than spin until Playwright's
// webServer timeout, which would report "server never came up" and hide a
// real problem (a missing build, a port already taken, a broken config).
// Distinguished by uptime: a server that ran for a while and died is the
// ProxyWorker crash this exists for; one that dies immediately, repeatedly,
// is broken and should say so.
const MAX_RESTARTS = 10;
const FAST_EXIT_MS = 10_000;
const FAST_EXIT_LIMIT = 3;

let child: ChildProcess | null = null;
let restarts = 0;
let consecutiveFastExits = 0;
let shuttingDown = false;

/** Resolves true once nothing is listening on the port. */
function portFree(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: Number(port) })
      .on("connect", () => {
        socket.destroy();
        resolve(false);
      })
      .on("error", () => resolve(true));
  });
}

/**
 * wrangler runs the actual server in a `workerd` CHILD, and that child can
 * outlive it -- so a restart races the corpse for the port and loses with
 * "Address already in use", which the fast-exit guard then (correctly, but
 * unhelpfully) reports as a broken server. Verified by killing wrangler and
 * watching the orphan keep serving 200s on the port while three restarts
 * failed to bind.
 *
 * So: the child is spawned into its OWN process group, the whole group is
 * reaped on an unexpected exit, and the restart waits for the port to
 * actually come free rather than assuming it has.
 */
async function waitForPortFree(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if (await portFree()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function reapGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone, or never had a group -- nothing to clean up.
  }
}

function start(): void {
  const startedAt = Date.now();
  child = spawn(
    "npx",
    ["wrangler", "dev", "-c", "dist/server/wrangler.json", "--port", port, "--local"],
    { stdio: "inherit", detached: true },
  );

  child.on("exit", async (code, signal) => {
    if (shuttingDown) return;
    const uptimeMs = Date.now() - startedAt;
    reapGroup(child?.pid);
    if (!(await waitForPortFree())) {
      console.error(
        `[e2e-server] wrangler exited but port ${port} is still held after 15s -- ` +
          `something outlived the process group and the restart cannot bind.`,
      );
      process.exit(code ?? 1);
    }
    consecutiveFastExits = uptimeMs < FAST_EXIT_MS ? consecutiveFastExits + 1 : 0;

    if (consecutiveFastExits >= FAST_EXIT_LIMIT) {
      console.error(
        `[e2e-server] wrangler exited ${consecutiveFastExits}x within ${FAST_EXIT_MS}ms ` +
          `(last: code=${code} signal=${signal}). That is a broken server, not the ` +
          `ProxyWorker crash this supervisor covers -- check that \`npm run build:worker\` ` +
          `has produced dist/server/wrangler.json and that port ${port} is free.`,
      );
      process.exit(code ?? 1);
    }

    if (restarts >= MAX_RESTARTS) {
      console.error(
        `[e2e-server] wrangler has crashed ${restarts} times in one run; giving up. ` +
          `The suite result is not trustworthy -- treat this as a failure, not a flake.`,
      );
      process.exit(code ?? 1);
    }

    restarts += 1;
    console.error(
      `[e2e-server] wrangler exited (code=${code} signal=${signal}) after ${uptimeMs}ms ` +
        `-- restarting (${restarts}/${MAX_RESTARTS}). Expected cause: ProxyController ` +
        `"Network connection lost". Tests hitting the gap retry.`,
    );
    start();
  });
}

// Playwright signals the supervisor at the end of the run; the group kill is
// what stops `workerd` being left behind holding the port for the next one.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
    reapGroup(child?.pid);
    process.exit(0);
  });
}

start();
