// Pure private-inventory and event replay. No process, thread, socket, build,
// service or native owner is created by these synthetic fixtures.
import assert from "node:assert/strict";
import fs, {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  validateFailureGuardEvidence,
  validateFailurePhaseEvidence,
  validateFailureReceiptDirectory,
} from "./failure-evidence.ts";
import { authorizeLaunch, type PolicyContext } from "./launch-policy.ts";
import { failureReplayDiagnostic } from "./failure-replay-diagnostics.ts";
import { FAILURE_PRIVATE_MAX_BYTES } from "./failure-postgres-private.ts";
import { OWNER_BUILD_LIMITS } from "./owner-build-evidence.ts";
import { RAW_LIMITS } from "./receipt-policy.ts";

function temporary(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "failure-evidence-pure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function inventory(t: TestContext) {
  const root = temporary(t),
    run = path.join(root, "native-fixture");
  const build = path.join(run, "owner-builds", "queue");
  mkdirSync(build, { recursive: true });
  for (const name of [
    ...Object.keys(RAW_LIMITS).filter((name) => !name.includes("/")),
    "owner-service.json",
    "owner-queue-failure.json",
    "owner-queue-failure-private.json",
  ])
    writeFileSync(path.join(run, name), "{}\n");
  for (const name of ["manifest.json", "association.bin", "module-000.bin"])
    writeFileSync(path.join(build, name), "synthetic inventory only\n");
  return { root, run, build };
}

test("failure inventory accepts only bounded private names without claiming proof", async (t) => {
  const { root, run } = inventory(t);
  assert.doesNotThrow(() => validateFailureReceiptDirectory(run));
  // Permitted filenames and self-reported success are never native evidence.
  writeFileSync(
    path.join(run, "receipt.json"),
    JSON.stringify({
      status: "passed",
      ownerEvidence: true,
      completionEvidence: true,
      sourceAndBundleValidated: true,
      privateLifecycleRevalidated: true,
    }),
  );
  await assert.rejects(() =>
    validateFailurePhaseEvidence(run, root, "uninstrumented"),
  );
});

for (const unexpected of [
  "owner-queue.json",
  "owner-raw.json",
  "query.txt",
  "private-password.json",
  "module-000.bin",
  "qualification-summary.json",
  "network-events.ndjson.lock",
])
  test(`failure inventory refuses unexpected top-level file ${unexpected}`, (t) => {
    const { run } = inventory(t);
    writeFileSync(path.join(run, unexpected), "private sentinel");
    assert.throws(() => validateFailureReceiptDirectory(run));
  });

for (const unexpected of ["coverage", "extra", "owner-service.json"])
  test(`failure inventory refuses unexpected directory ${unexpected}`, (t) => {
    const { run } = inventory(t),
      target = path.join(run, unexpected);
    rmSync(target, { force: true });
    mkdirSync(target);
    assert.throws(() => validateFailureReceiptDirectory(run));
  });

test("failure inventory refuses a non-directory root and a symlinked run", (t) => {
  const { root, run } = inventory(t),
    alias = path.join(root, "alias");
  assert.throws(() =>
    validateFailureReceiptDirectory(path.join(run, "receipt.json")),
  );
  symlinkSync(run, alias, "dir");
  assert.throws(() => validateFailureReceiptDirectory(alias));
});

for (const relative of [
  "receipt.json",
  "owner-queue-failure-private.json",
  "owner-builds",
  "owner-builds/queue",
  "owner-builds/queue/manifest.json",
  "owner-builds/queue/association.bin",
  "owner-builds/queue/module-000.bin",
])
  test(`failure inventory refuses symlink at ${relative}`, (t) => {
    const { root, run } = inventory(t),
      target = path.join(run, relative);
    const saved = path.join(root, "outside");
    if (relative === "owner-builds" || relative === "owner-builds/queue")
      mkdirSync(saved);
    else writeFileSync(saved, "outside private sentinel");
    rmSync(target, { recursive: true, force: true });
    symlinkSync(saved, target);
    assert.throws(() => validateFailureReceiptDirectory(run));
  });

for (const name of ["raw", "other", "queue-copy"])
  test(`failure inventory refuses extra owner ${name}`, (t) => {
    const { run } = inventory(t);
    mkdirSync(path.join(run, "owner-builds", name));
    assert.throws(() => validateFailureReceiptDirectory(run));
  });

test("failure inventory requires exactly one queue build inventory", (t) => {
  const { run, build } = inventory(t);
  rmSync(build, { recursive: true });
  assert.throws(() => validateFailureReceiptDirectory(run));
  mkdirSync(path.join(run, "owner-builds", "raw"));
  assert.throws(() => validateFailureReceiptDirectory(run));
});

for (const name of [
  "module-0.bin",
  "module-0000.bin",
  "source.map",
  "environment.json",
  "nested",
])
  test(`failure inventory refuses unreviewed build entry ${name}`, (t) => {
    const { run, build } = inventory(t),
      target = path.join(build, name);
    if (name === "nested") mkdirSync(target);
    else writeFileSync(target, "private sentinel");
    assert.throws(() => validateFailureReceiptDirectory(run));
  });

