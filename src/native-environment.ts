import {
  createNativeApplication,
  type NativeApplicationOptions,
} from "./native-application.ts";
import {
  nativeSourceDefinitions,
  nativeSource,
  assertNativeSequencePrivileges,
  type NativeSourceOwners,
} from "./native-source-manifest.ts";
import { nativeSettingsByOwner } from "./native-runtime-settings.ts";
import {
  createNativeStateBindings,
  type NativeStateLimits,
} from "./native-state-bindings.ts";
import {
  createNativeActorBindings,
  type NativeActorLimits,
  type NativeBackgroundInvocation,
} from "./native-actor-bindings.ts";
import { createNativeAuthControls } from "./native-auth-controls.ts";
import { NATIVE_RATE_POLICIES } from "./native-rate-policies.ts";
import { createPgKv } from "./pg-kv.ts";
import { createSqliteDocumentDecoder } from "./sqlite-document-decoder.ts";
import { createPgStateExport } from "./pg-state-export.ts";
import {
  createNativeStaticAssets,
  type NativeStaticAssetOptions,
} from "./native-static-assets.ts";
import {
  createFilesystemArchiveContent,
  type ArchiveContentOptions,
} from "./archive-content-fs.ts";
import {
  createNativeAiInference,
  type NativeInferenceOptions,
} from "./native-ai-inference.ts";
import {
  createPgSemanticIndex,
  type SemanticIndexOptions,
} from "./semantic-index-pg.ts";
import { createNativeChainHeadSource } from "./native-chain-head.ts";
import { createPgQueueTransport, type PgQueueLimits } from "./pg-queue.ts";
import { createPgCronScheduler, type NativeCronLimits } from "./pg-cron.ts";
import { NATIVE_CRON_DEFINITIONS } from "./native-cron-definitions.ts";
import {
  createNativeBackgroundLoops,
  type NativeBackgroundOptions,
} from "./native-background-loops.ts";
import type { NativeOAuthModule } from "./native-oauth-provider.ts";

type Application = Awaited<ReturnType<typeof createNativeApplication>>;
type Actors = Awaited<ReturnType<typeof createNativeActorBindings>>;
type LoopPolicy = Pick<
  NativeBackgroundOptions,
  | "cadence"
  | "cronRunners"
  | "mcpAlarmBatch"
  | "authPruneBatch"
  | "stopTimeoutMillis"
>;

export interface NativeEnvironmentOptions extends Pick<
  NativeApplicationOptions,
  | "postgres"
  | "maxRequests"
  | "maxJobs"
  | "drainTimeoutMillis"
  | "internal"
  | "onBackgroundError"
> {
  owners: NativeSourceOwners;
  settings: unknown;
  exportIdentity: string;
  headRequestTimeoutMillis: number;
  decoder: { maxAuditBytes: number };
  oauthModule: NativeOAuthModule;
  staticAssets: NativeStaticAssetOptions;
  archiveContent: ArchiveContentOptions;
  inference: NativeInferenceOptions;
  semanticIndex: SemanticIndexOptions;
  state: NativeStateLimits;
  actors: NativeActorLimits;
  queues: PgQueueLimits;
  cron: NativeCronLimits;
  loops: LoopPolicy;
}

/** Concrete native assembly. Configuration may supply values and resource
 * budgets, never replacement stores or an environment-validation callback. */
