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
      role: "test-worker",
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
    { ...thread, kind: "thread-guard-start", threadId: 7 },
    { ...thread, kind: "thread-ready", threadId: 7 },
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
      role: "test-worker",
      ...exits,
    },
    { ...coordinator, kind: "guard-exit", ...stopped },
  ];
}
const checkGuards = (events: Event[]) =>
  validateFailureGuardEvidence(events, guardContext);

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

for (const role of ["wrangler-bin", "wrangler-cli", "test-worker"])
  test(`nonzero ${role} exit cannot qualify`, () => {
    const events = guardedEvents();
    events.find((e) => e.kind === "node-child-exit" && e.role === role)!.code =
      1;
    assert.throws(() => checkGuards(events));
  });
test("worker 143 requires the actual matching SIGTERM observation", () => {
  const events = guardedEvents();
  const exit = events.find(
    (e) => e.kind === "node-child-exit" && e.role === "test-worker",
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
    (e) => e.kind === "node-child-exit" && e.role === "test-worker",
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
