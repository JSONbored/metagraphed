// Pure decision layer. No process launch, socket, filesystem, or network APIs.
// Publication-safe fixed diagnostics. Do not add caller data to either list.
export const DENIAL_OPERATIONS = Object.freeze([
  "socket-policy",
  "TLS",
  "DNS lookup",
  "DNS query",
  "DNS resolver",
  "UDP socket",
  "UDP connect",
  "UDP send",
  "process-spawn",
  "process-spawnSync",
  "process-fork",
  "process-exec",
  "process-execSync",
  "process-execFile",
  "process-execFileSync",
  "direct-child-spawn",
  "worker-thread",
  "missing-child-lifecycle",
] as const);
export const POLICY_CODES = Object.freeze([
  "absolute-executable-required",
  "accessor-option",
  "argument-shape",
  "base-environment-value",
  "base-path",
  "call-shape",
  "changed-base-environment",
  "cyclic-socket-shape",
  "esbuild-api",
  "esbuild-options",
  "esbuild-service-arguments",
  "esbuild-stdio",
  "esbuild-sync-arguments",
  "esbuild-sync-options",
  "esbuild-version",
  "external-socket-host",
  "fork-arguments",
  "fork-entry",
  "inherited-option",
  "launch-policy-internal-error",
  "missing-option",
  "native-identity",
  "node-api",
  "node-entry",
  "options-shape",
  "result-path",
  "runtime-environment-id",
  "shell-api",
  "shell-option",
  "socket-fd",
  "socket-shape",
  "unexpected-environment",
  "unexpected-option",
  "unresolved-executable",
  "vitest-exec-arguments",
  "vitest-fork-options",
  "workerd-api",
  "workerd-argument-count",
  "workerd-entry-address",
  "workerd-identity",
  "workerd-input",
  "workerd-loopback-address",
  "workerd-options",
  "workerd-serve",
  "workerd-stdio",
  "working-directory",
  "wrangler-argument-count",
  "wrangler-bin-launch",
  "wrangler-bin-options",
  "wrangler-cli-launch",
  "wrangler-cli-stdio",
  "wrangler-dryrun-shape",
  "wrangler-env-file-not-empty",
  "wrangler-environment-value",
  "wrangler-node-prefix",
  "wrangler-original-arguments",
  "wrangler-output-path",
  "wrangler-output-root",
  "socket-policy-internal-error",
  "tls-denied",
  "dns-name",
  "dns-query",
  "udp-denied",
  "direct-child-spawn",
  "worker-thread",
  "missing-child-lifecycle",
] as const);
export type PolicyCode = (typeof POLICY_CODES)[number];
export type DenialOperation = (typeof DENIAL_OPERATIONS)[number];
export function sanitizeDenial(
  operation: unknown,
  policyCode: unknown,
): Readonly<{
  operation: DenialOperation | "other";
  policyCode: PolicyCode | "other";
}> {
  return Object.freeze({
    operation:
      typeof operation === "string" &&
      (DENIAL_OPERATIONS as readonly string[]).includes(operation)
        ? (operation as DenialOperation)
        : "other",
    policyCode:
      typeof policyCode === "string" &&
      (POLICY_CODES as readonly string[]).includes(policyCode)
        ? (policyCode as PolicyCode)
        : "other",
  });
}
export type LaunchApi =
  | "spawn"
  | "spawnSync"
  | "fork"
  | "exec"
  | "execSync"
  | "execFile"
  | "execFileSync";
export type HostRole =
  "coordinator" | "test-worker" | "wrangler-bin" | "wrangler-cli";
