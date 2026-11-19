// Validation-only runner. Execution launches the focused host/native suites.
import assert from "node:assert/strict";
import { validateServiceReceipt } from "./owner-service.ts";
import { splitOwnerTests, OWNER_TESTS } from "./owner-test-evidence.ts";
import { validateOwnerReceipts } from "./owner-evidence.ts";
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
  FOCUSED_TESTS,
  WRANGLER_BIN_SOURCE,
} from "./verify-candidate.ts";
import { appendBudget, boundedFile } from "./receipt-files.ts";
import {
  RAW_LIMITS,
  aggregateDenials,
  processChildGuardEvidence,
  nativeUnobservedExitCount,
  threadLifecycleEvidence,
  validateCompletionEvidence,
} from "./receipt-policy.ts";

import { THREAD_SOURCE_IDENTITIES } from "./thread-policy.ts";

assert.equal(
  process.version,
  "v22.23.2",
  "Qualification requires the reviewed Node runtime",
);
const here = path.dirname(fileURLToPath(import.meta.url));
assert.equal(
  process.argv.length,
  4,
  "Usage: node run.ts ABSOLUTE_CANDIDATE ABSOLUTE_PINNED_BASE",
);
const {
  root,
  base,
  manifest: expected,
} = verifyCandidate(process.argv[2]!, process.argv[3]!);
const wrangler = path.join(root, "node_modules/wrangler");
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
assert.ok(
  existsSync(path.join(wrangler, "bin/wrangler.js")),
  "Blocked: lockfile-pinned Wrangler is not installed",
);
assert.equal(
  JSON.parse(readFileSync(path.join(wrangler, "package.json"), "utf8")).version,
  "4.129.1",
);
assert.ok(existsSync(vitest), "Blocked: installed Vitest is unavailable");
// --require runs before the worker guard; verify its entire known inert source
// before any Vitest process can execute it or populate environmentData.
assert.equal(
  sha256(
    readFileSync(path.join(root, "node_modules/vitest/suppress-warnings.cjs")),
  ),
  THREAD_SOURCE_IDENTITIES.suppressSha256,
  "Unreviewed preceding Vitest preload",
);
const fixture = path.join(
  root,
  "tests/data-api-sync-quarantine-isolate.test.ts",
);
const fixtureBytes = readFileSync(fixture);
assert.ok(
  fixtureBytes.includes(
    Buffer.from(
      "resource-first malformed tails retry and retain exact native DLQ custody",
    ),
  ),
  "Blocked: reviewed resource-first native additions are not integrated",
);
const receiptRoot = process.env.DECODER_QUALIFICATION_RECEIPTS;
assert.ok(
  receiptRoot && path.isAbsolute(receiptRoot),
  "Set absolute DECODER_QUALIFICATION_RECEIPTS",
);
assert.ok(
  !path
    .resolve(receiptRoot)
    .startsWith(path.resolve(here, "../../..") + path.sep),
  "Receipts must be outside the harness checkout",
);
mkdirSync(receiptRoot, { recursive: true });
const run = mkdtempSync(path.join(receiptRoot, "native-"));
const home = mkdtempSync(path.join(tmpdir(), "decoder-qualification-home-"));
const serviceReceiptPath = process.env.OWNER_SERVICE_RECEIPT;
assert.ok(serviceReceiptPath && path.isAbsolute(serviceReceiptPath));
const serviceReceipt = JSON.parse(
  boundedFile(serviceReceiptPath, 65536).toString(),
);
validateServiceReceipt(serviceReceipt);
writeFileSync(
  path.join(run, "owner-service.json"),
  JSON.stringify(serviceReceipt) + "\n",
  { flag: "wx", mode: 0o600 },
);
const eventsPath = path.join(run, "network-events.ndjson");
const resultPath = path.join(run, "vitest-results.json");
const configPath = path.join(run, "guard-config.json");
writeFileSync(eventsPath, "", { mode: 0o600 });
const lock = JSON.parse(
  readFileSync(path.join(root, "package-lock.json"), "utf8"),
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
    const installed = JSON.parse(
      readFileSync(path.join(root, packagePath, "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(installed.version, lock.packages[packagePath]?.version);
    const binary = realpathSync(path.join(root, packagePath, executable));
    return {
      path: binary,
      sha256: sha256(readFileSync(binary)),
      packagePath,
      version: installed.version,
    };
  },
);
const wranglerBin = realpathSync(path.join(wrangler, "bin/wrangler.js"));
const wranglerCli = realpathSync(path.join(wrangler, "wrangler-dist/cli.js"));
assert.equal(
  sha256(readFileSync(wranglerBin)),
  WRANGLER_BIN_SOURCE.sha256,
  "Blocked: installed Wrangler wrapper differs from the reviewed release source",
);
const preload = pathToFileURL(path.join(here, "guard-preload.ts"));
preload.searchParams.set("config", configPath);
const args = [
  "--import",
  preload.href,
  vitest,
  "run",
  "--config",
  path.join(here, "vitest.config.ts"),
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
  focusedTests: FOCUSED_TESTS,
  ownerTests: OWNER_TESTS,
  coverageScope: ["src/strict-gzip-reader.ts", "src/sync-batch-compress.ts"],
  allowedNativeExecutables,
  wranglerSources: {
    reviewedBinSource: WRANGLER_BIN_SOURCE,
    bin: { path: wranglerBin, sha256: sha256(readFileSync(wranglerBin)) },
    cli: { path: wranglerCli, sha256: sha256(readFileSync(wranglerCli)) },
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
let threads = {
  acceptedThreads: 0,
  completedThreads: 0,
  threadFailures: 0,
  everyThreadGuarded: false,
};
try {
  threads = threadLifecycleEvidence(events);
} catch {
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
  verifyCandidate(root, base, true);
  unchangedCandidate = true;
} catch {
  // Preserve logs and a failed receipt if any pinned input changed during tests.
}
let completionEvidence = false;
try {
  validateCompletionEvidence(
    splitOwnerTests(
      JSON.parse(
        boundedFile(resultPath, RAW_LIMITS["vitest-results.json"]).toString(),
      ),
      root,
    ).focused,
    JSON.parse(
      boundedFile(
        path.join(run, "coverage/coverage-summary.json"),
        RAW_LIMITS["coverage/coverage-summary.json"],
      ).toString(),
    ),
    boundedFile(
      path.join(run, "coverage/lcov.info"),
      RAW_LIMITS["coverage/lcov.info"],
    ).toString(),
    root,
  );
  completionEvidence = true;
} catch {
  // Exit zero without all named tests and coverage is not qualification.
}
let ownerEvidence = false;
try {
  await validateOwnerReceipts(run, root);
  ownerEvidence = true;
} catch {
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
  interceptedWrangler === 2 &&
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
