import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  authorizeLaunch,
  authorizeSocketConnect,
  createLaunchGate,
  DENIAL_OPERATIONS,
  installWorkerTerminationReceipt,
  invokeAuthorized,
  observeChildLifecycle,
  POLICY_CODES,
  PolicyViolation,
  refusalTargetCategory,
  refuseWorkerCreation,
  REVIEWED_WORKER_SOURCES,
  sanitizeDenial,
  workerDenialCode,
  type HostRole,
  type LaunchApi,
  type PolicyContext,
  type WorkerDiagnosticContext,
} from "./launch-policy.ts";

const paths = {
  node: "/installed/node",
  vitestEntry: "/installed/vitest/vitest.mjs",
  vitestWorker: "/installed/vitest/dist/workers/forks.js",
  vitestSuppress: "/installed/vitest/suppress-warnings.cjs",
  wranglerBin: "/installed/wrangler/bin/wrangler.js",
  wranglerCli: "/installed/wrangler/wrangler-dist/cli.js",
  esbuild: "/installed/@esbuild/linux-x64/bin/esbuild",
  workerd: "/installed/@cloudflare/workerd-linux-64/bin/workerd",
};
const outdir = "/tmp/data-api-quarantine-isolate-reviewed";
const dryrun = [
  "deploy",
  "--config",
  "wrangler.data.jsonc",
  "--dry-run",
  "--outdir",
  `${outdir}/modules`,
  "--outfile",
  `${outdir}/upload.multipart`,
  "--upload-source-maps",
  "--env-file",
  `${outdir}/empty.env`,
];
function context(role: HostRole = "coordinator"): PolicyContext {
  const ctx: PolicyContext = {
    ...paths,
    root: "/candidate",
    home: "/temporary-home",
    preload: "file:///harness/guard.ts?config=fake",
    role,
    baseEnv: {},
    inheritedEnv: {},
    processArgs: role.startsWith("wrangler") ? [...dryrun] : [],
    native: [
      {
        path: paths.esbuild,
        sha256: "esbuild-hash",
        version: "0.28.2",
        packagePath: "node_modules/@esbuild/linux-x64",
      },
      {
        path: paths.workerd,
        sha256: "workerd-hash",
        version: "1.20260730.1",
        packagePath:
          "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64",
      },
    ],
    resolve(file) {
      return Object.values(paths).includes(file)
        ? file
        : file === "/candidate/node_modules/wrangler/bin/wrangler.js"
          ? paths.wranglerBin
          : file === "/alias/esbuild"
            ? paths.esbuild
            : null;
    },
    digest(file) {
      return file === paths.esbuild ? "esbuild-hash" : "workerd-hash";
    },
    isEmptyFile(file) {
      return file === `${outdir}/empty.env`;
    },
  };
  ctx.baseEnv = {
    PATH: "/usr/bin",
    HOME: ctx.home,
    XDG_CONFIG_HOME: `${ctx.home}/config`,
    XDG_CACHE_HOME: `${ctx.home}/cache`,
    CI: "true",
    NODE_ENV: "test",
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
    CLOUDFLARE_AUTH_USE_KEYRING: "false",
    WRANGLER_SEND_METRICS: "false",
    DECODER_QUALIFICATION_ROOT: ctx.root,
    DECODER_QUALIFICATION_PRELOAD: ctx.preload,
    DECODER_QUALIFICATION_RESULT: "/receipts/result.json",
  };
  ctx.inheritedEnv = role.startsWith("wrangler")
    ? wranglerEnv(ctx)
    : { ...ctx.baseEnv };
  return ctx;
}
function wranglerEnv(ctx: PolicyContext): Record<string, string> {
  return {
    PATH: "/usr/bin",
    HOME: ctx.home,
    CI: "true",
    NODE_ENV: "production",
    XDG_CONFIG_HOME: `${outdir}/config`,
    XDG_CACHE_HOME: `${outdir}/cache`,
    CLOUDFLARE_AUTH_USE_KEYRING: "false",
    WRANGLER_SEND_METRICS: "false",
  };
}
function forkCall(ctx: PolicyContext): unknown[] {
  return [
    paths.vitestWorker,
    [],
    {
      env: {
        ...ctx.baseEnv,
        TEST: "true",
        VITEST: "true",
        VITEST_MODE: "RUN",
        FORCE_TTY: "",
        PROD: "",
        DEV: "1",
        BASE_URL: "/",
        MODE: "test",
      },
      execArgv: [
        "--experimental-import-meta-resolve",
        "--require",
        paths.vitestSuppress,
        "--conditions",
        "node",
        "--conditions",
        "development",
        "--import",
        ctx.preload,
      ],
      stdio: "pipe",
      serialization: "advanced",
    },
  ];
}
function binCall(ctx: PolicyContext): unknown[] {
  return [
    paths.node,
    ["/candidate/node_modules/wrangler/bin/wrangler.js", ...dryrun],
    {
      cwd: ctx.root,
      env: wranglerEnv(ctx),
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  ];
}
function esbuildCall(ctx: PolicyContext): unknown[] {
  return [
    paths.esbuild,
    ["--service=0.28.2", "--ping"],
    { windowsHide: true, stdio: ["pipe", "pipe", "inherit"], cwd: ctx.root },
  ];
}
function workerdCall(ctx: PolicyContext): unknown[] {
  return [
    paths.workerd,
    [
      "serve",
      "--binary",
      "--experimental",
      "--socket-addr=entry=127.0.0.1:0",
      "--external-addr=loopback=127.0.0.1:12345",
      "--control-fd=3",
      "-",
    ],
    {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...ctx.inheritedEnv, TZ: "UTC", FORCE_COLOR: "0" },
    },
  ];
}
function rejects(ctx: PolicyContext, api: LaunchApi, call: unknown[]): void {
  let launched = 0;
  let denied = 0;
  assert.throws(
    () =>
      invokeAuthorized(
        ctx,
        api,
        call,
        () => {
          launched += 1;
        },
        (code) => {
          denied += 1;
          assert.ok((POLICY_CODES as readonly string[]).includes(code));
          throw new PolicyViolation(code);
        },
      ),
    PolicyViolation,
  );
  assert.equal(launched, 0);
  assert.equal(denied, 1);
}

