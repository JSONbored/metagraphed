import {
  failureReplayFailure,
  withFailureReplayReason,
  withFailureReplayReasonAsync,
} from "./failure-replay-diagnostics.ts";
import {
  failureReplayDiagnostic,
  projectFailureReplayDiagnostics,
  type FailureReplayDiagnostic,
} from "./failure-replay-diagnostics.ts";
// Separate failure phase runner. Baseline run.ts and its 492 assertions remain mandatory.
import assert from "node:assert/strict";
import { validateServiceReceipt } from "./owner-service.ts";
import {
  FAILURE_TEST_FILE,
  validateFailureTestEvidence,
} from "./failure-test-evidence.ts";
import { validateFailurePhaseEvidence } from "./failure-evidence.ts";
import { failurePhase, verifyFailureVariant } from "./failure-variants.ts";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  verifyCandidate,
  sha256,
  WRANGLER_BIN_SOURCE,
} from "./verify-candidate.ts";
import { appendBudget, boundedFile } from "./receipt-files.ts";
import {
  RAW_LIMITS,
  aggregateDenials,
  processChildGuardEvidence,
  nativeUnobservedExitCount,
  threadLifecycleEvidence,
} from "./receipt-policy.ts";

import { THREAD_SOURCE_IDENTITIES } from "./thread-policy.ts";

