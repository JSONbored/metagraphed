import path from "node:path";
import { FOCUSED_TESTS } from "./verify-candidate.ts";
import { sanitizeDenial } from "./launch-policy.ts";

export const COVERED_SOURCES = [
  "src/strict-gzip-reader.ts",
  "src/sync-batch-compress.ts",
] as const;
export const RAW_LIMITS = {
  "receipt.json": 128 * 1024,
  "vitest-results.json": 4 * 1024 * 1024,
  "network-events.ndjson": 4 * 1024 * 1024,
  "network-events.ndjson.failed": 64,
  "guard-config.json": 32 * 1024,
  "native-output.txt": 8 * 1024 * 1024,
  "coverage/coverage-summary.json": 32 * 1024,
  "coverage/lcov.info": 1024 * 1024,
} as const;
export const PUBLIC_LIMITS = {
  "qualification-summary.json": 128 * 1024,
  "candidate-coverage.lcov": 1024 * 1024,
} as const;

export const REQUIRED_ASSERTIONS: Record<string, readonly string[]> = {
  "tests/data-api-sync-queue-consumer.test.ts": [
    "refuses before any business write, keeps exact retry bytes, and preserves each malformed tail before DLQ ACK",
    "an unconfirmed custody write never ACKs malformed original bytes",
    "small valid compressed input still writes the identical business rows and ACKs",
    "a rejected malformed-tail delivery does not withhold a valid neighbor",
    "cancels the strict reader before retry and admits a compressed neighbor",
  ],
  "tests/data-api-sync-quarantine-isolate.test.ts": [
    "proposed resource-first malformed tails retry and retain exact native DLQ custody",
  ],
  "tests/strict-gzip-host-guard.test.ts": [
    "refuses empty IPC path with external host before the underlying connector",
    "refuses numeric-string TCP with external host before the underlying connector",
    "refuses TLS and restores the captured synthetic connectors",
  ],
  "tests/sync-batch-strict-reader.test.ts": [
    "cancels before exposing over-budget refusal and never demands the tail",
  ],
};

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid qualification evidence");
}
export function object(value: unknown): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = 10_000_000): number {
  requireValue(
    Number.isSafeInteger(value) &&
      Number(value) >= 0 &&
      Number(value) <= maximum,
  );
  return Number(value);
}
function sourcePath(
  value: unknown,
  root: string,
  allowed: readonly string[],
): string {
  requireValue(typeof value === "string");
  const normalized = path.relative(root, value);
  requireValue(path.isAbsolute(value) && allowed.includes(normalized));
  return normalized;
}

export function validateTestEvidence(value: unknown, root: string) {
  const input = object(value);
  requireValue(input.success === true);
  requireValue(integer(input.numFailedTests) === 0);
  requireValue(integer(input.numPendingTests) === 0);
  requireValue(integer(input.numTodoTests ?? 0) === 0);
  requireValue(integer(input.numFailedTestSuites) === 0);
  requireValue(Array.isArray(input.testResults));
  requireValue(input.testResults.length === FOCUSED_TESTS.length);
  const seen = new Set<string>();
  let total = 0;
  const suites = input.testResults.map((raw: unknown) => {
    const suite = object(raw);
    const file = sourcePath(suite.name, root, FOCUSED_TESTS);
    requireValue(!seen.has(file) && suite.status === "passed");
    seen.add(file);
    requireValue(Array.isArray(suite.assertionResults));
    requireValue(
      suite.assertionResults.length > 0 &&
        suite.assertionResults.length <= 10_000,
    );
    if (file === "tests/strict-gzip-host-guard.test.ts")
      requireValue(suite.assertionResults.length === 18);
    const titles = new Set<string>();
    for (const rawAssertion of suite.assertionResults) {
      const assertion = object(rawAssertion);
      requireValue(
        assertion.status === "passed" && typeof assertion.title === "string",
      );
      titles.add(assertion.title);
    }
    for (const required of REQUIRED_ASSERTIONS[file] ?? [])
      requireValue(titles.has(required));
    total += suite.assertionResults.length;
    return { path: file, passed: suite.assertionResults.length };
  });
  requireValue(integer(input.numPassedTests) === total);
  requireValue(integer(input.numTotalTests) === total);
  return {
    suites: suites.sort((a, b) => a.path.localeCompare(b.path)),
    passed: total,
    failed: 0,
    skipped: 0,
  };
}