test("failure inventory rejects too few or too many build files", (t) => {
  const { run, build } = inventory(t);
  rmSync(path.join(build, "association.bin"));
  rmSync(path.join(build, "module-000.bin"));
  assert.throws(() => validateFailureReceiptDirectory(run));
  writeFileSync(path.join(build, "association.bin"), "");
  for (let index = 0; index < OWNER_BUILD_LIMITS.files - 2; index++)
    writeFileSync(
      path.join(build, `module-${String(index).padStart(3, "0")}.bin`),
      "",
    );
  assert.doesNotThrow(() => validateFailureReceiptDirectory(run));
  writeFileSync(
    path.join(
      build,
      `module-${String(OWNER_BUILD_LIMITS.files - 2).padStart(3, "0")}.bin`,
    ),
    "",
  );
  assert.throws(() => validateFailureReceiptDirectory(run));
});

for (const [relative, limit] of [
  ["receipt.json", RAW_LIMITS["receipt.json"]],
  ["owner-service.json", 65_536],
  ["owner-queue-failure.json", 65_536],
  ["owner-queue-failure-private.json", FAILURE_PRIVATE_MAX_BYTES],
  ["owner-builds/queue/manifest.json", OWNER_BUILD_LIMITS.manifestBytes],
  ["owner-builds/queue/association.bin", OWNER_BUILD_LIMITS.associationBytes],
  ["owner-builds/queue/module-000.bin", OWNER_BUILD_LIMITS.moduleBytes],
] as const)
  test(`failure inventory refuses oversized ${relative}`, (t) => {
    const { run } = inventory(t);
    // Sparse sizing only; the bounded reader must reject before allocating/reading it.
    truncateSync(path.join(run, relative), limit + 1);
    assert.throws(() => validateFailureReceiptDirectory(run));
  });