test("observed Vitest4.1.11 coordinator fork retains exact explicit preload", () => {
  const ctx = context();
  const call = forkCall(ctx);
  let launched = 0;
  const result = invokeAuthorized(
    ctx,
    "fork",
    call,
    (decision) => {
      launched += 1;
      assert.deepEqual(decision.call, call);
      return decision.role;
    },
    () => {
      throw Error("unexpected denial");
    },
  );
  assert.equal(result, "vitest-worker");
  assert.equal(launched, 1);
});
test("worker and Wrangler contexts cannot create additional Vitest forks", () => {
  for (const role of ["test-worker", "wrangler-bin", "wrangler-cli"] as const)
    rejects(context(role), "fork", forkCall(context(role)));
});
test("fork requires only the pinned node/development conditions with the exact preload", () => {
  const ctx = context();
  const accepted = forkCall(ctx);
  assert.equal(authorizeLaunch(ctx, "fork", accepted).role, "vitest-worker");
  const exact = (accepted[2] as { execArgv: string[] }).execArgv;
  for (const changed of [
    [...exact.slice(0, 3), "--conditions", "module", ...exact.slice(3)],
    exact.map((value) => (value === "development" ? "production" : value)),
    exact.map((value) => (value === "node" ? "arbitrary-condition" : value)),
    [...exact, "--conditions", "node"],
    exact.filter((_, index) => index !== 5 && index !== 6),
  ]) {
    const call = forkCall(ctx);
    (call[2] as { execArgv: string[] }).execArgv = changed;
    rejects(ctx, "fork", call);
  }
});
test("fork accepts only the four exact source-derived local metadata values", () => {
  const ctx = context();
  const fixed: Record<string, string> = {
    PROD: "",
    DEV: "1",
    BASE_URL: "/",
    MODE: "test",
  };
  assert.equal(
    authorizeLaunch(ctx, "fork", forkCall(ctx)).role,
    "vitest-worker",
  );
  for (const key of Object.keys(fixed)) {
    for (const value of [
      "synthetic-secret",
      "production",
      "https://example.invalid/",
      undefined,
      null,
      1,
    ]) {
      const call = forkCall(ctx);
      (call[2] as { env: Record<string, unknown> }).env[key] = value;
      rejects(ctx, "fork", call);
    }
  }
  for (const [key, value] of Object.entries({
    PROD: "1",
    DEV: "",
    BASE_URL: "//",
    MODE: "development",
  })) {
    const call = forkCall(ctx);
    (call[2] as { env: Record<string, unknown> }).env[key] = value;
    rejects(ctx, "fork", call);
  }
  for (const key of [
    "VITE_ARBITRARY",
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
  ]) {
    const call = forkCall(ctx);
    (call[2] as { env: Record<string, unknown> }).env[key] = "synthetic-secret";
    rejects(ctx, "fork", call);
  }
});
test("fork refuses missing preload, altered require target, unknown env, executable override", () => {
  const ctx = context();
  for (const change of [
    (o: Record<string, unknown>) => {
      o.execArgv = [];
    },
    (o: Record<string, unknown>) => {
      (o.execArgv as string[])[2] = "/evil/preload.js";
    },
    (o: Record<string, unknown>) => {
      (o.env as Record<string, string>).CLOUDFLARE_API_TOKEN =
        "synthetic-secret";
    },
    (o: Record<string, unknown>) => {
      o.execPath = "/other/node";
    },
  ]) {
    const call = forkCall(ctx);
    change(call[2] as Record<string, unknown>);
    rejects(ctx, "fork", call);
  }
});
test("exact fixture execFile gains only a preload and preserves callback/options identity", () => {
  const ctx = context("test-worker");
  const call = binCall(ctx);
  const callback = () => {};
  call.push(callback);
  const result = authorizeLaunch(ctx, "execFile", call);
  assert.equal(result.role, "wrangler-bin");
  assert.equal(result.amended, true);
  assert.deepEqual(result.call[1], [
    "--import",
    ctx.preload,
    ...(call[1] as string[]),
  ]);
  assert.equal(result.call[2], call[2]);
  assert.equal(result.call[3], callback);
});
test("fixture directory URL yields one trailing separator, accepted without changing caller options", () => {
  const ctx = context("test-worker");
  const directoryForm = fileURLToPath(
    new URL("..", "file:///candidate/scripts/lib.ts"),
  );
  assert.equal(directoryForm, `${ctx.root}/`);
  for (const cwd of [ctx.root, directoryForm]) {
    const call = binCall(ctx);
    const options = call[2] as Record<string, unknown>;
    options.cwd = cwd;
    const decision = authorizeLaunch(ctx, "execFile", call);
    assert.equal(decision.role, "wrangler-bin");
    assert.equal(decision.call[2], options);
    assert.equal((decision.call[2] as Record<string, unknown>).cwd, cwd);
  }
});
test("cwd rejects parent, sibling, normalized, relative and symlink spellings", () => {
  const ctx = context("test-worker");
  const originalResolve = ctx.resolve;
  let cwdResolutionAttempts = 0;
  ctx.resolve = (file) => {
    if (file === "/linked-candidate") {
      cwdResolutionAttempts += 1;
      return ctx.root;
    }
    return originalResolve(file);
  };
  for (const cwd of [
    "/",
    "/candidate-other",
    "/candidate/..",
    "/candidate/subdir/..",
    "/candidate//",
    "/candidate/.",
    "//candidate",
    ".",
    "./candidate",
    "candidate",
    "/linked-candidate",
  ]) {
    const call = binCall(ctx);
    (call[2] as Record<string, unknown>).cwd = cwd;
    rejects(ctx, "execFile", call);
  }
  assert.equal(cwdResolutionAttempts, 0);
});
test("repository-root environment redirection stays refused", () => {
  const ctx = context("test-worker");
  const call = binCall(ctx);
  (call[2] as { env: Record<string, string> }).env.METAGRAPH_REPO_ROOT =
    "/elsewhere";
  rejects(ctx, "execFile", call);
});
test("Wrangler bin is unavailable to coordinator, arbitrary Node API, changed dry-run or credentials", () => {
  rejects(context(), "execFile", binCall(context()));
  const ctx = context("test-worker");
  rejects(ctx, "spawn", binCall(ctx));
  const call = binCall(ctx);
  (call[1] as string[]).splice(4, 1);
  rejects(ctx, "execFile", call);
  const credential = binCall(ctx);
  (
    (credential[2] as Record<string, unknown>).env as Record<string, string>
  ).AWS_SECRET_ACCESS_KEY = "synthetic-secret";
  rejects(ctx, "execFile", credential);
});
test("official Wrangler4.129.1 wrapper shape retains exact prefix and inherited stdio", () => {
  const ctx = context("wrangler-bin");
  const call = [
    paths.node,
    ["--no-warnings", "--import", ctx.preload, paths.wranglerCli, ...dryrun],
    { stdio: ["inherit", "inherit", "inherit", "ipc"] },
  ];
  assert.equal(authorizeLaunch(ctx, "spawn", call).role, "wrangler-cli");
  const missing = structuredClone(call);
  (missing[1] as string[]).splice(1, 2);
  rejects(ctx, "spawn", missing);
  for (const changedPrefix of [
    ["--import", ctx.preload, "--no-warnings"],
    ["--no-warnings", "--import", ctx.preload, "--experimental-vm-modules"],
    ["--no-warnings", "--import", ctx.preload, "--import", ctx.preload],
  ]) {
    const changed = structuredClone(call);
    changed[1] = [...changedPrefix, paths.wranglerCli, ...dryrun];
    rejects(ctx, "spawn", changed);
  }
  const stdio = structuredClone(call);
  (stdio[2] as { stdio: string[] }).stdio[0] = "ignore";
  rejects(ctx, "spawn", stdio);
  const extraEnv = structuredClone(call);
  (extraEnv[2] as Record<string, unknown>).env = ctx.inheritedEnv;
  rejects(ctx, "spawn", extraEnv);
  rejects(context("wrangler-cli"), "spawn", call);
});
test("exit observer records before wrapper termination listener and does not depend on close", () => {
  const listeners: Record<
    string,
    Array<(code: number | null, signal: string | null) => void>
  > = {};
  const events: string[] = [];
  const child = {
    once(
      event: "exit" | "close",
      listener: (code: number | null, signal: string | null) => void,
    ) {
      (listeners[event] ??= []).push(listener);
    },
  };
  observeChildLifecycle(
    child,
    () => events.push("observed-exit"),
    () => events.push("observed-close"),
    () => {
      throw Error("unexpected refusal");
    },
  );
  child.once("exit", () => events.push("wrapper-termination"));
  for (const listener of listeners.exit!) listener(0, null);
  assert.deepEqual(events, ["observed-exit", "wrapper-termination"]);
  for (const listener of listeners.close!) listener(0, null);
  assert.deepEqual(events, [
    "observed-exit",
    "wrapper-termination",
    "observed-close",
  ]);
});
test("native exit is never inferred merely from registering its lifecycle", () => {
  let observed = 0;
  observeChildLifecycle(
    { once() {} },
    () => {
      observed += 1;
    },
    () => {
      observed += 1;
    },
    () => {
      throw Error("unexpected refusal");
    },
  );
  assert.equal(observed, 0);
  assert.throws(
    () =>
      observeChildLifecycle(
        {},
        () => {},
        () => {},
        () => {
          throw new PolicyViolation("missing-child-lifecycle");
        },
      ),
    PolicyViolation,
  );
});
for (const role of [
  "coordinator",
  "test-worker",
  "wrangler-bin",
  "wrangler-cli",
] as const) {
  test(`${role}: esbuild native identity/arguments checked before fake launch`, () => {
    const ctx = context(role);
    assert.equal(
      authorizeLaunch(ctx, "spawn", esbuildCall(ctx)).role,
      "esbuild",
    );
    const badHash = context(role);
    badHash.digest = () => "tampered";
    rejects(badHash, "spawn", esbuildCall(badHash));
    const badArgs = esbuildCall(ctx);
    (badArgs[1] as string[]).push("--serve=0.0.0.0:80");
    rejects(ctx, "spawn", badArgs);
    const env = context(role);
    env.inheritedEnv.GITHUB_TOKEN = "synthetic-secret";
    rejects(env, "spawn", esbuildCall(env));
  });
  for (const api of [
    "spawn",
    "spawnSync",
    "fork",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
  ] as const) {
    test(`${role}: ${api} refuses arbitrary command before injected launcher`, () =>
      rejects(context(role), api, [
        "/usr/bin/curl",
        ["https://example.invalid"],
        {},
      ]));
  }
}
test("esbuild sync service accepts only observed API/options", () => {
  const ctx = context();
  const call = [
    paths.esbuild,
    ["--service=0.28.2"],
    {
      cwd: ctx.root,
      windowsHide: true,
      input: new Uint8Array([1]),
      maxBuffer: 16777216,
    },
  ];
  assert.equal(authorizeLaunch(ctx, "execFileSync", call).role, "esbuild");
  rejects(ctx, "spawnSync", call);
  rejects(ctx, "execFile", call);
});
test("native aliases resolve to the exact allowlisted binary before hashing", () => {
  const ctx = context();
  const call = esbuildCall(ctx);
  call[0] = "/alias/esbuild";
  assert.equal(authorizeLaunch(ctx, "spawn", call).role, "esbuild");
  ctx.resolve = () => "/other/esbuild";
  rejects(ctx, "spawn", call);
});
test("workerd accepts only pinned serve with numeric local control addresses", () => {
  const ctx = context("test-worker");
  assert.equal(authorizeLaunch(ctx, "spawn", workerdCall(ctx)).role, "workerd");
  for (const address of [
    "0.0.0.0:80",
    "example.invalid:80",
    "127.0.0.1:99999",
  ]) {
    const call = workerdCall(ctx);
    (call[1] as string[])[3] = `--socket-addr=entry=${address}`;
    rejects(ctx, "spawn", call);
  }
  const extra = workerdCall(ctx);
  (extra[1] as string[]).push("--inspector-addr=0.0.0.0:9229");
  rejects(ctx, "spawn", extra);
  const credential = workerdCall(ctx);
  (
    (credential[2] as Record<string, unknown>).env as Record<string, string>
  ).API_KEY = "synthetic-secret";
  rejects(ctx, "spawn", credential);
});
test("policy exceptions from injected hash/resolve are recorded as denial", () => {
  const ctx = context();
  ctx.digest = () => {
    throw Error("synthetic detail must not leak");
  };
  rejects(ctx, "spawn", esbuildCall(ctx));
});
for (const args of [
  [80, "127.0.0.1"],
  ["80", "::1"],
  [{ path: "/tmp/local.sock" }],
  [{ path: "", host: "127.0.0.1", port: 80 }],
  [[{ host: "127.0.0.1", port: 80 }, null]],
]) {
  test(`socket local shape ${JSON.stringify(args)}`, () =>
    assert.doesNotThrow(() => authorizeSocketConnect(args)));
}
for (const args of [
  [80, "example.invalid"],
  ["80", "example.invalid"],
  ["0x50", "example.invalid"],
  [{ path: "", host: "example.invalid", port: 80 }],
  [{ path: "", host: "0.0.0.0", port: 80 }],
  [[{ host: "example.invalid", port: 80 }, null]],
  [{ fd: 4, path: "/tmp/local.sock" }],
]) {
  test(`socket external/empty-path shape ${JSON.stringify(args)}`, () =>
    assert.throws(() => authorizeSocketConnect(args), PolicyViolation));
}
test("cyclic normalized socket arrays fail closed without touching a socket", () => {
  const args: unknown[] = [];
  args.push(args);
  assert.throws(() => authorizeSocketConnect(args), PolicyViolation);
});