function failedSourceFrames(value: unknown, root: string, file: string) {
  if (!Array.isArray(value) || value.length > 100) return [];
  const prefix = path.join(root, file) + ":";
  const frames: { line: number; column: number }[] = [];
  for (const message of value) {
    if (typeof message !== "string" || message.length > 65_536) continue;
    let from = 0;
    for (;;) {
      const at = message.indexOf(prefix, from);
      if (at < 0 || frames.length === 3) break;
      from = at + prefix.length;
      if (at > 0 && !/[\s(]/.test(message[at - 1]!)) continue;
      const match = /^([1-9][0-9]{0,4}):([1-9][0-9]{0,3})(?:\)|\s|$)/.exec(
        message.slice(from),
      );
      if (!match) continue;
      const frame = { line: Number(match[1]), column: Number(match[2]) };
      if (
        !frames.some(
          (row) => row.line === frame.line && row.column === frame.column,
        )
      )
        frames.push(frame);
    }
    if (frames.length === 3) break;
  }
  return frames;
}

/** Diagnostic progress only. Never used to satisfy qualification acceptance. */
export function publicTestProgress(value: unknown, root: string) {
  const input = object(value);
  requireValue(Array.isArray(input.testResults));
  requireValue(input.testResults.length <= FOCUSED_TESTS.length);
  const seen = new Set<string>();
  return input.testResults
    .map((raw: unknown) => {
      const suite = object(raw);
      const file = sourcePath(suite.name, root, FOCUSED_TESTS);
      requireValue(!seen.has(file));
      seen.add(file);
      requireValue(
        Array.isArray(suite.assertionResults) &&
          suite.assertionResults.length <= 10_000,
      );
      requireValue(
        ["passed", "failed", "pending", "skipped"].includes(
          suite.status as string,
        ),
      );
      const assertions = suite.assertionResults;
      let passed = 0,
        failed = 0,
        skipped = 0;
      const passedTitles = new Set<string>();
      for (const rawAssertion of assertions) {
        const assertion = object(rawAssertion);
        if (assertion.status === "passed") {
          passed++;
          if (typeof assertion.title === "string")
            passedTitles.add(assertion.title);
        } else if (assertion.status === "failed") failed++;
        else {
          requireValue(
            ["pending", "skipped", "todo", "disabled"].includes(
              assertion.status as string,
            ),
          );
          skipped++;
        }
      }
      const required = REQUIRED_ASSERTIONS[file] ?? [];
      const requiredPassed = required.filter((title) =>
        passedTitles.has(title),
      ).length;
      const requiredCases = required.map((title, index) => {
        const matches = assertions.filter((raw) => object(raw).title === title);
        if (matches.length !== 1)
          return {
            index,
            status: matches.length ? "ambiguous" : "missing",
            frames: [],
          };
        const assertion = object(matches[0]);
        return {
          index,
          status:
            assertion.status === "passed" || assertion.status === "failed"
              ? assertion.status
              : "skipped",
          frames:
            assertion.status === "failed"
              ? failedSourceFrames(assertion.failureMessages, root, file)
              : [],
        };
      });
      return {
        path: file,
        status:
          suite.status === "failed" || failed > 0
            ? "failed"
            : suite.status === "passed" &&
                passed > 0 &&
                skipped === 0 &&
                requiredPassed === required.length &&
                requiredCases.every((row) => row.status === "passed") &&
                (file !== "tests/strict-gzip-host-guard.test.ts" ||
                  suite.assertionResults.length === 18)
              ? "passed"
              : "incomplete",
        passed,
        failed,
        skipped,
        requiredPassed,
        requiredTotal: required.length,
        requiredCases,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function validateCoverageEvidence(value: unknown, root: string) {
  const input = object(value);
  requireValue(Object.keys(input).length === COVERED_SOURCES.length + 1);
  const report: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    const file =
      key === "total" ? "total" : sourcePath(key, root, COVERED_SOURCES);
    const metricSet = object(raw);
    const metrics: Record<string, unknown> = {};
    for (const metric of ["lines", "statements", "functions", "branches"]) {
      const row = object(metricSet[metric]);
      const total = integer(row.total);
      const covered = integer(row.covered);
      const skipped = integer(row.skipped);
      requireValue(total > 0 && covered <= total && skipped === 0);
      requireValue(
        typeof row.pct === "number" &&
          Number.isFinite(row.pct) &&
          row.pct >= 0 &&
          row.pct <= 100,
      );
      metrics[metric] = { total, covered, skipped, pct: row.pct };
    }
    report[file] = metrics;
  }
  requireValue(Object.hasOwn(report, "total"));
  for (const file of COVERED_SOURCES) requireValue(Object.hasOwn(report, file));
  return report;
}

/** Keep numeric line/branch evidence; omit function names, test names and paths. */
export function redactLcov(input: string, root: string): string {
  requireValue(Buffer.byteLength(input) <= RAW_LIMITS["coverage/lcov.info"]);
  const seen = new Set<string>();
  const output: string[] = [];
  let active = false;
  let lines = 0;
  for (const line of input.split(/\r?\n/)) {
    requireValue(line.length <= 4096);
    if (!line) continue;
    if (line.startsWith("TN:")) {
      output.push("TN:");
    } else if (line.startsWith("SF:")) {
      requireValue(!active);
      const rawFile = line.slice(3);
      const file = COVERED_SOURCES.includes(
        rawFile as (typeof COVERED_SOURCES)[number],
      )
        ? rawFile
        : sourcePath(rawFile, root, COVERED_SOURCES);
      requireValue(!seen.has(file));
      seen.add(file);
      output.push(`SF:${file}`);
      active = true;
      lines = 0;
    } else if (line === "end_of_record") {
      requireValue(active && lines > 0);
      active = false;
      output.push(line);
    } else {
      requireValue(active);
      if (line.startsWith("FN:") || line.startsWith("FNDA:")) continue;
      if (/^(FNF|FNH|LF|LH|BRF|BRH):\d+$/.test(line)) {
        integer(Number(line.split(":")[1]));
        output.push(line);
      } else if (/^DA:\d+,\d+(?:,[a-fA-F0-9]+)?$/.test(line)) {
        const [number, count] = line.slice(3).split(",");
        integer(Number(number));
        integer(Number(count));
        lines++;
        output.push(`DA:${number},${count}`);
      } else if (/^BRDA:\d+,\d+,\d+,(?:\d+|-)$/.test(line)) {
        for (const value of line.slice(5).split(","))
          if (value !== "-") integer(Number(value));
        output.push(line);
      } else {
        throw new Error("Invalid qualification coverage record");
      }
    }
  }
  requireValue(!active && seen.size === COVERED_SOURCES.length);
  return output.join("\n") + "\n";
}

// Reserve one aggregate bucket for excess distinct fixed-code pairs. This
// bounds diagnostic output while preserving the exact total refusal count.
export const MAX_DENIAL_GROUPS = 128;
export function aggregateDenials(events: readonly unknown[]) {
  requireValue(events.length <= 100_000);
  const counts = new Map<
    string,
    ReturnType<typeof sanitizeDenial> & { count: number }
  >();
  for (const raw of events) {
    const event = object(raw);
    let diagnostic = sanitizeDenial(event.operation, event.policyCode);
    let key = `${diagnostic.operation}:${diagnostic.policyCode}`;
    if (!counts.has(key) && counts.size >= MAX_DENIAL_GROUPS - 1) {
      diagnostic = sanitizeDenial(undefined, undefined);
      key = "other:other";
    }
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { ...diagnostic, count: 1 });
  }
  return [...counts.values()].sort((a, b) =>
    `${a.operation}:${a.policyCode}`.localeCompare(
      `${b.operation}:${b.policyCode}`,
    ),
  );
}
function publicDenialCounts(value: unknown, total: number) {
  requireValue(Array.isArray(value) && value.length <= MAX_DENIAL_GROUPS);
  const counts = new Map<
    string,
    ReturnType<typeof sanitizeDenial> & { count: number }
  >();
  let observed = 0;
  for (const raw of value) {
    const row = object(raw);
    const diagnostic = sanitizeDenial(row.operation, row.policyCode);
    const count = integer(row.count, 100_000);
    requireValue(count > 0);
    observed += count;
    requireValue(observed <= 100_000);
    const key = `${diagnostic.operation}:${diagnostic.policyCode}`;
    const existing = counts.get(key);
    if (existing) existing.count += count;
    else counts.set(key, { ...diagnostic, count });
  }
  requireValue(observed === total);
  return [...counts.values()].sort((a, b) =>
    `${a.operation}:${a.policyCode}`.localeCompare(
      `${b.operation}:${b.policyCode}`,
    ),
  );
}

/** Actual Worker lifecycle only; thread-side events never prove process exit. */
export function threadLifecycleEvidence(events: readonly unknown[]) {
  requireValue(events.length <= 100_000);
  const kinds = new Set([
    "thread-launch",
    "thread-guard-start",
    "thread-ready",
    "thread-handshake",
    "thread-terminate-request",
    "thread-error",
    "thread-exit",
    "thread-failure",
  ]);
  const groups = new Map<
    string,
    { event: Record<string, unknown>; index: number }[]
  >();
  const threadIdentities = new Map<string, string>();
  let valid = true;
  let acceptedThreads = 0,
    completedThreads = 0,
    threadFailures = 0;
  const positive = (value: unknown) =>
    Number.isSafeInteger(value) &&
    Number(value) > 0 &&
    Number(value) <= 2_147_483_647;
  for (const [index, raw] of events.entries()) {
    const event = object(raw);
    if (typeof event.kind !== "string" || !event.kind.startsWith("thread-"))
      continue;
    if (!kinds.has(event.kind)) {
      valid = false;
      continue;
    }
    if (event.kind === "thread-launch") acceptedThreads++;
    if (event.kind === "thread-error" || event.kind === "thread-failure") {
      valid = false;
      threadFailures++;
    }
    if (
      !positive(event.ownerPid) ||
      !positive(event.targetThreadId) ||
      event.pid !== event.ownerPid ||
      typeof event.threadLaunchId !== "string" ||
      !new RegExp(`^${event.ownerPid}:thread:[1-9][0-9]{0,5}$`).test(
        event.threadLaunchId,
      )
    ) {
      valid = false;
      continue;
    }
    const threadSide =
      event.kind === "thread-guard-start" || event.kind === "thread-ready";
    // A failure may originate in either isolate; successful evidence has one exact writer.
    if (event.kind === "thread-failure") {
      if (event.threadId !== 0 && event.threadId !== event.targetThreadId)
        valid = false;
    } else if (event.threadId !== (threadSide ? event.targetThreadId : 0))
      valid = false;
    const key = event.threadLaunchId;
    const identity = `${event.ownerPid}:${event.targetThreadId}`;
    if (
      threadIdentities.has(identity) &&
      threadIdentities.get(identity) !== key
    )
      valid = false;
    threadIdentities.set(identity, key);
    const group = groups.get(key) ?? [];
    if (
      group.some(
        (row) =>
          row.event.targetThreadId !== event.targetThreadId ||
          row.event.ownerPid !== event.ownerPid,
      )
    )
      valid = false;
    group.push({ event, index });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const rows = (kind: string) =>
      group.filter((row) => row.event.kind === kind);
    const launch = rows("thread-launch"),
      start = rows("thread-guard-start"),
      ready = rows("thread-ready"),
      handshake = rows("thread-handshake"),
      exit = rows("thread-exit"),
      terminate = rows("thread-terminate-request");
    if (
      [launch, start, ready, handshake, exit].some(
        (rows) => rows.length !== 1,
      ) ||
      terminate.length > 1
    ) {
      valid = false;
      continue;
    }
    const ordered =
      start[0]!.index < ready[0]!.index &&
      ready[0]!.index < handshake[0]!.index &&
      launch[0]!.index < handshake[0]!.index &&
      handshake[0]!.index < exit[0]!.index;
    const requested =
      terminate.length === 1 &&
      terminate[0]!.event.reason === "requested" &&
      terminate[0]!.index > handshake[0]!.index &&
      terminate[0]!.index < exit[0]!.index;
    if (!ordered || (terminate.length && !requested)) valid = false;
    const exitCode = exit[0]!.event.code;
    const clean =
      exit[0]!.event.failed === false &&
      (exitCode === 0 || (exitCode === 1 && requested));
    const failed =
      rows("thread-error").length > 0 || rows("thread-failure").length > 0;
    if (!clean || failed) valid = false;
    if (ordered && clean && !failed && (!terminate.length || requested))
      completedThreads++;
  }
  // At least one real guarded thread must substantiate this new allowance.
  return {
    acceptedThreads,
    completedThreads,
    threadFailures,
    everyThreadGuarded:
      valid &&
      acceptedThreads > 0 &&
      groups.size === acceptedThreads &&
      completedThreads === acceptedThreads,
  };
}

export function processChildGuardEvidence(events: readonly unknown[]) {
  requireValue(events.length <= 100_000);
  const rows = events.map(object);
  const children = rows.filter((event) => event.kind === "node-child");
  return children.every(
    (event) =>
      event.threadId === 0 &&
      typeof event.childPid === "number" &&
      rows.some(
        (start) =>
          start.kind === "guard-start" &&
          start.threadId === 0 &&
          start.pid === event.childPid,
      ) &&
      rows.some(
        (exit) =>
          exit.kind === "guard-exit" &&
          exit.threadId === 0 &&
          exit.pid === event.childPid,
      ) &&
      rows.some(
        (exit) =>
          exit.kind === "node-child-exit" &&
          exit.threadId === 0 &&
          exit.launchId === event.launchId &&
          exit.childPid === event.childPid,
      ),
  );
}

export function nativeUnobservedExitCount(events: readonly unknown[]) {
  requireValue(events.length <= 100_000);
  const rows = events.map(object);
  return rows
    .filter((event) => event.kind === "native-child" && event.threadId === 0)
    .filter(
      (event) =>
        !rows.some(
          (exit) =>
            exit.kind === "native-child-exit" &&
            exit.threadId === 0 &&
            exit.launchId === event.launchId &&
            exit.role === event.role,
        ),
    ).length;
}

const CHECK_NAMES = [
  "coordinatorGuard",
  "workerGuard",
  "wranglerGuard",
  "wranglerCliGuard",
  "everyNodeChildGuarded",
  "everyThreadGuarded",
  "unchangedFixture",
  "unchangedCandidate",
  "completionEvidence",
] as const;

/** No arbitrary error text, arguments, URLs, environment values or log text escapes. */
export function publicRunSummary(value: unknown) {
  const input = object(value);
  requireValue(input.status === "passed" || input.status === "failed");
  const checks: Record<string, boolean> = {};
  for (const key of CHECK_NAMES) {
    requireValue(typeof input[key] === "boolean");
    checks[key] = input[key];
  }
  const code = input.code === null ? null : integer(input.code, 255);
  const deniedAttempts = integer(input.deniedAttempts, 100_000);
  const denialCounts = publicDenialCounts(input.denialCounts, deniedAttempts);
  const interceptedWrangler = integer(input.interceptedWrangler, 100);
  const unobservedNativeExits = integer(input.unobservedNativeExits, 10_000);
  const observedWorkerSigterms = integer(input.observedWorkerSigterms, 10_000);
  requireValue(typeof input.outputLimitExceeded === "boolean");
  requireValue(typeof input.guardRecordingFailed === "boolean");
  const acceptedThreads = integer(input.acceptedThreads, 10_000);
  const completedThreads = integer(input.completedThreads, 10_000);
  const threadFailures = integer(input.threadFailures, 100_000);
  requireValue(completedThreads <= acceptedThreads);
  if (input.everyThreadGuarded)
    requireValue(
      acceptedThreads > 0 &&
        completedThreads === acceptedThreads &&
        threadFailures === 0,
    );
  const outputLimitExceeded = input.outputLimitExceeded;
  const guardRecordingFailed = input.guardRecordingFailed;
  if (input.status === "passed") {
    requireValue(
      code === 0 && input.signal === null && input.launchError === null,
    );
    requireValue(Object.values(checks).every(Boolean));
    requireValue(
      deniedAttempts === 0 &&
        interceptedWrangler === 1 &&
        !outputLimitExceeded &&
        !guardRecordingFailed,
    );
  }
  return {
    status: input.status,
    code,
    signalled: input.signal !== null,
    launchFailed: input.launchError !== null,
    deniedAttempts,
    denialCounts,
    interceptedWrangler,
    unobservedNativeExits,
    observedWorkerSigterms,
    acceptedThreads,
    completedThreads,
    threadFailures,
    outputLimitExceeded,
    guardRecordingFailed,
    checks,
  };
}

export function validateCompletionEvidence(
  tests: unknown,
  coverage: unknown,
  lcov: string,
  root: string,
) {
  return {
    tests: validateTestEvidence(tests, root),
    coverage: validateCoverageEvidence(coverage, root),
    lcov: redactLcov(lcov, root),
  };
}
