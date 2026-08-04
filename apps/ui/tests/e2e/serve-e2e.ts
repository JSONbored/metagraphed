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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
 * Killing whatever still holds the port is the cleanup, deliberately NOT
 * `detached: true` + a process-group kill. That was the first attempt and it
 * is worse than the problem: a detached child sits outside the group
 * Playwright terminates on teardown, so wrangler and workerd SURVIVE the run
 * (measured: 2 of each still alive after the suite exited) still holding the
 * step's stdio. In CI the job then never finishes -- it waits forever on a
 * pipe nothing will close. The child therefore stays in this process's group
 * where Playwright can reap it, and orphans are handled by port instead.
 */
async function waitForPortFree(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if (await portFree()) return true;
    // Give a graceful exit a moment before resorting to force.
    if (i === 4) killPortHolders();
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function killPortHolders(): void {
  const found = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
  if (found.error || found.status !== 0) return; // No lsof, or nothing listening.
  for (const line of found.stdout.split("\n")) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
      console.error(`[e2e-server] killed stray process ${pid} still holding port ${port}`);
    } catch {
      // Exited between the lookup and the signal.
    }
  }
}

function start(): void {
  const startedAt = Date.now();
  child = spawn(
    "npx",
    ["wrangler", "dev", "-c", "dist/server/wrangler.json", "--port", port, "--local"],
    { stdio: "inherit" },
  );

  child.on("exit", async (code, signal) => {
    if (shuttingDown) return;
    const uptimeMs = Date.now() - startedAt;
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

// Playwright signals the supervisor at the end of the run. Stop supervising
// first, so the child's exit isn't mistaken for a crash and restarted into a
// run that is already over, then make sure nothing is left on the port for
// the next run to trip over.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
    child?.kill(signal);
    killPortHolders();
    process.exit(0);
  });
}

start();
