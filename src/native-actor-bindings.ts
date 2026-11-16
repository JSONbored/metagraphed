import type {
  NativeSource,
  NativeExecutionContext,
} from "./native-api-process.ts";
import type { NativeInternalService } from "./native-application.ts";
import type { NativeRuntimeSettings } from "./native-runtime-settings.ts";
import { nativeSource } from "./native-source-manifest.ts";
import {
  createPgSubnetStatusHub,
  type NativeSubnetStatusOptions,
} from "./pg-subnet-status-hub.ts";
import {
  createNativeAlerter,
  type NativeAlerterOptions,
} from "./native-alerter.ts";
import {
  createNativeAlertOutbound,
  type NativeAlertOutboundOptions,
} from "./native-alert-outbound.ts";
import {
  createNativeChainFirehose,
  type NativeChainOptions,
} from "./native-chain-firehose.ts";
import {
  createNativeMcpSessions,
  type NativeMcpSessionOptions,
} from "./native-mcp-sessions.ts";
import type { ChainHeadProvider } from "./native-chain-head.ts";
import type { McpSessionService } from "./mcp-session-service.ts";
import type { NativeCronOwner } from "./pg-cron.ts";

export interface NativeActorLimits {
  status: Omit<NativeSubnetStatusOptions, "notify" | "onBackgroundError">;
  alerter: Omit<
    NativeAlerterOptions,
    "dataApi" | "outbound" | "secrets" | "onBackgroundError"
  >;
  outbound: Pick<
    NativeAlertOutboundOptions,
    "timeoutMillis" | "maxRequestBytes" | "maxResponseBytes"
  >;
  chain: Omit<
    NativeChainOptions,
    | "head"
    | "sessions"
    | "alerter"
    | "telemetry"
    | "onBackgroundError"
    | "headPollEnabled"
    | "headPollIntervalMillis"
  >;
  sessions: Omit<
    NativeMcpSessionOptions,
    "subnetStatus" | "chainFirehose" | "onBackgroundError"
  >;
}
export type NativeBackgroundInvocation = <Result>(
  owner: NativeCronOwner,
  operation: (context: NativeExecutionContext) => Promise<Result>,
  signal?: AbortSignal,
) => Promise<Result>;

/** Construct real actor owners in dependency order. The only forward edge is
 * guarded; invoking it before the last owner is bound fails visibly. */
export async function createNativeActorBindings(
  sources: ReadonlyMap<string, NativeSource>,
  data: NativeInternalService,
  head: ChainHeadProvider,
  settings: NativeRuntimeSettings,
  limits: NativeActorLimits,
  background: NativeBackgroundInvocation,
  onStartupCleanup: (cleanup: () => Promise<void>) => void,
  onBackgroundError: (error: unknown) => void,
) {
  const realtime = nativeSource(sources, "realtime");
  const channels = await nativeSource(sources, "app").read.query<{
    channel: string;
  }>(
    "SELECT DISTINCT channel FROM app.chain_alert_triggers WHERE active UNION SELECT 'webpush' WHERE EXISTS(SELECT 1 FROM app.watch_push_subscriptions)",
  );
  const credentials = {
    webhook: [],
    discord: [],
    telegram: ["TELEGRAM_BOT_TOKEN"],
    email: ["RESEND_API_KEY", "RESEND_FROM_ADDRESS"],
    webpush: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"],
  } as const;
  for (const { channel } of channels) {
    if (!Object.hasOwn(credentials, channel))
      throw new Error("Native alert channel is unsupported");
    for (const key of credentials[channel as keyof typeof credentials])
      if (!settings[key]?.trim())
        throw new Error(`Native alert channel requires setting: ${key}`);
  }
  let sessions:
    Awaited<ReturnType<typeof createNativeMcpSessions>> | undefined = undefined;
  const sessionService: McpSessionService = {
    fetch(id, request) {
      if (!sessions)
        return Promise.reject(new Error("Native MCP actor is not bound"));
      return sessions.fetch(id, request);
    },
  };
  const status = await createPgSubnetStatusHub(realtime, {
    ...limits.status,
    onBackgroundError,
    async notify(id, uri, signal) {
      const response = await sessionService.fetch(
        id,
        new Request("https://mcp-session-hub.internal/notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uri }),
          signal,
        }),
      );
      await response.body?.cancel();
      if (!response.ok) throw new Error("Native MCP notification was rejected");
    },
  });
  onStartupCleanup(() => status.close());
  const alerter = await createNativeAlerter(realtime, {
    ...limits.alerter,
    dataApi: data,
    outbound: createNativeAlertOutbound(limits.outbound),
    secrets: settings,
    onBackgroundError,
  });
  onStartupCleanup(() => alerter.close());
  const chain = await createNativeChainFirehose(realtime, {
    ...limits.chain,
    head,
    sessions: sessionService,
    alerter,
    telemetry: settings,
    headPollEnabled: settings.CHAIN_HEAD_POLL_ENABLED === "true",
    headPollIntervalMillis: Number(settings.CHAIN_HEAD_POLL_INTERVAL_MS),
    onBackgroundError,
  });
  onStartupCleanup(() => chain.close());
  sessions = await createNativeMcpSessions(realtime, {
    ...limits.sessions,
    subnetStatus: status,
    chainFirehose: chain,
    onBackgroundError,
  });
  const mcp = sessions;
  onStartupCleanup(() => mcp.close());
  return {
    bindings: Object.freeze({
      SUBNET_STATUS_SERVICE: status,
      ALERTER_SERVICE: alerter,
      CHAIN_FIREHOSE_SERVICE: chain,
      MCP_SESSION_SERVICE: mcp,
    }),
    chain,
    maintenance: {
      mcp: {
        runDueAlarms: (limit: number) =>
          background("api", () => mcp.runDueAlarms(limit)),
      },
      chain: {
        runDueAlarm: () => background("api", () => chain.runDueAlarm()),
      },
    },
  };
}
