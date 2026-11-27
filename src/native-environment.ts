import {
  createNativeApplication,
  type NativeApplicationOptions,
} from "./native-application.ts";
import {
  nativeSourceDefinitions,
  nativeSource,
  assertNativeDefinerPrivileges,
  assertNativeSequencePrivileges,
  type NativeProcessProfile,
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
import { NATIVE_CONFORMANCE_CONTRACT } from "./native-conformance-contract.ts";

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
  /** Which composition this process is (infra#882 part 2). "trusted" (the
   * default) is today's single-process shape. "serving" composes the public
   * HTTP app, the realtime actor component and the serving loops under the
   * narrow credential; the producer surfaces refuse by name. "producer"
   * composes the cron/queue/prune side under the writer credential; the
   * public listener and every actor refuse by name. */
  profile?: NativeProcessProfile;
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

/** The chain surface when (and only when) the composition owns the actor.
 * The producer profile's refusal lacks the owner surface by design; callers
 * that need the full actor narrow through this runtime guard instead of an
 * assertion. */
export function requireComposedChain(
  chain: Awaited<ReturnType<typeof createNativeEnvironment>>["chain"],
): Actors["chain"] {
  if (!("openSocket" in chain))
    throw new Error(
      "Native chain actor is not composed in this process (infra#882 split)",
    );
  return chain;
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
  const profile = requested.profile ?? "trusted";
  const sources = nativeSourceDefinitions(requested.owners, profile);
  // A surface the profile does not own refuses by name. Typed as honest
  // wide-parameter functions so every caller shape type-checks against the
  // union with the real surface -- no assertion erases the relationship.
  const refusal =
    (surface: string) =>
    (..._ignored: readonly unknown[]): Promise<never> =>
      Promise.reject(
        new Error(
          `Native ${surface} is not composed in the ${profile} process (infra#882 split)`,
        ),
      );
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
  interface RefusingService {
    fetch(...request: readonly unknown[]): Promise<Response>;
  }
  interface ProducerActorRefusals {
    bindings: Readonly<Record<keyof Actors["bindings"], RefusingService>>;
    chain: RefusingService;
    maintenance?: undefined;
  }
  let application: Application | undefined = undefined;
  let actors!: Actors | ProducerActorRefusals;
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
        await assertNativeDefinerPrivileges(providers.sources);
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
        if (profile === "producer") {
          // The realtime actor component is serving-owned whole (the #882
          // owner-split correction); every actor surface refuses by name.
          const refuse = (name: string): RefusingService =>
            Object.freeze({ fetch: refusal(name) });
          actors = {
            bindings: Object.freeze({
              SUBNET_STATUS_SERVICE: refuse("subnet-status actor"),
              ALERTER_SERVICE: refuse("alerter actor"),
              CHAIN_FIREHOSE_SERVICE: refuse("chain-firehose actor"),
              MCP_SESSION_SERVICE: refuse("MCP session actor"),
            }),
            chain: refuse("chain-firehose actor"),
            maintenance: undefined,
          };
        } else {
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
        }
        const jobs = nativeSource(providers.sources, "jobs");
        const queues = await createPgQueueTransport(jobs, queueOptions);
        own(() => queues.close());
        // The serving composition never schedules: cron registration and the
        // plan/run surfaces are the producer side's.
        const cron =
          profile === "serving"
            ? undefined
            : await (async () => {
                const scheduler = await createPgCronScheduler(
                  jobs,
                  NATIVE_CRON_DEFINITIONS,
                  cronOptions,
                );
                own(() => scheduler.close());
                return scheduler;
              })();
        loops = createNativeBackgroundLoops({
          ...loopOptions,
          role:
            profile === "trusted"
              ? "all"
              : profile === "serving"
                ? "serving"
                : "producer",
          cron,
          queues: profile === "serving" ? undefined : queues,
          owners: profile === "serving" ? undefined : owners,
          ...(actors.maintenance ?? {}),
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
  const refuseOwner = (owner: string) => ({
    fetch: refusal(`${owner} owner fetch`),
    scheduled: refusal(`${owner} scheduled owner`),
    queue: refusal(`${owner} queue owner`),
  });
  return {
    get state() {
      return current().state;
    },
    // The executing side's declared cross-repo fixture identity, readable by
    // the fleet conformance producer instead of a second literal there.
    conformance: NATIVE_CONFORMANCE_CONTRACT,
    fetch:
      profile === "producer"
        ? refusal("public HTTP listener")
        : (request: Request) => current().fetch(request),
    owners:
      profile === "serving"
        ? {
            api: refuseOwner("api"),
            data: refuseOwner("data"),
            registry: {
              fetch: refusal("registry owner fetch"),
              scheduled: refusal("registry scheduled owner"),
            },
          }
        : current().owners,
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