for (const relative of [
  "owner-queue-failure-private.json",
  "owner-builds/queue/module-000.bin",
])
  test(`failure inventory refuses FIFO-shaped entry before read at ${relative}`, (t) => {
    const { run } = inventory(t),
      target = path.join(run, relative);
    const directory = path.dirname(target),
      name = path.basename(target);
    const original = fs.readdirSync;
    let encountered = false;
    // Synthetic Dirent: no OS FIFO, subprocess, blocked read or native handle.
    const replacement = t.mock.method(fs, "readdirSync", ((...args: any[]) => {
      const entries = Reflect.apply(original, fs, args) as fs.Dirent[];
      if (String(args[0]) !== directory) return entries;
      return entries.map((entry) => {
        if (entry.name !== name) return entry;
        encountered = true;
        return {
          name,
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isFIFO: () => true,
          isSocket: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
        };
      });
    }) as typeof fs.readdirSync);
    syncBuiltinESMExports();
    try {
      assert.throws(() => validateFailureReceiptDirectory(run));
      assert.equal(encountered, true);
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(
      readFileSync(target, "utf8"),
      relative.endsWith(".bin") ? "synthetic inventory only\n" : "{}\n",
    );
  });

type Event = Record<string, any>;
const guardContext = {
  vitest: "/synthetic/node_modules/vitest/vitest.mjs",
  worker: "/synthetic/node_modules/vitest/dist/workers/forks.js",
  wranglerBin: "/synthetic/node_modules/wrangler/bin/wrangler.js",
  wranglerCli: "/synthetic/node_modules/wrangler/wrangler-dist/cli.js",
};
function guardedEvents(): Event[] {
  const identity = (pid: number, ppid: number, entry: string) => ({
    pid,
    ppid,
    threadId: 0,
    entry,
    realEntry: entry,
  });
  const coordinator = identity(100, 90, guardContext.vitest);
  const worker = identity(123, 100, guardContext.worker);
  const bin = identity(124, 123, guardContext.wranglerBin);
  const cli = identity(125, 124, guardContext.wranglerCli);
  const thread = {
    ...worker,
    ownerPid: 123,
    targetThreadId: 7,
    threadLaunchId: "123:thread:1",
  };
  const threadWriter = {
    threadId: 7,
    entry: "[worker eval]",
    realEntry: "",
  };
  const native = {
    ...worker,
    launchId: "123:2",
    childPid: 300,
    role: "workerd",
    synchronous: false,
  };
  const exits = {
    code: 0,
    signal: null,
    observation: "exit-event",
    synchronous: false,
  };
  const stopped = { denied: 0, threadFailed: false, unobservedNativeExits: 0 };
  return [
    {
      ...coordinator,
      kind: "guard-start",
      role: "coordinator",
      node: "v22.23.2",
    },
    {
      ...coordinator,
      kind: "node-child",
      childPid: 123,
      launchId: "100:1",
      role: "vitest-worker",
      synchronous: false,
    },
    { ...worker, kind: "guard-start", role: "test-worker", node: "v22.23.2" },
    {
      ...worker,
      kind: "node-child",
      childPid: 124,
      launchId: "123:1",
      role: "wrangler-bin",
      synchronous: false,
    },
    { ...worker, kind: "wrangler-child-preload" },
    { ...bin, kind: "guard-start", role: "wrangler-bin", node: "v22.23.2" },
    {
      ...bin,
      kind: "node-child",
      childPid: 125,
      launchId: "124:1",
      role: "wrangler-cli",
      synchronous: false,
    },
    { ...cli, kind: "guard-start", role: "wrangler-cli", node: "v22.23.2" },
    { ...cli, kind: "guard-exit", ...stopped },
    {
      ...bin,
      kind: "node-child-exit",
      childPid: 125,
      launchId: "124:1",
      role: "wrangler-cli",
      ...exits,
    },
    { ...bin, kind: "guard-exit", ...stopped },
    {
      ...worker,
      kind: "node-child-exit",
      childPid: 124,
      launchId: "123:1",
      role: "wrangler-bin",
      ...exits,
    },
    { ...thread, kind: "thread-launch" },
    { ...thread, kind: "thread-guard-start", ...threadWriter },
    { ...thread, kind: "thread-ready", ...threadWriter },
    { ...thread, kind: "thread-handshake" },
    { ...native, kind: "native-child" },
    { ...native, kind: "native-child-exit", ...exits },
    { ...thread, kind: "thread-terminate-request", reason: "requested" },
    { ...thread, kind: "thread-exit", code: 1, failed: false },
    { ...worker, kind: "guard-exit", ...stopped },
    {
      ...coordinator,
      kind: "node-child-exit",
      childPid: 123,
      launchId: "100:1",
      role: "vitest-worker",
      ...exits,
    },
    { ...coordinator, kind: "guard-exit", ...stopped },
  ];
}
const checkGuards = (events: Event[]) =>
  validateFailureGuardEvidence(events, guardContext);

function sourceWorkerLaunchRole() {
  const context: PolicyContext = {
    root: "/synthetic",
    home: "/synthetic-home",
    preload: "file:///synthetic/guard-preload.ts?config=fixture",
    node: "/synthetic/node",
    vitestEntry: guardContext.vitest,
    vitestWorker: guardContext.worker,
    vitestSuppress: "/synthetic/node_modules/vitest/suppress-warnings.cjs",
    wranglerBin: guardContext.wranglerBin,
    wranglerCli: guardContext.wranglerCli,
    role: "coordinator",
    baseEnv: {},
    inheritedEnv: {},
    processArgs: [],
    native: [],
    resolve: (file) => (file === guardContext.worker ? file : null),
    digest: () => assert.fail("No native digest is needed for a Node fork"),
    isEmptyFile: () => assert.fail("No build file is needed for a Node fork"),
  };
  context.baseEnv = {
    PATH: "/usr/bin",
    HOME: context.home,
    XDG_CONFIG_HOME: `${context.home}/config`,
    XDG_CACHE_HOME: `${context.home}/cache`,
    CI: "true",
    NODE_ENV: "test",
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
    CLOUDFLARE_AUTH_USE_KEYRING: "false",
    WRANGLER_SEND_METRICS: "false",
    DECODER_QUALIFICATION_ROOT: context.root,
    DECODER_QUALIFICATION_PRELOAD: context.preload,
    DECODER_QUALIFICATION_RESULT: "/synthetic-receipts/result.json",
  };
  context.inheritedEnv = { ...context.baseEnv };
  // Classify a synthetic call only. No launch adapter or child API is invoked.
  return authorizeLaunch(context, "fork", [
    context.vitestWorker,
    [],
    {
      env: { ...context.baseEnv },
      execArgv: [
        "--experimental-import-meta-resolve",
        "--require",
        context.vitestSuppress,
        "--conditions",
        "node",
        "--conditions",
        "development",
        "--import",
        context.preload,
      ],
      stdio: "pipe",
      serialization: "advanced",
    },
  ]).role;
}

test("failure guard replay separates source-derived launch and child host roles", () => {
  const events = guardedEvents();
  const launchRole = sourceWorkerLaunchRole();
  assert.equal(launchRole, "vitest-worker");
  const launch = events.find(
    (event) => event.kind === "node-child" && event.childPid === 123,
  )!;
  const exit = events.find(
    (event) => event.kind === "node-child-exit" && event.childPid === 123,
  )!;
  const child = events.find(
    (event) => event.kind === "guard-start" && event.pid === 123,
  )!;
  assert.equal(launch.role, launchRole);
  assert.equal(exit.role, launchRole);
  assert.equal(child.role, "test-worker");
  assert.equal(launch.pid, 100);
  assert.equal(child.ppid, launch.pid);
  assert.equal(child.realEntry, guardContext.worker);
  assert.equal(checkGuards(events).everyThreadGuarded, true);
});

function refusesWithCode(events: Event[], code: string) {
  assert.throws(
    () => checkGuards(events),
    (error) => failureReplayDiagnostic(error, "owner-evidence")?.code === code,
  );
}

for (const role of [
  "test-worker",
  "coordinator",
  "wrangler-bin",
  "wrangler-cli",
  "workerd",
  "unreviewed",
  undefined,
])
  test(`worker launch refuses ${String(role)} even with matching actual exit role`, () => {
    const events = guardedEvents();
    for (const event of events)
      if (
        ["node-child", "node-child-exit"].includes(event.kind) &&
        event.childPid === 123
      )
        event.role = role;
    refusesWithCode(events, "fev-check-039");
  });

test("child guard-start cannot reuse the correct launch role", () => {
  const events = guardedEvents();
  events.find(
    (event) => event.kind === "guard-start" && event.pid === 123,
  )!.role = "vitest-worker";
  refusesWithCode(events, "fev-check-030");
});

test("worker actual exit cannot reuse the child host role", () => {
  const events = guardedEvents();
  events.find(
    (event) => event.kind === "node-child-exit" && event.childPid === 123,
  )!.role = "test-worker";
  refusesWithCode(events, "fev-check-044");
});

for (const childPid of [124, 125])
  test(`Wrangler child ${childPid} cannot reuse the Vitest launch classification`, () => {
    const events = guardedEvents();
    for (const event of events)
      if (
        ["node-child", "node-child-exit"].includes(event.kind) &&
        event.childPid === childPid
      )
        event.role = "vitest-worker";
    refusesWithCode(events, "fev-check-039");
  });

test("failure guard replay accepts one observed Wrangler build and one paired actual-shaped thread", () => {
  const events = guardedEvents(),
    before = structuredClone(events);
  const result = checkGuards(events);
  assert.equal(result.acceptedThreads, 1);
  assert.equal(result.completedThreads, 1);
  assert.equal(result.threadFailures, 0);
  assert.equal(result.everyThreadGuarded, true);
  assert.equal(result.unobservedNativeExits, 0);
  assert.equal(
    events.filter((event) => event.kind === "wrangler-child-preload").length,
    1,
  );
  assert.deepEqual(events, before);
});

test("failure guard replay retains unobserved non-owner native exits as diagnostics", () => {
  const events = guardedEvents();
  events.splice(events.length - 3, 0, {
    kind: "native-child",
    pid: 123,
    threadId: 0,
    launchId: "123:3",
    childPid: 301,
    role: "esbuild",
  });
  const result = checkGuards(events);
  assert.equal(result.unobservedNativeExits, 1);
  assert.equal(result.everyThreadGuarded, true);
  // Owner-native exits are required separately by private lifecycle replay.
});

for (const kind of [
  "thread-launch",
  "thread-guard-start",
  "thread-ready",
  "thread-handshake",
  "thread-exit",
])
  for (const change of ["missing", "duplicate"])
    test(`failure guard replay refuses ${change} ${kind}`, () => {
      let events = guardedEvents();
      if (change === "missing")
        events = events.filter((event) => event.kind !== kind);
      else events.push({ ...events.find((event) => event.kind === kind)! });
      assert.throws(() => checkGuards(events));
    });

for (const role of [
  "coordinator",
  "test-worker",
  "wrangler-bin",
  "wrangler-cli",
])
  test(`failure guard replay requires exact ${role} process start and exit`, () => {
    for (const missing of ["start", "exit"]) {
      const events = guardedEvents(),
        start = events.find(
          (event) => event.kind === "guard-start" && event.role === role,
        )!;
      assert.throws(() =>
        checkGuards(
          events.filter(
            (event) =>
              !(event.pid === start.pid && event.kind === `guard-${missing}`),
          ),
        ),
      );
    }
    const events = guardedEvents();
    events.find(
      (event) => event.kind === "guard-start" && event.role === role,
    )!.realEntry += ".unreviewed";
    assert.throws(() => checkGuards(events));
  });

for (const [name, mutate] of Object.entries({
  "caught denial": (events: Event[]) =>
    events.push({ kind: "denied", pid: 123, threadId: 0 }),
  "no Wrangler observation": (events: Event[]) =>
    events.splice(
      events.findIndex((event) => event.kind === "wrangler-child-preload"),
      1,
    ),
  "two Wrangler observations": (events: Event[]) =>
    events.push({
      ...events.find((event) => event.kind === "wrangler-child-preload")!,
    }),
  "thread impersonates Wrangler observation": (events: Event[]) => {
    events.find((event) => event.kind === "wrangler-child-preload")!.threadId =
      7;
  },
  "no process children": (events: Event[]) => {
    for (let index = events.length - 1; index >= 0; index--)
      if (events[index]!.kind === "node-child") events.splice(index, 1);
  },
  "duplicate child launch": (events: Event[]) => {
    events.push({ ...events.find((event) => event.kind === "node-child")! });
  },
  "duplicate child launch ID": (events: Event[]) => {
    const children = events.filter((event) => event.kind === "node-child");
    children[1]!.launchId = children[0]!.launchId;
  },
  "duplicate child PID": (events: Event[]) => {
    const children = events.filter((event) => event.kind === "node-child");
    children[1]!.childPid = children[0]!.childPid;
  },
  "missing Wrangler launch replaced by duplicate worker launch": (
    events: Event[],
  ) => {
    const children = events.filter((event) => event.kind === "node-child");
    Object.assign(children[1]!, children[0]);
  },
  "duplicate child exit": (events: Event[]) => {
    events.push({
      ...events.find((event) => event.kind === "node-child-exit")!,
    });
  },
  "wrong child parent PID": (events: Event[]) => {
    events.find(
      (event) => event.kind === "node-child" && event.role === "wrangler-bin",
    )!.pid = 100;
  },
  "wrong child exit writer PID": (events: Event[]) => {
    events.find((event) => event.kind === "node-child-exit")!.pid = 999;
  },
  "wrong child exit role": (events: Event[]) => {
    events.find((event) => event.kind === "node-child-exit")!.role =
      "test-worker";
  },
  "synchronous return impersonates actual exit": (events: Event[]) => {
    events.find((event) => event.kind === "node-child-exit")!.observation =
      "synchronous-return";
  },
  "synchronous child launch": (events: Event[]) => {
    events.find((event) => event.kind === "node-child")!.synchronous = true;
  },
  "missing actual exit synchronous flag": (events: Event[]) => {
    delete events.find((event) => event.kind === "node-child-exit")!
      .synchronous;
  },
  "latched denial on clean-looking exit": (events: Event[]) => {
    events.find((event) => event.kind === "guard-exit")!.denied = 1;
  },
  "latched thread failure on clean-looking exit": (events: Event[]) => {
    events.find((event) => event.kind === "guard-exit")!.threadFailed = true;
  },
  "duplicate required process start": (events: Event[]) => {
    events.push({ ...events.find((event) => event.kind === "guard-start")! });
  },
  "duplicate required process exit": (events: Event[]) => {
    events.push({ ...events.find((event) => event.kind === "guard-exit")! });
  },
  "missing child exit": (events: Event[]) =>
    events.splice(
      events.findIndex((event) => event.kind === "node-child-exit"),
      1,
    ),
  "thread impersonates child exit": (events: Event[]) => {
    events.find((event) => event.kind === "node-child-exit")!.threadId = 7;
  },
  "wrong child launch pairing": (events: Event[]) => {
    events.find((event) => event.kind === "node-child-exit")!.launchId =
      "124:2";
  },
  "thread impersonates process start": (events: Event[]) => {
    events.find((event) => event.kind === "guard-start")!.threadId = 7;
  },
  "thread impersonates process exit": (events: Event[]) => {
    events.find((event) => event.kind === "guard-exit")!.threadId = 7;
  },
  "different thread owner": (events: Event[]) => {
    events.find((event) => event.kind === "thread-ready")!.ownerPid = 124;
  },
  "different thread identity": (events: Event[]) => {
    events.find((event) => event.kind === "thread-ready")!.targetThreadId = 8;
  },
  "thread error before clean termination": (events: Event[]) =>
    events.splice(18, 0, {
      ...events.find((event) => event.kind === "thread-launch")!,
      kind: "thread-error",
    }),
  "thread failure before clean termination": (events: Event[]) =>
    events.splice(18, 0, {
      ...events.find((event) => event.kind === "thread-launch")!,
      kind: "thread-failure",
    }),
  "unrequested thread exit one": (events: Event[]) =>
    events.splice(
      events.findIndex((event) => event.kind === "thread-terminate-request"),
      1,
    ),
  "unfinished thread": (events: Event[]) =>
    events.splice(
      events.findIndex((event) => event.kind === "thread-exit"),
      1,
    ),
}))
  test(`failure guard replay refuses ${name}`, () => {
    const events = guardedEvents();
    mutate(events);
    assert.throws(() => checkGuards(events));
  });

test("failure guard replay counts two distinct completed thread identities", () => {
  const events = guardedEvents(),
    second = events
      .filter((event) => event.kind.startsWith("thread-"))
      .map((event) => ({
        ...event,
        targetThreadId: 8,
        threadLaunchId: "123:thread:2",
        threadId: event.threadId === 7 ? 8 : 0,
      }));
  events.splice(events.length - 3, 0, ...second);
  const result = checkGuards(events);
  assert.equal(result.acceptedThreads, 2);
  assert.equal(result.completedThreads, 2);
  assert.equal(result.threadFailures, 0);
});

test("failure guard replay refuses empty, malformed and over-budget event arrays", () => {
  for (const value of [
    [],
    [null],
    [true],
    {},
    null,
    [...guardedEvents(), ...Array(100_001).fill({ kind: "ignored" })],
  ])
    assert.throws(() => checkGuards(value as Event[]));
});

test("failure guard replay refuses duplicate or relative expected entrypoint identities", () => {
  assert.throws(() =>
    validateFailureGuardEvidence(guardedEvents(), {
      ...guardContext,
      worker: guardContext.vitest,
    }),
  );
  assert.throws(() =>
    validateFailureGuardEvidence(guardedEvents(), {
      ...guardContext,
      vitest: "vitest.mjs",
    }),
  );
});

for (const role of ["wrangler-bin", "wrangler-cli", "vitest-worker"])
  test(`nonzero ${role} exit cannot qualify`, () => {
    const events = guardedEvents();
    events.find((e) => e.kind === "node-child-exit" && e.role === role)!.code =
      1;
    assert.throws(() => checkGuards(events));
  });
test("worker 143 requires the actual matching SIGTERM observation", () => {
  const events = guardedEvents();
  const exit = events.find(
    (e) => e.kind === "node-child-exit" && e.role === "vitest-worker",
  )!;
  exit.code = 143;
  assert.throws(() => checkGuards(events));
  const start = events.find(
    (e) => e.kind === "guard-start" && e.role === "test-worker",
  )!;
  const signal = {
    ...start,
    kind: "guard-signal",
    signal: "SIGTERM",
    exitCode: 143,
  };
  events.splice(events.indexOf(exit) - 1, 0, signal);
  assert.doesNotThrow(() => checkGuards(events));
  signal.signal = "SIGKILL";
  assert.throws(() => checkGuards(events));
});
test("Node exit signal and spoofed worker signal are refused", () => {
  const events = guardedEvents();
  const exit = events.find(
    (e) => e.kind === "node-child-exit" && e.role === "vitest-worker",
  )!;
  exit.signal = "SIGTERM";
  assert.throws(() => checkGuards(events));
  exit.signal = null;
  exit.code = 143;
  const start = events.find(
    (e) => e.kind === "guard-start" && e.role === "test-worker",
  )!;
  events.splice(events.indexOf(exit) - 1, 0, {
    ...start,
    kind: "guard-signal",
    signal: "SIGTERM",
    exitCode: 143,
    threadId: 1,
  });
  assert.throws(() => checkGuards(events));
});
for (const orphan of [
  {
    kind: "guard-start",
    pid: 900,
    threadId: 0,
    realEntry: "/foreign",
    role: "test-worker",
  },
  {
    kind: "guard-exit",
    pid: 900,
    threadId: 0,
    realEntry: "/foreign",
    denied: 1,
    threadFailed: true,
  },
  {
    kind: "node-child-exit",
    pid: 900,
    threadId: 0,
    launchId: "900:1",
    childPid: 901,
    code: 1,
    signal: null,
  },
  {
    kind: "guard-signal",
    pid: 900,
    threadId: 0,
    signal: "SIGTERM",
    exitCode: 143,
  },
])
  test(`orphan ${orphan.kind} cannot disappear from replay`, () =>
    assert.throws(() => checkGuards([...guardedEvents(), orphan])));

// Source-shaped optional generic exit: the preload records only writer identity
// and counters here, never the launch metadata carried by thread-* records.
function withThreadGuardExit(events = guardedEvents(), threadId = 7) {
  const start = events.find(
    (event) =>
      event.kind === "thread-guard-start" && event.threadId === threadId,
  )!;
  const exit = {
    kind: "guard-exit",
    pid: start.pid,
    ppid: start.ppid,
    threadId: start.threadId,
    entry: start.entry,
    realEntry: start.realEntry,
    denied: 0,
    threadFailed: false,
    unobservedNativeExits: 0,
  };
  const actualExit = events.findIndex(
    (event) =>
      event.kind === "thread-exit" &&
      event.threadLaunchId === start.threadLaunchId,
  );
  events.splice(actualExit, 0, exit);
  return { events, exit };
}

function additionalThreads(events: Event[], count: number) {
  const first = events.filter((event) => event.kind.startsWith("thread-"));
  for (let index = 1; index < count; index++) {
    const thread = first.map((event) => ({
      ...event,
      targetThreadId: 7 + index,
      threadLaunchId: `123:thread:${index + 1}`,
      threadId: event.threadId === 7 ? 7 + index : 0,
    }));
    events.splice(events.length - 3, 0, ...thread);
  }
  return events;
}

for (const count of [1, 2, 4])
  for (const genericCount of new Set([0, 1, count]))
    test(`failure guard replay accepts ${count} actual threads with ${genericCount} optional generic exits`, () => {
      const events = additionalThreads(guardedEvents(), count);
      for (let index = 0; index < genericCount; index++)
        withThreadGuardExit(events, 7 + index);
      const before = structuredClone(events);
      const result = checkGuards(events);
      assert.equal(result.acceptedThreads, count);
      assert.equal(result.completedThreads, count);
      assert.equal(result.everyThreadGuarded, true);
      assert.equal(result.threadFailures, 0);
      assert.equal(result.unobservedNativeExits, 0);
      assert.equal(
        events.filter((event) => event.kind === "guard-start").length,
        4,
      );
      assert.equal(
        events.filter(
          (event) => event.kind === "guard-exit" && event.threadId === 0,
        ).length,
        4,
      );
      assert.equal(
        events.filter((event) => event.kind === "node-child-exit").length,
        3,
      );
      assert.deepEqual(events, before);
    });

test("optional natural thread exit can precede the parent handshake but never its actual exit", () => {
  const { events, exit } = withThreadGuardExit();
  events.splice(events.indexOf(exit), 1);
  events.splice(
    events.findIndex((event) => event.kind === "thread-handshake"),
    0,
    exit,
  );
  events.splice(
    events.findIndex((event) => event.kind === "thread-terminate-request"),
    1,
  );
  events.find((event) => event.kind === "thread-exit")!.code = 0;
  assert.equal(checkGuards(events).completedThreads, 1);
});

test("same thread ID in different process identities is independently paired", () => {
  const { events } = withThreadGuardExit();
  const first = events.filter((event) => event.kind.startsWith("thread-"));
  const second: Event[] = first.map((event) => ({
    ...event,
    pid: 125,
    ppid: 124,
    ownerPid: 125,
    threadLaunchId: "125:thread:1",
    ...(event.threadId === 0
      ? { entry: guardContext.wranglerCli, realEntry: guardContext.wranglerCli }
      : {}),
  }));
  const cliExit = events.findIndex(
    (event) => event.kind === "guard-exit" && event.pid === 125,
  );
  events.splice(cliExit, 0, ...second);
  // Select the new process explicitly; no PID-free thread-ID matching.
  const start = second.find((event) => event.kind === "thread-guard-start")!;
  const actualExit = second.find((event) => event.kind === "thread-exit")!;
  events.splice(events.indexOf(actualExit), 0, {
    kind: "guard-exit",
    pid: start.pid,
    ppid: start.ppid,
    threadId: start.threadId,
    entry: start.entry,
    realEntry: "",
    denied: 0,
    threadFailed: false,
    unobservedNativeExits: 0,
  });
  assert.equal(checkGuards(events).completedThreads, 2);
});

for (const [name, value] of [
  ["missing", undefined],
  ["null", null],
  ["negative", -1],
  ["fractional", 7.5],
  ["string", "7"],
  ["NaN", NaN],
  ["infinite", Infinity],
  ["too large", 2_147_483_648],
  ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ["process-spoof zero", 0],
] as const)
  test(`optional thread generic exit refuses ${name} thread ID`, () => {
    const { events, exit } = withThreadGuardExit();
    (exit as Event).threadId = value;
    assert.throws(() => checkGuards(events));
  });

for (const [name, mutate] of Object.entries({
  "orphan PID": (_events: Event[], exit: Event) => {
    exit.pid = 999;
  },
  "orphan thread ID": (_events: Event[], exit: Event) => {
    exit.threadId = 8;
  },
  "other process PID with same thread ID": (_events: Event[], exit: Event) => {
    exit.pid = 125;
  },
  "missing PID": (_events: Event[], exit: Event) => {
    delete exit.pid;
  },
  "duplicate generic exit": (events: Event[], exit: Event) => {
    events.splice(events.indexOf(exit), 0, { ...exit });
  },
  "host-spoof entry": (_events: Event[], exit: Event) => {
    exit.entry = guardContext.worker;
  },
  "missing entry": (_events: Event[], exit: Event) => {
    delete exit.entry;
  },
  "nonempty real entry": (_events: Event[], exit: Event) => {
    exit.realEntry = guardContext.worker;
  },
  "missing real entry": (_events: Event[], exit: Event) => {
    delete exit.realEntry;
  },
  "nonempty start and exit real entry": (events: Event[], exit: Event) => {
    events.find((event) => event.kind === "thread-guard-start")!.realEntry =
      guardContext.worker;
    exit.realEntry = guardContext.worker;
  },
  "wrong parent PID": (_events: Event[], exit: Event) => {
    exit.ppid = 90;
  },
  "missing parent PID": (_events: Event[], exit: Event) => {
    delete exit.ppid;
  },
  "missing parent PID in both records": (events: Event[], exit: Event) => {
    delete events.find((event) => event.kind === "thread-guard-start")!.ppid;
    delete exit.ppid;
  },
  "denied operation": (_events: Event[], exit: Event) => {
    exit.denied = 1;
  },
  "missing denial counter": (_events: Event[], exit: Event) => {
    delete exit.denied;
  },
  "negative denial counter": (_events: Event[], exit: Event) => {
    exit.denied = -1;
  },
  "thread failure": (_events: Event[], exit: Event) => {
    exit.threadFailed = true;
  },
  "missing thread failure flag": (_events: Event[], exit: Event) => {
    delete exit.threadFailed;
  },
  "native child leakage counter": (_events: Event[], exit: Event) => {
    exit.unobservedNativeExits = 1;
  },
  "missing native counter": (_events: Event[], exit: Event) => {
    delete exit.unobservedNativeExits;
  },
  "negative native counter": (_events: Event[], exit: Event) => {
    exit.unobservedNativeExits = -1;
  },
  "exit before thread start": (events: Event[], exit: Event) => {
    events.splice(events.indexOf(exit), 1);
    events.splice(
      events.findIndex((event) => event.kind === "thread-guard-start"),
      0,
      exit,
    );
  },
  "exit before thread ready": (events: Event[], exit: Event) => {
    events.splice(events.indexOf(exit), 1);
    events.splice(
      events.findIndex((event) => event.kind === "thread-ready"),
      0,
      exit,
    );
  },
  "exit after actual parent exit": (events: Event[], exit: Event) => {
    events.splice(events.indexOf(exit), 1);
    events.splice(
      events.findIndex((event) => event.kind === "thread-exit") + 1,
      0,
      exit,
    );
  },
  "missing actual parent exit": (events: Event[]) => {
    events.splice(
      events.findIndex((event) => event.kind === "thread-exit"),
      1,
    );
  },
  "generic exit substituted for actual parent exit": (
    events: Event[],
    exit: Event,
  ) => {
    Object.assign(
      events.find((event) => event.kind === "thread-exit")!,
      exit,
    );
    events.splice(events.indexOf(exit), 1);
  },
  "actual parent exit claims failure": (events: Event[]) => {
    events.find((event) => event.kind === "thread-exit")!.failed = true;
  },
  "actual parent exit claims wrong thread": (events: Event[]) => {
    events.find((event) => event.kind === "thread-exit")!.targetThreadId = 8;
  },
  "actual parent exit claims wrong writer": (events: Event[]) => {
    events.find((event) => event.kind === "thread-exit")!.threadId = 7;
  },
  "actual parent exit claims wrong process": (events: Event[]) => {
    events.find((event) => event.kind === "thread-exit")!.pid = 125;
  },
  "actual parent exit has wrong launch": (events: Event[]) => {
    events.find((event) => event.kind === "thread-exit")!.threadLaunchId =
      "123:thread:2";
  },
  "unrequested nonzero actual exit": (events: Event[]) => {
    events.splice(
      events.findIndex((event) => event.kind === "thread-terminate-request"),
      1,
    );
  },
  "thread error hidden by generic exit": (events: Event[], exit: Event) => {
    events.splice(events.indexOf(exit), 0, {
      ...events.find((event) => event.kind === "thread-launch")!,
      kind: "thread-error",
    });
  },
  "duplicate actual thread exit": (events: Event[], exit: Event) => {
    events.splice(events.indexOf(exit), 0, {
      ...events.find((event) => event.kind === "thread-exit")!,
    });
  },
  "missing real Node child exit": (events: Event[]) => {
    events.splice(
      events.findIndex((event) => event.kind === "node-child-exit"),
      1,
    );
  },
  "extra real Node child exit": (events: Event[]) => {
    events.push({
      ...events.find((event) => event.kind === "node-child-exit")!,
    });
  },
  "duplicate process start": (events: Event[]) => {
    events.push({ ...events.find((event) => event.kind === "guard-start")! });
  },
  "duplicate process exit": (events: Event[]) => {
    events.push({
      ...events.find(
        (event) => event.kind === "guard-exit" && event.threadId === 0,
      )!,
    });
  },
}))
  test(`optional thread generic exit refuses ${name}`, () => {
    const { events, exit } = withThreadGuardExit();
    mutate(events, exit);
    assert.throws(() => checkGuards(events));
  });

for (const kind of [
  "thread-launch",
  "thread-guard-start",
  "thread-ready",
  "thread-handshake",
])
  test(`optional generic exit cannot replace missing ${kind}`, () => {
    const { events } = withThreadGuardExit();
    assert.throws(() =>
      checkGuards(events.filter((event) => event.kind !== kind)),
    );
  });

for (const role of [
  "coordinator",
  "test-worker",
  "wrangler-bin",
  "wrangler-cli",
])
  for (const kind of ["guard-start", "guard-exit"])
    test(`optional thread exit never substitutes for ${role} ${kind}`, () => {
      const { events } = withThreadGuardExit();
      const process = events.find(
        (event) => event.kind === "guard-start" && event.role === role,
      )!;
      assert.throws(() =>
        checkGuards(
          events.filter(
            (event) =>
              !(
                event.kind === kind &&
                event.threadId === 0 &&
                event.pid === process.pid
              ),
          ),
        ),
      );
    });

for (const generic of [false, true])
  for (const kind of [
    "native-child",
    "native-child-exit",
    "native-child-close",
    "complete native pair",
  ])
    test(`thread ${kind} cannot leak through replay with optional generic exit ${generic}`, () => {
      const events = generic ? withThreadGuardExit().events : guardedEvents();
      const launch = events.find((event) => event.kind === "native-child")!;
      const exit = events.find((event) => event.kind === "native-child-exit")!;
      const threadRows =
        kind === "complete native pair"
          ? [
              { ...launch, threadId: 7 },
              { ...exit, threadId: 7 },
            ]
          : [
              {
                ...(kind === "native-child" ? launch : exit),
                kind,
                threadId: 7,
              },
            ];
      events.splice(
        events.findIndex((event) => event.kind === "thread-exit"),
        0,
        ...threadRows,
      );
      assert.throws(() => checkGuards(events));
    });