export interface NativeExecutable {
  path: string;
  sha256: string;
  version: string;
  packagePath: string;
}
export interface PolicyContext {
  root: string;
  home: string;
  preload: string;
  node: string;
  vitestEntry: string;
  vitestWorker: string;
  vitestSuppress: string;
  wranglerBin: string;
  wranglerCli: string;
  role: HostRole;
  baseEnv: Record<string, string>;
  inheritedEnv: Record<string, string | undefined>;
  processArgs: string[];
  native: NativeExecutable[];
  resolve(file: string): string | null;
  digest(file: string): string;
  isEmptyFile(file: string): boolean;
}
export interface AuthorizedLaunch {
  call: unknown[];
  kind: "node" | "native";
  role:
    "vitest-worker" | "wrangler-bin" | "wrangler-cli" | "esbuild" | "workerd";
  amended: boolean;
}
export class PolicyViolation extends Error {
  readonly code: PolicyCode | "other";
  constructor(code: unknown) {
    const sanitized = sanitizeDenial(undefined, code).policyCode;
    super(sanitized);
    this.code = sanitized;
    this.name = "PolicyViolation";
  }
}
// Never stringify rejected caller data: it may contain credentials or execute
// a caller-controlled toString/getter. These are the only receipt categories.
export function refusalTargetCategory(value: unknown): string {
  return value === null || value === undefined ? "missing" : typeof value;
}
// Exported launch adapters call this around the original Node API. Only the
// single synchronous internal ChildProcess.spawn belonging to that call may
// pass the prototype hook. Direct construction cannot reuse the permission.
export function createLaunchGate(deny: () => never): {
  run<T>(launch: () => T): T;
  consume(): void;
} {
  let active = false;
  let available = false;
  return {
    run<T>(launch: () => T): T {
      if (active) return deny();
      active = true;
      available = true;
      try {
        return launch();
      } finally {
        active = false;
        available = false;
      }
    },
    consume(): void {
      if (!active || !available) return deny();
      available = false;
    },
  };
}
export interface ChildLifecycle {
  pid?: number;
  once?: (
    event: "exit" | "close",
    listener: (code: number | null, signal: string | null) => void,
  ) => unknown;
}
export function observeChildLifecycle(
  child: ChildLifecycle | undefined,
  exited: (code: number | null, signal: string | null) => void,
  closed: (code: number | null, signal: string | null) => void,
  deny: () => never,
): void {
  if (typeof child?.once !== "function") return deny();
  // Install before returning the child to Wrangler, whose own exit listener
  // immediately exits the wrapper process and may prevent close delivery.
  child.once("exit", exited);
  child.once("close", closed);
}
function need(value: unknown, code: PolicyCode): asserts value {
  if (!value) throw new PolicyViolation(code);
}
function object(value: unknown): Record<string, unknown> {
  need(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "options-shape",
  );
  const result = value as Record<string, unknown>;
  for (const key in result)
    need(Object.hasOwn(result, key), "inherited-option");
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(result),
  ))
    need(!descriptor.get && !descriptor.set, "accessor-option");
  return result;
}
function strings(value: unknown): string[] {
  need(Array.isArray(value), "argument-shape");
  const result: unknown[] = Array.from(value);
  need(
    result.every((item) => typeof item === "string"),
    "argument-shape",
  );
  return result as string[];
}
function equal(actual: unknown, expected: unknown, code: PolicyCode): void {
  need(JSON.stringify(actual) === JSON.stringify(expected), code);
}
function keys(
  value: Record<string, unknown>,
  allowed: string[],
  required = allowed,
): void {
  need(
    Object.keys(value).every((key) => allowed.includes(key)),
    "unexpected-option",
  );
  need(
    required.every((key) => Object.hasOwn(value, key)),
    "missing-option",
  );
}
const BASE_KEYS = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "CI",
  "NODE_ENV",
  "CLOUDFLARE_CF_FETCH_ENABLED",
  "CLOUDFLARE_AUTH_USE_KEYRING",
  "WRANGLER_SEND_METRICS",
  "DECODER_QUALIFICATION_ROOT",
  "DECODER_QUALIFICATION_PRELOAD",
  "DECODER_QUALIFICATION_RESULT",
];
export function validateBaseEnvironment(context: PolicyContext): void {
  const env = object(context.baseEnv) as Record<string, string>;
  keys(env, BASE_KEYS);
  need(
    typeof env.PATH === "string" &&
      env.PATH.length > 0 &&
      !env.PATH.includes("\0"),
    "base-path",
  );
  const fixed: Record<string, string> = {
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
  };
  for (const [key, value] of Object.entries(fixed))
    need(env[key] === value, "base-environment-value");
  need(env.DECODER_QUALIFICATION_RESULT?.startsWith("/"), "result-path");
}
function runtimeEnvironment(
  context: PolicyContext,
  raw: unknown,
  mode: "host" | "workerd" = "host",
): void {
  const env = object(raw);
  for (const [key, value] of Object.entries(context.baseEnv))
    need(env[key] === value, "changed-base-environment");
  const exact: Record<string, string[]> = {
    TEST: ["true"],
    VITEST: ["true"],
    VITEST_MODE: ["RUN"],
    FORCE_TTY: ["", "true"],
    SSR: ["", "1"],
    NODE_CHANNEL_SERIALIZATION_MODE: ["advanced"],
    ...(mode === "workerd" ? { TZ: ["UTC"], FORCE_COLOR: ["0", "1"] } : {}),
  };
  for (const [key, value] of Object.entries(env)) {
    if (Object.hasOwn(context.baseEnv, key)) continue;
    if (
      ["VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_CHANNEL_FD"].includes(key)
    ) {
      need(
        typeof value === "string" && /^\d{1,6}$/.test(value),
        "runtime-environment-id",
      );
    } else
      need(
        typeof value === "string" && exact[key]?.includes(value),
        "unexpected-environment",
      );
  }
}
function wranglerArguments(
  context: PolicyContext,
  raw: string[],
): { args: string[]; outdir: string } {
  need(raw.length === 11, "wrangler-argument-count");
  const output = raw[7]!;
  need(
    output.startsWith("/") && output.endsWith("/upload.multipart"),
    "wrangler-output-path",
  );
  const outdir = output.slice(0, -"/upload.multipart".length);
  need(
    !outdir.includes("/../") &&
      /\/data-api-quarantine-isolate-[^/]+$/.test(outdir),
    "wrangler-output-root",
  );
  equal(
    raw,
    [
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
    ],
    "wrangler-dryrun-shape",
  );
  need(
    context.isEmptyFile(`${outdir}/empty.env`),
    "wrangler-env-file-not-empty",
  );
  return { args: raw, outdir };
}
function wranglerEnvironment(
  context: PolicyContext,
  raw: unknown,
  outdir: string,
): void {
  const env = object(raw);
  const expected: Record<string, string> = {
    PATH: context.baseEnv.PATH!,
    HOME: context.home,
    CI: "true",
    NODE_ENV: "production",
    XDG_CONFIG_HOME: `${outdir}/config`,
    XDG_CACHE_HOME: `${outdir}/cache`,
    CLOUDFLARE_AUTH_USE_KEYRING: "false",
    WRANGLER_SEND_METRICS: "false",
  };
  keys(env, Object.keys(expected));
  for (const [key, value] of Object.entries(expected))
    need(env[key] === value, "wrangler-environment-value");
}
function effectiveEnvironment(
  context: PolicyContext,
  options: Record<string, unknown>,
  mode: "host" | "workerd" = "host",
): void {
  const env = options.env ?? context.inheritedEnv;
  if (context.role.startsWith("wrangler")) {
    const { outdir } = wranglerArguments(context, context.processArgs);
    wranglerEnvironment(context, env, outdir);
  } else runtimeEnvironment(context, env, mode);
}
function nodePrefix(context: PolicyContext, prefix: string[]): void {
  // Official wrangler@4.129.1 wrapper blob:
  // 774ecc2ce6ecdd77cfb3555d4af0daf825e4c66d.
  equal(
    prefix,
    ["--no-warnings", "--import", context.preload],
    "wrangler-node-prefix",
  );
}
function loopbackAddress(value: string): boolean {
  const match = /^(?:127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(value);
  return Boolean(match && Number(match[1]) <= 65535);
}
export function authorizeLaunch(
  context: PolicyContext,
  api: LaunchApi,
  originalCall: unknown[],
): AuthorizedLaunch {
  validateBaseEnvironment(context);
  need(!["exec", "execSync"].includes(api), "shell-api");
  const call = [...originalCall];
  need(
    call.length === 3 ||
      (api === "execFile" &&
        call.length === 4 &&
        typeof call[3] === "function"),
    "call-shape",
  );
  const file = call[0];
  need(
    typeof file === "string" && file.startsWith("/"),
    "absolute-executable-required",
  );
  const args = Array.isArray(call[1]) ? strings(call[1]) : [];
  if (Array.isArray(call[1])) call[1] = args;
  const optionIndex = Array.isArray(call[1]) ? 2 : 1;
  const options =
    call[optionIndex] === undefined || typeof call[optionIndex] === "function"
      ? {}
      : object(call[optionIndex]);
  need(!options.shell, "shell-option");
  need(
    options.cwd === undefined || options.cwd === context.root,
    "working-directory",
  );
  const canonical = context.resolve(file);
  need(canonical, "unresolved-executable");
  if (api === "fork") {
    need(
      context.role === "coordinator" && canonical === context.vitestWorker,
      "fork-entry",
    );
    equal(args, [], "fork-arguments");
    keys(options, ["env", "execArgv", "stdio", "serialization"]);
    equal(
      options.execArgv,
      [
        "--experimental-import-meta-resolve",
        "--require",
        context.vitestSuppress,
        "--conditions",
        "module",
        "--conditions",
        "node",
        "--conditions",
        "development",
        "--import",
        context.preload,
      ],
      "vitest-exec-arguments",
    );
    need(
      options.stdio === "pipe" && options.serialization === "advanced",
      "vitest-fork-options",
    );
    runtimeEnvironment(context, options.env);
    return { call, kind: "node", role: "vitest-worker", amended: false };
  }
  if (canonical === context.node) {
    need(api === "spawn" || api === "execFile", "node-api");
    const scriptAt = args.findIndex(
      (arg) =>
        arg.startsWith("/") &&
        [context.wranglerBin, context.wranglerCli].includes(
          context.resolve(arg) ?? "",
        ),
    );
    need(scriptAt >= 0, "node-entry");
    const script = context.resolve(args[scriptAt]!)!;
    const dryrun = wranglerArguments(context, args.slice(scriptAt + 1));
    if (script === context.wranglerBin) {
      need(
        context.role === "test-worker" && api === "execFile" && scriptAt === 0,
        "wrangler-bin-launch",
      );
      keys(options, ["cwd", "env", "timeout", "maxBuffer"]);
      need(
        options.cwd === context.root &&
          options.timeout === 60000 &&
          options.maxBuffer === 1024 * 1024,
        "wrangler-bin-options",
      );
      wranglerEnvironment(context, options.env, dryrun.outdir);
      call[1] = ["--import", context.preload, ...args];
      return { call, kind: "node", role: "wrangler-bin", amended: true };
    }
    need(
      context.role === "wrangler-bin" && api === "spawn",
      "wrangler-cli-launch",
    );
    keys(options, ["stdio"]);
    nodePrefix(context, args.slice(0, scriptAt));
    equal(dryrun.args, context.processArgs, "wrangler-original-arguments");
    equal(
      options.stdio,
      ["inherit", "inherit", "inherit", "ipc"],
      "wrangler-cli-stdio",
    );
    wranglerEnvironment(context, context.inheritedEnv, dryrun.outdir);
    return { call, kind: "node", role: "wrangler-cli", amended: false };
  }
  const native = context.native.find((item) => item.path === canonical);
  need(
    native && context.digest(canonical) === native.sha256,
    "native-identity",
  );
  if (native.packagePath.endsWith("/@esbuild/linux-x64")) {
    need(native.version === "0.28.2", "esbuild-version");
    if (api === "spawn") {
      equal(args, ["--service=0.28.2", "--ping"], "esbuild-service-arguments");
      keys(options, ["windowsHide", "stdio", "cwd"]);
      need(
        options.windowsHide === true && options.cwd === context.root,
        "esbuild-options",
      );
      equal(options.stdio, ["pipe", "pipe", "inherit"], "esbuild-stdio");
    } else {
      need(api === "execFileSync", "esbuild-api");
      equal(args, ["--service=0.28.2"], "esbuild-sync-arguments");
      keys(options, ["windowsHide", "cwd", "input", "maxBuffer"]);
      need(
        options.windowsHide === true &&
          options.cwd === context.root &&
          options.maxBuffer === 16 * 1024 * 1024 &&
          options.input instanceof Uint8Array,
        "esbuild-sync-options",
      );
    }
    effectiveEnvironment(context, options);
    return { call, kind: "native", role: "esbuild", amended: false };
  }
  need(
    native.packagePath.endsWith("/@cloudflare/workerd-linux-64") &&
      ["1.20260730.1", "1.20260907.1"].includes(native.version),
    "workerd-identity",
  );
  need(api === "spawn", "workerd-api");
  need(args.length === 7, "workerd-argument-count");
  equal(
    args.slice(0, 3),
    ["serve", "--binary", "--experimental"],
    "workerd-serve",
  );
  need(
    args[3]!.startsWith("--socket-addr=entry=") &&
      loopbackAddress(args[3]!.slice("--socket-addr=entry=".length)),
    "workerd-entry-address",
  );
  need(
    args[4]!.startsWith("--external-addr=loopback=") &&
      loopbackAddress(args[4]!.slice("--external-addr=loopback=".length)),
    "workerd-loopback-address",
  );
  equal(args.slice(5), ["--control-fd=3", "-"], "workerd-input");
  keys(options, ["stdio", "windowsHide", "env"]);
  need(options.windowsHide === true, "workerd-options");
  equal(options.stdio, ["pipe", "pipe", "pipe", "pipe"], "workerd-stdio");
  effectiveEnvironment(context, options, "workerd");
  return { call, kind: "native", role: "workerd", amended: false };
}
export function invokeAuthorized<T>(
  context: PolicyContext,
  api: LaunchApi,
  call: unknown[],
  launch: (decision: AuthorizedLaunch) => T,
  deny: (code: string) => never,
): T {
  let decision: AuthorizedLaunch;
  try {
    decision = authorizeLaunch(context, api, call);
  } catch (error) {
    return deny(
      error instanceof PolicyViolation
        ? error.code
        : "launch-policy-internal-error",
    );
  }
  return launch(decision);
}
export function authorizeSocketConnect(args: unknown[]): void {
  let normalized = args;
  const seen = new Set<unknown[]>();
  while (Array.isArray(normalized[0])) {
    need(!seen.has(normalized), "cyclic-socket-shape");
    seen.add(normalized);
    normalized = normalized[0];
  }
  const first = normalized[0];
  const loopback = (host: unknown) =>
    need(host === "127.0.0.1" || host === "::1", "external-socket-host");
  if (first !== null && typeof first === "object") {
    const options = object(first);
    need(!("fd" in options), "socket-fd");
    if (typeof options.path === "string" && options.path.length > 0) return;
    loopback(options.host ?? "127.0.0.1");
  } else if (
    typeof first === "number" ||
    (typeof first === "string" &&
      !Number.isNaN(Number(first)) &&
      Number(first) >= 0)
  ) {
    loopback(typeof normalized[1] === "string" ? normalized[1] : "127.0.0.1");
  } else need(typeof first === "string" && first.length > 0, "socket-shape");
}