for (const role of [
  "coordinator",
  "test-worker",
  "wrangler-bin",
  "wrangler-cli",
] as const) {
  for (const api of [
    "spawn",
    "spawnSync",
    "fork",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
  ] as const)
    test(`${role}: ${api} refuses arbitrary Node code without invoking fake launcher`, () =>
      rejects(context(role), api, [
        paths.node,
        ["-e", "throw new Error('must not execute')"],
        {},
      ]));
}
test("inherited or accessor-based credential injection is refused", () => {
  const ctx = context();
  const inherited = forkCall(ctx);
  const env = Object.assign(
    Object.create({ API_TOKEN: "synthetic-secret" }) as Record<string, string>,
    ctx.baseEnv,
  );
  (inherited[2] as Record<string, unknown>).env = env;
  rejects(ctx, "fork", inherited);
  const accessor = forkCall(ctx);
  Object.defineProperty((accessor[2] as Record<string, unknown>).env, "HOME", {
    get: () => ctx.home,
    enumerable: true,
  });
  rejects(ctx, "fork", accessor);
});
test("refusal receipts expose only fixed categories without string conversion", () => {
  let touched = 0;
  const hostile = {
    toString() {
      touched += 1;
      throw Error("synthetic-secret");
    },
  };
  assert.equal(refusalTargetCategory(hostile), "object");
  assert.equal(refusalTargetCategory("synthetic-secret"), "string");
  assert.equal(refusalTargetCategory(Symbol("synthetic-secret")), "symbol");
  assert.equal(refusalTargetCategory(undefined), "missing");
  assert.equal(refusalTargetCategory(null), "missing");
  assert.equal(refusalTargetCategory(80), "number");
  assert.equal(
    refusalTargetCategory(() => "synthetic-secret"),
    "function",
  );
  assert.equal(touched, 0);
});
test("extra or ambiguous child API call arguments fail closed", () => {
  const ctx = context();
  rejects(ctx, "spawn", [...esbuildCall(ctx), { shell: true }]);
  rejects(ctx, "fork", [...forkCall(ctx), () => {}]);
  const worker = context("test-worker");
  rejects(worker, "execFile", [...binCall(worker), "not-a-callback"]);
});
test("prototype launch gate refuses direct and reused permission without launching", () => {
  let denied = 0;
  const gate = createLaunchGate(() => {
    denied += 1;
    throw new PolicyViolation("direct-child-spawn");
  });
  assert.throws(() => gate.consume(), PolicyViolation);
  gate.run(() => {
    gate.consume();
    assert.throws(() => gate.consume(), PolicyViolation);
    assert.throws(() => gate.run(() => {}), PolicyViolation);
  });
  assert.throws(() => gate.consume(), PolicyViolation);
  assert.equal(denied, 4);
});
test("prototype launch gate clears permission even when original launch throws", () => {
  const gate = createLaunchGate(() => {
    throw new PolicyViolation("direct-child-spawn");
  });
  assert.throws(() =>
    gate.run(() => {
      throw Error("synthetic launch failure");
    }),
  );
  assert.throws(() => gate.consume(), PolicyViolation);
  assert.doesNotThrow(() => gate.run(() => gate.consume()));
});
test("diagnostic allowlists are immutable, unique and preserve every approved value", () => {
  assert.ok(Object.isFrozen(DENIAL_OPERATIONS));
  assert.ok(Object.isFrozen(POLICY_CODES));
  assert.equal(new Set(DENIAL_OPERATIONS).size, DENIAL_OPERATIONS.length);
  assert.equal(new Set(POLICY_CODES).size, POLICY_CODES.length);
  assert.equal(Reflect.set(DENIAL_OPERATIONS, "0", "synthetic-secret"), false);
  assert.equal(Reflect.set(POLICY_CODES, "0", "synthetic-secret"), false);
  for (const operation of DENIAL_OPERATIONS)
    assert.deepEqual(sanitizeDenial(operation, "shell-api"), {
      operation,
      policyCode: "shell-api",
    });
  for (const policyCode of POLICY_CODES) {
    assert.deepEqual(sanitizeDenial("process-spawn", policyCode), {
      operation: "process-spawn",
      policyCode,
    });
    assert.equal(new PolicyViolation(policyCode).code, policyCode);
  }
});
test("unknown diagnostics never echo secrets, URLs, string wrappers or caller conversion", () => {
  let touched = 0;
  const hostile = {
    toString() {
      touched += 1;
      throw Error("synthetic-secret");
    },
  };
  for (const unknown of [
    "synthetic-secret",
    "https://example.invalid/private?token=synthetic-secret",
    new String("shell-api"),
    hostile,
    null,
    undefined,
    3,
    Symbol("synthetic-secret"),
    () => "synthetic-secret",
  ]) {
    assert.deepEqual(sanitizeDenial(unknown, unknown), {
      operation: "other",
      policyCode: "other",
    });
    const error = new PolicyViolation(unknown);
    assert.equal(error.code, "other");
    assert.equal(error.message, "other");
  }
  assert.equal(touched, 0);
});
test("launch and socket failures preserve approved diagnostic codes only", () => {
  const ctx = context();
  let diagnostic: ReturnType<typeof sanitizeDenial> | undefined;
  assert.throws(
    () =>
      invokeAuthorized(
        ctx,
        "exec",
        ["/arbitrary", [], {}],
        () => {
          throw Error("must not launch");
        },
        (code) => {
          diagnostic = sanitizeDenial("process-exec", code);
          throw new PolicyViolation(code);
        },
      ),
    PolicyViolation,
  );
  assert.deepEqual(diagnostic, {
    operation: "process-exec",
    policyCode: "shell-api",
  });
  for (const args of [
    ["80", "example.invalid"],
    [{ path: "", host: "example.invalid", port: 80 }],
  ]) {
    assert.throws(
      () => authorizeSocketConnect(args),
      (error: unknown) => {
        assert.ok(error instanceof PolicyViolation);
        assert.ok((POLICY_CODES as readonly string[]).includes(error.code));
        assert.deepEqual(sanitizeDenial("socket-policy", error.code), {
          operation: "socket-policy",
          policyCode: "external-socket-host",
        });
        return true;
      },
    );
  }
});
test("termination receipt registers once for SIGTERM in the test-worker scope only", () => {
  for (const role of [
    "coordinator",
    "test-worker",
    "wrangler-bin",
    "wrangler-cli",
  ] as const) {
    const registrations: string[] = [];
    let invoked = false;
    installWorkerTerminationReceipt(
      role,
      (signal) => {
        registrations.push(signal);
      },
      () => {
        invoked = true;
      },
      () => {
        invoked = true;
      },
    );
    assert.deepEqual(registrations, role === "test-worker" ? ["SIGTERM"] : []);
    assert.equal(invoked, false);
  }
});
test("worker SIGTERM receipt records fixed metadata before immediate injected exit", () => {
  let handler: (() => void) | undefined;
  const events: unknown[] = [];
  installWorkerTerminationReceipt(
    "test-worker",
    (signal, listener) => {
      assert.equal(signal, "SIGTERM");
      handler = listener;
    },
    (detail) => {
      events.push(["guard-signal", detail]);
    },
    (code) => {
      events.push(["exit", code]);
    },
  );
  assert.ok(handler);
  handler();
  assert.deepEqual(events, [
    ["guard-signal", { signal: "SIGTERM", exitCode: 143 }],
    ["exit", 143],
  ]);
});
test("worker SIGTERM receipt always calls injected exit even if recording throws", () => {
  let handler: (() => void) | undefined;
  const events: unknown[] = [];
  const failure = new Error("synthetic recording failure");
  installWorkerTerminationReceipt(
    "test-worker",
    (_signal, listener) => {
      handler = listener;
    },
    () => {
      events.push("record");
      throw failure;
    },
    (code) => {
      events.push(["exit", code]);
    },
  );
  assert.ok(handler);
  assert.throws(
    () => handler!(),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(events, ["record", ["exit", 143]]);
});

// Inert, exact cooked string from the reviewed public Miniflare template.
// Hashing this fixture does not evaluate it or import Miniflare.
const reviewedMiniflareWorkerScript =
  '\nconst { createRequire } = require("module");\nconst { workerData } = require("worker_threads");\n\n// Not using parentPort here so we can call receiveMessageOnPort() in host\nconst { notifyHandle, port, filename } = workerData;\n\n// When running Miniflare from Jest, regular \'require("undici")\' will fail here\n// with "Error: Cannot find module \'undici\'". Instead we need to create a\n// \'require\' using the \'__filename\' of the host... :(\nconst actualRequire = createRequire(filename);\nconst { Pool, fetch } = actualRequire("undici");\n\nlet dispatcherUrl;\nlet dispatcher;\n\nport.addEventListener("message", async (event) => {\n  const { id, method, url, headers, body } = event.data;\n  try {\n    if (dispatcherUrl !== url) {\n      dispatcherUrl = url;\n      dispatcher = new Pool(new URL(url).origin, {\n        connect: { rejectUnauthorized: false },\n              // Disable timeouts for local dev — long-running responses (streaming,\n      // slow uploads, long-polling) should not be killed by undici defaults.\n      headersTimeout: 0,\n      bodyTimeout: 0,\n      });\n    }\n    headers["MF-Op-Sync"] = "true";\n    // body cannot be a ReadableStream, so no need to specify duplex\n    const response = await fetch(url, { method, headers, body, dispatcher });\n    const responseBody = response.headers.get("MF-Op-Result-Type") === "ReadableStream"\n      ? response.body\n      : await response.arrayBuffer();\n    const transferList = responseBody === null ? undefined : [responseBody];\n    port.postMessage(\n      {\n        id,\n        response: {\n          status: response.status,\n          headers: Object.fromEntries(response.headers),\n          body: responseBody,\n        }\n      },\n      transferList\n    );\n  } catch (error) {\n    try {\n      port.postMessage({ id, error });\n    } catch {\n      // If error failed to serialise, post simplified version\n      port.postMessage({ id, error: new Error(String(error)) });\n    }\n  } finally {\n    Atomics.store(notifyHandle, /* index */ 0, /* value */ 1);\n    Atomics.notify(notifyHandle, /* index */ 0);\n  }\n});\n\nport.start();\n';

function workerDiagnostics(): WorkerDiagnosticContext {
  return {
    esbuildFile: "/installed/esbuild/lib/main.js",
    vitestThreadsFile: "/installed/vitest/dist/workers/threads.js",
    digest(source) {
      return createHash("sha256").update(source).digest("hex");
    },
  };
}
test("worker diagnostics recognize only canonical reviewed file names and exact inline script hash", () => {
  const ctx = workerDiagnostics();
  assert.equal(
    workerDenialCode(ctx, ctx.esbuildFile, {}),
    "worker-thread-esbuild-file",
  );
  assert.equal(
    workerDenialCode(ctx, ctx.vitestThreadsFile, {}),
    "worker-thread-vitest-file",
  );
  assert.equal(
    ctx.digest(reviewedMiniflareWorkerScript),
    REVIEWED_WORKER_SOURCES.miniflareScriptSha256,
  );
  assert.equal(
    reviewedMiniflareWorkerScript.length,
    REVIEWED_WORKER_SOURCES.miniflareScriptJsLength,
  );
  assert.equal(
    workerDenialCode(ctx, reviewedMiniflareWorkerScript, { eval: true }),
    "worker-thread-miniflare-script",
  );
  for (const target of [
    "/alias/esbuild/lib/main.js",
    "/installed/esbuild/lib/../lib/main.js",
    "/installed/vitest/dist/workers/vmThreads.js",
    "/arbitrary/worker.js",
  ])
    assert.equal(workerDenialCode(ctx, target, {}), "worker-thread");
  assert.equal(
    workerDenialCode(ctx, ctx.esbuildFile, { eval: true }),
    "worker-thread",
  );
  assert.equal(
    workerDenialCode(ctx, reviewedMiniflareWorkerScript, { eval: false }),
    "worker-thread",
  );
  assert.equal(
    workerDenialCode({ ...ctx, esbuildFile: null }, ctx.esbuildFile, {}),
    "worker-thread",
  );
});
test("worker inline source edits, wrong hashes, hash failures and unrecognized inputs stay generic", () => {
  const ctx = workerDiagnostics();
  const altered = reviewedMiniflareWorkerScript.replace(
    "port.start();",
    "port.close();",
  );
  assert.equal(altered.length, reviewedMiniflareWorkerScript.length);
  for (const source of [
    altered,
    reviewedMiniflareWorkerScript + "synthetic-secret",
    "synthetic-secret",
    "https://example.invalid/?token=synthetic-secret",
  ])
    assert.equal(
      workerDenialCode(ctx, source, { eval: true }),
      "worker-thread",
    );
  assert.equal(
    workerDenialCode(
      { ...ctx, digest: () => "incorrect-hash" },
      reviewedMiniflareWorkerScript,
      { eval: true },
    ),
    "worker-thread",
  );
  assert.equal(
    workerDenialCode(
      {
        ...ctx,
        digest: () => {
          throw Error("synthetic-secret");
        },
      },
      reviewedMiniflareWorkerScript,
      { eval: true },
    ),
    "worker-thread",
  );
  let touched = 0;
  const hostile = {
    toString() {
      touched += 1;
      throw Error("synthetic-secret");
    },
  };
  assert.equal(workerDenialCode(ctx, hostile, {}), "worker-thread");
  const options = Object.defineProperty({}, "eval", {
    get() {
      touched += 1;
      throw Error("synthetic-secret");
    },
  });
  assert.equal(
    workerDenialCode(ctx, reviewedMiniflareWorkerScript, options),
    "worker-thread",
  );
  assert.equal(touched, 0);
});
test("all recognized and unknown worker constructor attempts still synchronously refuse", () => {
  const ctx = workerDiagnostics();
  let denied = 0;
  for (const [target, options, expected] of [
    [ctx.esbuildFile, {}, "worker-thread-esbuild-file"],
    [ctx.vitestThreadsFile, {}, "worker-thread-vitest-file"],
    [
      reviewedMiniflareWorkerScript,
      { eval: true },
      "worker-thread-miniflare-script",
    ],
    ["synthetic-secret", {}, "worker-thread"],
  ]) {
    assert.throws(
      () =>
        refuseWorkerCreation(ctx, target, options, (code) => {
          denied += 1;
          assert.equal(code, expected);
          assert.deepEqual(sanitizeDenial("worker-thread", code), {
            operation: "worker-thread",
            policyCode: code,
          });
          throw new PolicyViolation(code);
        }),
      PolicyViolation,
    );
  }
  assert.equal(denied, 4);
});

// Opt-in owner observation. No process or socket is created in these cases.
test("owner inspector permits only exact nested runtime ephemeral numeric loopback", () => {
  const ctx = context("test-worker");
  ctx.ownerInspector = true;
  const call = workerdCall(ctx);
  (call[1] as string[]).push("--inspector-addr=127.0.0.1:0");
  assert.equal(authorizeLaunch(ctx, "spawn", call).role, "workerd");
  assert.equal(authorizeLaunch(ctx, "spawn", workerdCall(ctx)).role, "workerd");
});
for (const flag of [undefined, false])
  test(`baseline inspector remains refused with flag ${flag}`, () => {
    const ctx = context("test-worker");
    ctx.ownerInspector = flag;
    const call = workerdCall(ctx);
    (call[1] as string[]).push("--inspector-addr=127.0.0.1:0");
    rejects(ctx, "spawn", call);
  });
for (const role of [
  "coordinator",
  "wrangler-bin",
  "wrangler-cli",
] as HostRole[])
  test(`owner inspector refused from ${role}`, () => {
    const ctx = context(role);
    ctx.ownerInspector = true;
    const call = workerdCall(ctx);
    (call[1] as string[]).push("--inspector-addr=127.0.0.1:0");
    rejects(ctx, "spawn", call);
  });
for (const option of [
  "--inspector-addr=0.0.0.0:0",
  "--inspector-addr=localhost:0",
  "--inspector-addr=127.0.0.1:9229",
  "--inspector-addr=[::1]:0",
  "--inspector-addr=203.0.113.1:0",
  "--inspector-addr=127.0.0.1:0 --help",
  "--inspect",
])
  test(`owner inspector refuses altered fixed option ${option}`, () => {
    const ctx = context("test-worker");
    ctx.ownerInspector = true;
    const call = workerdCall(ctx);
    (call[1] as string[]).push(option);
    rejects(ctx, "spawn", call);
  });
test("owner inspector refuses root runtime identity and extra arguments", () => {
  const ctx = context("test-worker");
  ctx.ownerInspector = true;
  const call = workerdCall(ctx);
  (call[1] as string[]).push("--inspector-addr=127.0.0.1:0");
  ctx.native[1]!.packagePath = "node_modules/@cloudflare/workerd-linux-64";
  rejects(ctx, "spawn", call);
  ctx.native[1]!.packagePath =
    "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64";
  ctx.native[1]!.version = "1.20260907.1";
  rejects(ctx, "spawn", call);
  ctx.native[1]!.version = "1.20260730.1";
  (call[1] as string[]).push("--help");
  rejects(ctx, "spawn", call);
});

for (const value of ["true", 1, {}, null])
  test(`owner inspector refuses nonboolean gate ${typeof value}`, () => {
    const ctx = context("test-worker");
    ctx.ownerInspector = value as never;
    const call = workerdCall(ctx);
    (call[1] as string[]).push("--inspector-addr=127.0.0.1:0");
    rejects(ctx, "spawn", call);
  });
test("owner inspector refuses reordered and duplicate fixed flags", () => {
  const ctx = context("test-worker");
  ctx.ownerInspector = true;
  for (const position of [0, 3, 6]) {
    const call = workerdCall(ctx);
    (call[1] as string[]).splice(position, 0, "--inspector-addr=127.0.0.1:0");
    rejects(ctx, "spawn", call);
  }
  const call = workerdCall(ctx);
  (call[1] as string[]).push(
    "--inspector-addr=127.0.0.1:0",
    "--inspector-addr=127.0.0.1:0",
  );
  rejects(ctx, "spawn", call);
});