export async function createNativeEnvironment(
  requested: NativeEnvironmentOptions,
  poolFactory?: Parameters<typeof createNativeApplication>[1],
) {
  // Validator detail always reads five independent native inputs concurrently.
  if (requested.postgres.maxConnections < 5)
    throw new RangeError(
      "Native environment requires at least five PostgreSQL connections for its enabled read fanout",
    );
  const sources = nativeSourceDefinitions(requested.owners);
  const settings = nativeSettingsByOwner(requested.settings);
  const exportIdentity = requested.exportIdentity;
  const headRequestTimeoutMillis = requested.headRequestTimeoutMillis;
  const report = requested.onBackgroundError;
  const decoderOptions = { ...requested.decoder };
  const staticOptions = { ...requested.staticAssets };
  const contentOptions = { ...requested.archiveContent };
  const inferenceOptions = {
    ...requested.inference,
    identity: {
      embedding: { ...requested.inference.identity.embedding },
      completion: { ...requested.inference.identity.completion },
    },
    embedding: { ...requested.inference.embedding },
    completion: { ...requested.inference.completion },
  };
  const indexOptions = { ...requested.semanticIndex };
  if (
    indexOptions.model !== inferenceOptions.identity.embedding.model ||
    indexOptions.dimensions !== inferenceOptions.identity.embedding.dimensions
  )
    throw new Error("Native inference and semantic index identities differ");
  const stateOptions = {
    capture: { ...requested.state.capture },
    rpcUsage: { ...requested.state.rpcUsage },
    validatorHistory: { ...requested.state.validatorHistory },
  };
  const actorOptions = {
    status: { ...requested.actors.status },
    alerter: { ...requested.actors.alerter },
    outbound: { ...requested.actors.outbound },
    chain: { ...requested.actors.chain },
    sessions: { ...requested.actors.sessions },
  };
  const queueOptions = { ...requested.queues };
  const cronOptions = { ...requested.cron };
  const loopOptions = {
    ...requested.loops,
    cadence: { ...requested.loops.cadence },
  };
  let application: Application | undefined = undefined;
  let actors!: Actors;
  let loops!: ReturnType<typeof createNativeBackgroundLoops>;
  let authentication!: ReturnType<typeof createNativeAuthControls>;
  const current = (): Application => {
    if (!application) throw new Error("Native application is not bound");
    return application;
  };
  const background: NativeBackgroundInvocation = (owner, operation, signal) =>
    current().background(owner, operation, signal);
  const owners: NativeBackgroundOptions["owners"] = {
    api: {
      scheduled: (event, signal) =>
        current().owners.api.scheduled(event, signal),
      queue: (batch, signal) => current().owners.api.queue(batch, signal),
    },
    data: {
      scheduled: (event, signal) =>
        current().owners.data.scheduled(event, signal),
      queue: (batch, signal) => current().owners.data.queue(batch, signal),
    },
    registry: {
      scheduled: (event, signal) =>
        current().owners.registry.scheduled(event, signal),
    },
  };
  application = await createNativeApplication(
    {
      postgres: { ...requested.postgres },
      maxRequests: requested.maxRequests,
      maxJobs: requested.maxJobs,
      drainTimeoutMillis: requested.drainTimeoutMillis,
      internal: { ...requested.internal },
      sources,
      onBackgroundError: report,
      oauth: { module: requested.oauthModule, source: "auth" },
      kv({ sources }) {
        const auth = nativeSource(sources, "auth");
        authentication = createNativeAuthControls(
          auth,
          NATIVE_RATE_POLICIES,
          report,
        );
        return {
          control: authentication.bindings.CONTROL_KV_STORE,
          oauthPending: createPgKv(auth, "oauth-pending"),
        };
      },
      async compose(providers) {
        await assertNativeSequencePrivileges(providers.sources);
        const pending: (() => Promise<void>)[] = [];
        const own = (cleanup: () => Promise<void>) => {
          pending.push(cleanup);
          providers.onStartupCleanup(cleanup);
        };
        let closing: Promise<void> | undefined;
        const close = () => {
          if (closing) return closing;
          closing = (async () => {
            while (pending.length) {
              await pending[pending.length - 1]!();
              pending.pop();
            }
          })();
          void closing.catch(() => {
            closing = undefined;
          });
          return closing;
        };
        const app = nativeSource(providers.sources, "app");
        const decoder = createSqliteDocumentDecoder(decoderOptions);
        own(async () => decoder.close());
        const state = createNativeStateBindings(
          providers.sources,
          decoder,
          stateOptions,
          own,
        );
        const exported = createPgStateExport(app, decoder, {
          identity: exportIdentity,
        });
        const content = await createFilesystemArchiveContent(contentOptions);
        const assets = await createNativeStaticAssets(staticOptions);
        own(() => assets.close());
        const inference = createNativeAiInference(inferenceOptions);
        own(() => inference.close());
        const index = await createPgSemanticIndex(
          nativeSource(providers.sources, "search"),
          indexOptions,
        );
        const head = createNativeChainHeadSource(app, {
          rpcUrl: settings.api.CHAIN_HEAD_RPC_URL!,
          requestTimeoutMillis: headRequestTimeoutMillis,
          withAuthor: settings.api.CHAIN_HEAD_AUTHOR_ENABLED === "true",
          withEventCount:
            settings.api.CHAIN_HEAD_EVENT_COUNT_ENABLED === "true",
          fetch,
          now: Date.now,
          laneHealthDb: state.bindings.LANE_HEALTH_STORE,
        });
        actors = await createNativeActorBindings(
          providers.sources,
          providers.services.data,
          head,
          settings.api,
          actorOptions,
          background,
          own,
          report,
        );
        const jobs = nativeSource(providers.sources, "jobs");
        const queues = await createPgQueueTransport(jobs, queueOptions);
        own(() => queues.close());
        const cron = await createPgCronScheduler(
          jobs,
          NATIVE_CRON_DEFINITIONS,
          cronOptions,
        );
        own(() => cron.close());
        loops = createNativeBackgroundLoops({
          ...loopOptions,
          cron,
          queues,
          owners,
          ...actors.maintenance,
          rpc: state.rpcUsage,
          auth: authentication,
          onError: (error, loop) =>
            report(
              new Error(`Native background loop failed: ${loop}`, {
                cause: error,
              }),
            ),
        });
        own(() => loops.stop());
        const common = {
          ...authentication.bindings,
          ...state.bindings,
          ...actors.bindings,
          OAUTH_PENDING_STORE: providers.kv.oauthPending,
          METAGRAPH_CONTROL: providers.kv.control,
          NATIVE_STATE_EXPORT: exported,
          ASSETS: assets,
          ARCHIVE_CONTENT_STORE: content,
          AI_INFERENCE: inference,
          SEMANTIC_INDEX: index,
          PROBE_JOBS: queues.binding("probe-jobs"),
          WEBHOOK_DELIVERIES: queues.binding("webhook-deliveries"),
          SYNC_BATCHES: queues.binding("sync-batches"),
        };
        const environments = {
          api: {
            ...settings.api,
            ...common,
            DATA_API: providers.services.data,
            REGISTRY_SYNC_API: providers.services.registry,
          },
          data: { ...settings.data, ...common },
          registry: { ...settings.registry, ...common },
        };
        return {
          environments,
          assertEnvironment(selected) {
            for (const owner of ["api", "data", "registry"] as const) {
              const expected = environments[owner];
              const actual = selected[owner];
              if (
                Object.keys(actual).length !== Object.keys(expected).length ||
                Object.entries(expected).some(
                  ([name, value]) => Reflect.get(actual, name) !== value,
                )
              )
                throw new Error(
                  `Native ${owner} environment differs from its constructed capabilities`,
                );
              authentication.assertEnvironment(actual);
            }
          },
          stop: () => loops.stop(),
          close,
        };
      },
    },
    poolFactory,
  );
  return {
    get state() {
      return current().state;
    },
    fetch: (request: Request) => current().fetch(request),
    owners: current().owners,
    background,
    chain: actors.chain,
    startBackground(boundary: number) {
      if (current().state !== "ready")
        return Promise.reject(new Error("Native application is not ready"));
      return loops.start(boundary);
    },
    close: () => current().close(),
  };
}
