/** The process. One composed application, its listener, and an orderly stop.
 *
 * `createNativeEnvironment` and `createNativeApplication` were only ever called
 * from `tests/`, and no module carried a `main()`, so the native application
 * could be constructed but never *run*. This is that entry point, and it is
 * deliberately thin: the composition, the capability split and every budget
 * already live below it.
 *
 * The profile decides the shape (infra#882):
 *
 * - `serving` composes the public HTTP app and the realtime actor under the
 *   narrow credential, so it listens. The producer surfaces refuse by name.
 * - `producer` composes the cron/queue/prune side under the writer credential.
 *   It starts **no listener** — the fleet declaration says "no public listener
 *   anywhere" for this lane, and a bound port here would quietly contradict it.
 * - `trusted` is the single-process shape: it listens and runs the loops.
 *
 * The listener binds loopback by default. The free Cloudflare Tunnel is the
 * ingress (MET-7208), and `cloudflared` runs beside this task on the same host,
 * so a public bind would add exposure that buys nothing.
 */
import {
  configCount,
  configText,
  nativeConfig,
  requiredText,
  type NativeConfigSource,
} from "./native-config.ts";
import { createNativeEnvironment } from "./native-environment.ts";
import { listenNativeApi } from "./native-http-server.ts";

/** Exit codes a supervisor can act on, rather than one opaque failure. */
const EXIT_CONFIGURATION = 78; // EX_CONFIG: the declaration is wrong, a retry cannot help.
const EXIT_RUNTIME = 70; // EX_SOFTWARE: it started and then failed.

function listenerOptions(env: NativeConfigSource, onError: (e: unknown) => void) {
  return {
    // The public origin the application builds absolute URLs from; not the
    // bind address, which is loopback below.
    origin: requiredText(env, "METAGRAPHED_ORIGIN"),
    hostname: configText(env, "METAGRAPHED_LISTEN_HOSTNAME", "127.0.0.1"),
    port: configCount(env, "METAGRAPHED_LISTEN_PORT", 8080),
    maxRequestBytes: configCount(
      env,
      "METAGRAPHED_LISTEN_REQUEST_BYTES",
      8 * 1024 * 1024,
    ),
    requestTimeoutMillis: configCount(
      env,
      "METAGRAPHED_LISTEN_REQUEST_TIMEOUT_MS",
      // Cloudflare Free terminates an origin read at 100 s where the retired
      // Enterprise plan allowed 125 s, so the origin gives up first and the
      // edge reports our own status rather than a 524.
      90_000,
    ),
    headersTimeoutMillis: configCount(
      env,
      "METAGRAPHED_LISTEN_HEADERS_TIMEOUT_MS",
      20_000,
    ),
    onError,
  };
}

export interface NativeProcessHandle {
  readonly profile: string;
  readonly address: string | undefined;
  stop(): Promise<void>;
}

/** Build, start and return a handle. Separated from the signal wiring so a test
 * can start and stop a process without installing handlers in its own runtime. */
export async function startNativeProcess(
  env: NativeConfigSource = process.env,
): Promise<NativeProcessHandle> {
  const failures: unknown[] = [];
  const report = (error: unknown, origin = "native") => {
    failures.push(error);
    console.error(`native failure in ${origin}:`, error);
  };
  const options = await nativeConfig(env, { onBackgroundError: report });
  const application = await createNativeEnvironment(options);
  const profile = options.profile ?? "trusted";
  const listen = listenerOptions(env, (error) => report(error, "listener"));

  let listener: { address: { port: number }; close(): Promise<void> } | undefined;
  if (profile !== "producer") listener = await listenNativeApi(application, listen);

  // Background work starts only once the listener is up, so a serving process
  // that cannot bind never takes a lease it would have to give back.
  application.startBackground(
    configCount(env, "METAGRAPHED_BACKGROUND_BOUNDARY", 0),
  );

  const address = listener
    ? `${listen.hostname}:${listener.address.port}`
    : undefined;
  console.log(
    `metagraphed ${profile} ready${address ? ` on ${address}` : " (no listener)"}`,
  );

  let stopped: Promise<void> | undefined;
  return {
    profile,
    address,
    // Idempotent: a SIGTERM during a SIGINT drain must not start a second one.
    stop: () =>
      (stopped ??= (async () => {
        // The listener first, so no request arrives for a closing application;
        // then the application, which owns the loops', queues' and actors' own
        // drains and their declared timeouts.
        await listener?.close().catch((error) => report(error, "listener-close"));
        await application.close();
      })()),
  };
}

async function main(): Promise<void> {
  let handle: NativeProcessHandle;
  try {
    handle = await startNativeProcess();
  } catch (error) {
    console.error("metagraphed failed to start:", error);
    process.exitCode = EXIT_CONFIGURATION;
    return;
  }
  const stop = (signal: string) => {
    console.log(`metagraphed ${handle.profile} draining on ${signal}`);
    handle.stop().then(
      () => process.exit(0),
      (error) => {
        console.error("metagraphed failed to drain:", error);
        process.exit(EXIT_RUNTIME);
      },
    );
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => stop(signal));
}

// Run only as a program, never on import, so the tests above can use the
// exported starter without a listener appearing in the test runtime.
if (process.argv[1] && import.meta.filename === process.argv[1]) await main();