try {
  try {
    assert.equal(
      process.version,
      "v22.23.2",
      "Qualification requires the reviewed Node runtime",
    );
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-001");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    assert.equal(
      process.argv.length,
      6,
      "Usage: node failure-run.ts VARIANT REFERENCE BASE PHASE",
    );
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-002");
  }
  const phase = failurePhase(process.argv[5]);
  const { root, base, reference } = verifyFailureVariant(
    process.argv[3]!,
    process.argv[2]!,
    process.argv[4]!,
    phase,
    true,
  );
  const expected = withFailureReplayReason("frr-io-001", () =>
    verifyCandidate(reference, base, true),
  ).manifest;
  const wrangler = path.join(root, "node_modules/wrangler");
  const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
  try {
    assert.ok(
      withFailureReplayReason("frr-io-002", () =>
        existsSync(path.join(wrangler, "bin/wrangler.js")),
      ),
      "Blocked: lockfile-pinned Wrangler is not installed",
    );
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-003");
  }
  try {
    assert.equal(
      withFailureReplayReason("frr-io-003", () =>
        JSON.parse(
          withFailureReplayReason("frr-io-004", () =>
            readFileSync(path.join(wrangler, "package.json"), "utf8"),
          ),
        ),
      ).version,
      "4.129.1",
    );
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-004");
  }
  try {
    assert.ok(
      withFailureReplayReason("frr-io-005", () => existsSync(vitest)),
      "Blocked: installed Vitest is unavailable",
    );
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-005");
  }
  // --require runs before the worker guard; verify its entire known inert source
  // before any Vitest process can execute it or populate environmentData.
  try {
    assert.equal(
      sha256(
        withFailureReplayReason("frr-io-006", () =>
          readFileSync(
            path.join(root, "node_modules/vitest/suppress-warnings.cjs"),
          ),
        ),
      ),
      THREAD_SOURCE_IDENTITIES.suppressSha256,
      "Unreviewed preceding Vitest preload",
    );
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-006");
  }
  const fixture = path.join(
    root,
    "tests/data-api-sync-quarantine-isolate.test.ts",
  );
  const fixtureBytes = withFailureReplayReason("frr-io-007", () =>
    readFileSync(fixture),
  );
  try {
    assert.ok(
      fixtureBytes.includes(
        Buffer.from(
          "resource-first malformed tails retry and retain exact native DLQ custody",
        ),
      ),
      "Blocked: reviewed resource-first native additions are not integrated",
    );
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-007");
  }
  const receiptRoot = process.env.DECODER_QUALIFICATION_RECEIPTS;
  try {
    assert.ok(
      receiptRoot && path.isAbsolute(receiptRoot),
      "Set absolute DECODER_QUALIFICATION_RECEIPTS",
    );
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-008");
  }
  try {
    assert.ok(
      !path
        .resolve(receiptRoot)
        .startsWith(path.resolve(here, "../../..") + path.sep),
      "Receipts must be outside the harness checkout",
    );
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-009");
  }
  mkdirSync(receiptRoot, { recursive: true });
  const run = mkdtempSync(path.join(receiptRoot, "native-"));
  const home = mkdtempSync(path.join(tmpdir(), "decoder-qualification-home-"));
  const serviceReceiptPath = process.env.OWNER_SERVICE_RECEIPT;
  try {
    assert.ok(serviceReceiptPath && path.isAbsolute(serviceReceiptPath));
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-010");
  }
  const serviceReceipt = withFailureReplayReason("frr-io-008", () =>
    JSON.parse(
      withFailureReplayReason("frr-io-009", () =>
        boundedFile(serviceReceiptPath, 65536),
      ).toString(),
    ),
  );
  withFailureReplayReason("frr-io-010", () =>
    validateServiceReceipt(serviceReceipt),
  );
  writeFileSync(
    path.join(run, "owner-service.json"),
    JSON.stringify(serviceReceipt) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const eventsPath = path.join(run, "network-events.ndjson");
  const resultPath = path.join(run, "vitest-results.json");
  const configPath = path.join(run, "guard-config.json");
  writeFileSync(eventsPath, "", { mode: 0o600 });
  const lock = withFailureReplayReason("frr-io-011", () =>
    JSON.parse(
      withFailureReplayReason("frr-io-012", () =>
        readFileSync(path.join(root, "package-lock.json"), "utf8"),
      ),
    ),
  ) as {
    packages: Record<string, { version: string }>;
  };
  const nativePackages = [
    ["node_modules/@esbuild/linux-x64", "bin/esbuild"],
    ["node_modules/@cloudflare/workerd-linux-64", "bin/workerd"],
    [
      "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64",
      "bin/workerd",
    ],
  ] as const;
  const allowedNativeExecutables = nativePackages.map(
    ([packagePath, executable]) => {
      const installed = withFailureReplayReason("frr-io-013", () =>
        JSON.parse(
          withFailureReplayReason("frr-io-014", () =>
            readFileSync(path.join(root, packagePath, "package.json"), "utf8"),
          ),
        ),
      ) as { version: string };
      try {
        assert.equal(installed.version, lock.packages[packagePath]?.version);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "frr-check-011");
      }
      const binary = withFailureReplayReason("frr-io-015", () =>
        realpathSync(path.join(root, packagePath, executable)),
      );
      return {
        path: binary,
        sha256: sha256(
          withFailureReplayReason("frr-io-016", () => readFileSync(binary)),
        ),
        packagePath,
        version: installed.version,
      };
    },
  );
  const wranglerBin = withFailureReplayReason("frr-io-017", () =>
    realpathSync(path.join(wrangler, "bin/wrangler.js")),
  );
  const wranglerCli = withFailureReplayReason("frr-io-018", () =>
    realpathSync(path.join(wrangler, "wrangler-dist/cli.js")),
  );
  try {
    assert.equal(
      sha256(
        withFailureReplayReason("frr-io-019", () => readFileSync(wranglerBin)),
      ),
      WRANGLER_BIN_SOURCE.sha256,
      "Blocked: installed Wrangler wrapper differs from the reviewed release source",
    );
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "frr-check-012");
  }
  const preload = pathToFileURL(path.join(here, "guard-preload.ts"));
  preload.searchParams.set("config", configPath);
  const args = [
    "--import",
    preload.href,
    vitest,
    "run",
    "--config",
    path.join(here, "failure-vitest.config.ts"),
  ];
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    CI: "true",
    NODE_ENV: "test",
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
    CLOUDFLARE_AUTH_USE_KEYRING: "false",
    WRANGLER_SEND_METRICS: "false",
    DECODER_QUALIFICATION_ROOT: root,
    DECODER_QUALIFICATION_PRELOAD: preload.href,
    DECODER_QUALIFICATION_RESULT: resultPath,
  };
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 1,
        ownerInspector: true,
        root,
        home,
        events: eventsPath,
        wranglerBin,
        wranglerCli,
        allowedNativeExecutables,
        baseEnv: env,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const manifest = {
    status: "running",
    root,
    base,
    expected,
    failurePhase: phase,
    failureTests: [FAILURE_TEST_FILE],
    reference,
    coverageScope: [],
    allowedNativeExecutables,
    wranglerSources: {
      reviewedBinSource: WRANGLER_BIN_SOURCE,
      bin: {
        path: wranglerBin,
        sha256: sha256(
          withFailureReplayReason("frr-io-020", () =>
            readFileSync(wranglerBin),
          ),
        ),
      },
      cli: {
        path: wranglerCli,
        sha256: sha256(
          withFailureReplayReason("frr-io-021", () =>
            readFileSync(wranglerCli),
          ),
        ),
      },
    },
    node: process.version,
    executable: process.execPath,
    args,
    envKeys: Object.keys(env).sort(),
    fixtureSha256: sha256(fixtureBytes),
    scope:
      "Node API guards plus Miniflare outboundService; no kernel/native-child containment",
  };
  const receipt = path.join(run, "receipt.json");
  writeFileSync(receipt, JSON.stringify(manifest, null, 2));
  console.log(`Qualification receipts: ${run}`);
  const log = openSync(path.join(run, "native-output.txt"), "w", 0o600);
  interface Outcome {
    code: number | null;
    signal: NodeJS.Signals | null;
    launchError: string | null;
  }
  let code: number | null = 1;
  let signal: NodeJS.Signals | null = null;
  let launchError: string | null = null;
  let outputLimitExceeded = false;
  let outputBytes = 0;
  let outputWriteFailed = false;
  try {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // Only this freshly created qualification process group is terminated.
      detached: true,
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (killSignal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, killSignal);
      } catch {
        /* Already exited. */
      }
    };
    const capture = (bytes: Buffer) => {
      const budget = appendBudget(
        outputBytes,
        bytes,
        RAW_LIMITS["native-output.txt"],
      );
      outputBytes = budget.used;
      try {
        if (budget.accepted.byteLength) writeSync(log, budget.accepted);
      } catch {
        outputWriteFailed = true;
      }
      if ((budget.exceeded || outputWriteFailed) && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminate("SIGTERM");
        killTimer = setTimeout(() => terminate("SIGKILL"), 2000);
        killTimer.unref();
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const outcome = await new Promise<Outcome>((resolve) => {
      child.once("error", () =>
        resolve({
          code: 1,
          signal: null,
          launchError: "Qualification process did not launch",
        }),
      );
      child.once("close", (exitCode, exitSignal) =>
        resolve({ code: exitCode, signal: exitSignal, launchError: null }),
      );
    });
    if (killTimer) clearTimeout(killTimer);
    ({ code, signal, launchError } = outcome);
  } finally {
    closeSync(log);
    rmSync(home, { recursive: true, force: true });
  }
  interface GuardEvent {
    kind: string;
    entry: string;
    pid: number;
    [key: string]: unknown;
  }
  const events: GuardEvent[] = boundedFile(
    eventsPath,
    RAW_LIMITS["network-events.ndjson"],
  )
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GuardEvent);
  const denied = events.filter((event) => event.kind === "denied");
  const starts = events.filter(
    (event) => event.kind === "guard-start" && event.threadId === 0,
  );
  const coordinatorGuard = starts.some((event) => event.entry === vitest);
  const workerGuard = starts.some((event) =>
    event.entry.endsWith("/vitest/dist/workers/forks.js"),
  );
  const wranglerGuard = starts.some((event) => event.realEntry === wranglerBin);
  const wranglerCliGuard = starts.some(
    (event) => event.realEntry === wranglerCli,
  );
  const everyNodeChildGuarded = processChildGuardEvidence(events);
  const failureReplayDiagnostics: FailureReplayDiagnostic[] = [];
  let threads = {
    acceptedThreads: 0,
    completedThreads: 0,
    threadFailures: 0,
    everyThreadGuarded: false,
  };
  try {
    threads = threadLifecycleEvidence(events);
  } catch (error) {
    failureReplayDiagnostics.push(
      failureReplayDiagnostic(error, "thread-lifecycle")!,
    );
    /* Malformed evidence cannot qualify. */
  }
  // An unref'ed compiler may exit after its owner. Count absent actual exits;
  // positive-thread-ID records cannot impersonate either native-process side.
  const unobservedNativeExits = nativeUnobservedExitCount(events);
  const observedWorkerSigterms = events.filter(
    (event) =>
      event.kind === "guard-signal" &&
      event.threadId === 0 &&
      event.signal === "SIGTERM" &&
      event.exitCode === 143 &&
      event.entry.endsWith("/vitest/dist/workers/forks.js"),
  ).length;
  const interceptedWrangler = events.filter(
    (event) => event.kind === "wrangler-child-preload" && event.threadId === 0,
  ).length;
  const unchangedFixture =
    sha256(readFileSync(fixture)) === manifest.fixtureSha256;
  let unchangedCandidate = false;
  try {
    verifyFailureVariant(reference, root, base, phase, true);
    unchangedCandidate = true;
  } catch (error) {
    failureReplayDiagnostics.push(failureReplayDiagnostic(error, "variant")!);
    // Preserve logs and a failed receipt if any pinned input changed during tests.
  }
  let completionEvidence = false;
  try {
    validateFailureTestEvidence(
      JSON.parse(
        boundedFile(resultPath, RAW_LIMITS["vitest-results.json"]).toString(),
      ),
      root,
      phase,
    );
    completionEvidence = true;
  } catch (error) {
    failureReplayDiagnostics.push(
      failureReplayDiagnostic(error, "test-evidence")!,
    );
    // Exit zero without all named tests and coverage is not qualification.
  }
  let ownerEvidence = false;
  try {
    await validateFailurePhaseEvidence(run, root, phase);
    ownerEvidence = true;
  } catch (error) {
    failureReplayDiagnostics.push(
      failureReplayDiagnostic(error, "owner-evidence")!,
    );
    /* Incomplete owner proof cannot pass. */
  }
  const guardRecordingFailed = existsSync(`${eventsPath}.failed`);
  const passed =
    code === 0 &&
    !signal &&
    !launchError &&
    denied.length === 0 &&
    coordinatorGuard &&
    workerGuard &&
    wranglerGuard &&
    wranglerCliGuard &&
    everyNodeChildGuarded &&
    threads.everyThreadGuarded &&
    interceptedWrangler === 1 &&
    unchangedFixture &&
    unchangedCandidate &&
    completionEvidence &&
    ownerEvidence &&
    !guardRecordingFailed &&
    !outputLimitExceeded;
  writeFileSync(
    receipt,
    JSON.stringify(
      {
        ...manifest,
        status: passed ? "passed" : "failed",
        code,
        signal,
        launchError,
        deniedAttempts: denied.length,
        denialCounts: aggregateDenials(denied),
        coordinatorGuard,
        workerGuard,
        wranglerGuard,
        wranglerCliGuard,
        everyNodeChildGuarded,
        ...threads,
        unobservedNativeExits,
        observedWorkerSigterms,
        interceptedWrangler,
        unchangedFixture,
        unchangedCandidate,
        completionEvidence,
        ownerEvidence,
        ...(!passed
          ? {
              failureReplayDiagnostics: projectFailureReplayDiagnostics(
                undefined,
                failureReplayDiagnostics,
                "failed",
              ),
            }
          : {}),
        guardRecordingFailed,
        outputLimitExceeded,
        outputBytes,
        outputWriteFailed,
      },
      null,
      2,
    ),
  );
  console.log(
    `Qualification ${passed ? "passed" : "failed"}; receipt: ${receipt}`,
  );
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify(failureReplayDiagnostic(error, "runner-setup")));
  process.exitCode = 1;
}
