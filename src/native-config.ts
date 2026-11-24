/** The process boundary: the environment a container is given, read once into
 * the complete `NativeEnvironmentOptions` the native factories already expect.
 *
 * Everything below this module exists and is contract-tested; nothing above it
 * did. `createNativeEnvironment` and `createNativeApplication` are exported
 * factories that only `tests/` called, so the application had no way to start
 * as a process. This module and `native-entry.ts` are that way.
 *
 * Two rules shape it:
 *
 * - The secret names are NOT restated here. `NATIVE_REQUIRED_SECRETS` is the
 *   one declaration of what each owner needs, so this module iterates it at
 *   runtime and reports every missing name at once. A copied list would go
 *   stale the first time that declaration moved, and the process would then
 *   start without a credential the handlers need.
 * - A value with one source is derived, not entered twice. The embedding
 *   dimension count is the clearest case: `createNativeEnvironment` refuses
 *   when `semanticIndex.dimensions` and `inference.identity.embedding.dimensions`
 *   disagree ("identities differ"), so both read the same variable here and the
 *   mismatch cannot be configured.
 *
 * Budgets default to the measured production shape (~17 requests/second mean,
 * ~18.6k rows/second read) and every one is overridable, so a tuning change is
 * a job-declaration edit rather than a code change.
 */
import type { NativeEnvironmentOptions } from "./native-environment.ts";
import {
  NATIVE_REQUIRED_SECRETS,
  NATIVE_SETTING_KEYS,
  type NativeSettingKey,
} from "./native-runtime-settings.ts";
import {
  loadNativeOAuthProvider,
  type NativeOAuthModule,
} from "./native-oauth-provider.ts";
import type {
  NativeProcessProfile,
  NativeSourceOwners,
} from "./native-source-manifest.ts";
import type { NativeCronOwner } from "./pg-cron.ts";

/** The logical sources a composed process presents one credential for. */
const SOURCES = [
  "app",
  "auth",
  "jobs",
  "realtime",
  "retained",
  "search",
] as const;

const PROFILES: readonly NativeProcessProfile[] = [
  "trusted",
  "serving",
  "producer",
];

/** The settings owners whose credentials the environment supplies. */
const OWNERS = Object.keys(NATIVE_REQUIRED_SECRETS) as readonly NativeCronOwner[];

export interface NativeConfigSource {
  readonly [key: string]: string | undefined;
}

class NativeConfigError extends Error {
  override readonly name = "NativeConfigError";
}

function text(env: NativeConfigSource, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new NativeConfigError(`${key} is required`);
  return value;
}

function optionalText(
  env: NativeConfigSource,
  key: string,
  fallback: string,
): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

/** A positive integer, or the reviewed default. A present-but-unparseable value
 * is an error rather than a silent fallback: a typo in a job declaration must
 * not quietly restore a budget the operator meant to change. */
function count(env: NativeConfigSource, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw))
    throw new NativeConfigError(`${key} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new NativeConfigError(`${key} must be a positive integer`);
  return value;
}

export { count as configCount, optionalText as configText, text as requiredText };

function profileOf(env: NativeConfigSource): NativeProcessProfile {
  const requested = optionalText(env, "METAGRAPHED_PROFILE", "serving");
  if (!PROFILES.includes(requested as NativeProcessProfile))
    throw new NativeConfigError(
      `METAGRAPHED_PROFILE must be one of ${PROFILES.join(", ")}`,
    );
  return requested as NativeProcessProfile;
}

/** Every owner's settings, from the declaration of what each one needs.
 *
 * The scalars themselves come from `NATIVE_ROLE_DEFAULTS` inside
 * `nativeRuntimeSettings`; this only supplies the secrets the defaults cannot
 * carry, plus any reviewed scalar the environment overrides by its own name.
 * Missing secrets are collected across every owner and reported together, so a
 * deployment learns its whole gap from one failed start instead of one name per
 * restart. */
function settingsFrom(
  env: NativeConfigSource,
): Record<NativeCronOwner, Record<string, string>> {
  const settings = {} as Record<NativeCronOwner, Record<string, string>>;
  const missing: string[] = [];
  for (const owner of OWNERS) {
    const supplied: Record<string, string> = {};
    for (const key of NATIVE_REQUIRED_SECRETS[owner]) {
      const value = env[key]?.trim();
      if (!value) {
        missing.push(`${key} (${owner})`);
        continue;
      }
      supplied[key] = value;
    }
    settings[owner] = supplied;
  }
  if (missing.length)
    throw new NativeConfigError(
      `Native process is missing required settings: ${missing.join(", ")}`,
    );
  // A reviewed scalar the environment names overrides the default for every
  // owner that accepts it; `nativeRuntimeSettings` refuses an unknown key and
  // any change to a setting its owner must preserve, so this cannot widen the
  // surface or disable an active feature.
  for (const key of NATIVE_SETTING_KEYS as readonly NativeSettingKey[]) {
    const value = env[key]?.trim();
    if (!value) continue;
    for (const owner of OWNERS) settings[owner][key] = value;
  }
  return settings;
}

/** One credential for every source this process presents (infra#882). The role
 * is the DSN's own user, named once so the manifest and the connection cannot
 * disagree about which credential started the process. */
function ownersFrom(env: NativeConfigSource): NativeSourceOwners {
  const role = text(env, "METAGRAPHED_DATABASE_ROLE");
  return Object.freeze(
    Object.fromEntries(SOURCES.map((source) => [source, role])),
  ) as NativeSourceOwners;
}

export interface NativeConfigDependencies {
  /** Loads the generated OAuth provider; injected so a test need not build it. */
  loadOAuth?(url: URL): Promise<NativeOAuthModule>;
  /** Reports a background failure. Defaults to stderr. */
  onBackgroundError?(error: unknown, origin: string): void;
}

/** The complete options for one composed process, from its environment. */
export async function nativeConfig(
  env: NativeConfigSource,
  dependencies: NativeConfigDependencies = {},
): Promise<NativeEnvironmentOptions> {
  const profile = profileOf(env);
  const loadOAuth = dependencies.loadOAuth ?? loadNativeOAuthProvider;
  const report =
    dependencies.onBackgroundError ??
    ((error: unknown, origin: string) => {
      console.error(`native background failure in ${origin}:`, error);
    });

  // One source for the embedding width: `createNativeEnvironment` refuses a
  // disagreement between these two, so they cannot be set apart.
  const embeddingDimensions = count(
    env,
    "METAGRAPHED_EMBEDDING_DIMENSIONS",
    768,
  );
  const embeddingModel = optionalText(
    env,
    "METAGRAPHED_EMBEDDING_MODEL",
    "bge-base-en-v1.5",
  );
  const inferenceBase = text(env, "METAGRAPHED_INFERENCE_BASE_URL");
  const inferenceToken = text(env, "METAGRAPHED_INFERENCE_TOKEN");

  return {
    postgres: {
      connectionString: text(env, "METAGRAPHED_DATABASE_URL"),
      // The validator detail reads five independent sources at once, which
      // `createNativeEnvironment` enforces as its floor; the default leaves
      // room for that fan-out plus the request concurrency below.
      maxConnections: count(env, "METAGRAPHED_DATABASE_CONNECTIONS", 24),
      connectionTimeoutMillis: count(
        env,
        "METAGRAPHED_DATABASE_CONNECT_TIMEOUT_MS",
        5_000,
      ),
      idleTimeoutMillis: count(
        env,
        "METAGRAPHED_DATABASE_IDLE_TIMEOUT_MS",
        30_000,
      ),
      statementTimeoutMillis: count(
        env,
        "METAGRAPHED_DATABASE_STATEMENT_TIMEOUT_MS",
        30_000,
      ),
      onIdleError: (error: unknown) => report(error, "postgres-idle"),
    },
    maxRequests: count(env, "METAGRAPHED_MAX_REQUESTS", 256),
    maxJobs: count(env, "METAGRAPHED_MAX_JOBS", 32),
    drainTimeoutMillis: count(env, "METAGRAPHED_DRAIN_TIMEOUT_MS", 30_000),
    internal: {
      maxConcurrent: count(env, "METAGRAPHED_INTERNAL_CONCURRENCY", 32),
      maxBufferBytes: count(
        env,
        "METAGRAPHED_INTERNAL_BUFFER_BYTES",
        64 * 1024 * 1024,
      ),
      maxCalls: count(env, "METAGRAPHED_INTERNAL_MAX_CALLS", 1_000),
      maxDepth: count(env, "METAGRAPHED_INTERNAL_MAX_DEPTH", 4),
      timeoutMillis: count(env, "METAGRAPHED_INTERNAL_TIMEOUT_MS", 15_000),
      maxRequestBytes: count(
        env,
        "METAGRAPHED_INTERNAL_REQUEST_BYTES",
        8 * 1024 * 1024,
      ),
      maxResponseBytes: count(
        env,
        "METAGRAPHED_INTERNAL_RESPONSE_BYTES",
        16 * 1024 * 1024,
      ),
    },
    profile,
    owners: ownersFrom(env),
    settings: settingsFrom(env),
    exportIdentity: text(env, "METAGRAPHED_EXPORT_IDENTITY"),
    headRequestTimeoutMillis: count(
      env,
      "METAGRAPHED_HEAD_REQUEST_TIMEOUT_MS",
      10_000,
    ),
    decoder: {
      maxAuditBytes: count(
        env,
        "METAGRAPHED_DECODER_AUDIT_BYTES",
        16 * 1024 * 1024,
      ),
    },
    oauthModule: await loadOAuth(
      new URL(
        optionalText(
          env,
          "METAGRAPHED_OAUTH_MODULE",
          "./generated/native-oauth.js",
        ),
        `file://${optionalText(env, "METAGRAPHED_ROOT", process.cwd())}/`,
      ),
    ),
    staticAssets: {
      directory: text(env, "METAGRAPHED_STATIC_DIRECTORY"),
      maxFiles: count(env, "METAGRAPHED_STATIC_MAX_FILES", 25_000),
      maxAssetBytes: count(
        env,
        "METAGRAPHED_STATIC_ASSET_BYTES",
        8 * 1024 * 1024,
      ),
      maxTotalBytes: count(
        env,
        "METAGRAPHED_STATIC_TOTAL_BYTES",
        1024 * 1024 * 1024,
      ),
      maxConcurrent: count(env, "METAGRAPHED_STATIC_CONCURRENCY", 32),
      executionTimeoutMillis: count(
        env,
        "METAGRAPHED_STATIC_TIMEOUT_MS",
        10_000,
      ),
      drainTimeoutMillis: count(env, "METAGRAPHED_STATIC_DRAIN_MS", 10_000),
    },
    archiveContent: {
      directory: text(env, "METAGRAPHED_ARCHIVE_DIRECTORY"),
      maxConcurrentOperations: count(env, "METAGRAPHED_ARCHIVE_CONCURRENCY", 8),
      maxChunkBytes: count(
        env,
        "METAGRAPHED_ARCHIVE_CHUNK_BYTES",
        8 * 1024 * 1024,
      ),
    },
    inference: {
      identity: {
        embedding: {
          provider: optionalText(
            env,
            "METAGRAPHED_EMBEDDING_PROVIDER",
            "gateway",
          ),
          model: embeddingModel,
          dimensions: embeddingDimensions,
        },
        completion: {
          provider: optionalText(
            env,
            "METAGRAPHED_COMPLETION_PROVIDER",
            "gateway",
          ),
          model: text(env, "METAGRAPHED_COMPLETION_MODEL"),
        },
      },
      embedding: { baseUrl: inferenceBase, token: inferenceToken },
      completion: { baseUrl: inferenceBase, token: inferenceToken },
      maxConcurrent: count(env, "METAGRAPHED_INFERENCE_CONCURRENCY", 8),
      maxRequestBytes: count(
        env,
        "METAGRAPHED_INFERENCE_REQUEST_BYTES",
        1024 * 1024,
      ),
      maxResponseBytes: count(
        env,
        "METAGRAPHED_INFERENCE_RESPONSE_BYTES",
        4 * 1024 * 1024,
      ),
      maxOutputTokens: count(env, "METAGRAPHED_INFERENCE_OUTPUT_TOKENS", 1_024),
      executionTimeoutMillis: count(
        env,
        "METAGRAPHED_INFERENCE_TIMEOUT_MS",
        60_000,
      ),
      drainTimeoutMillis: count(env, "METAGRAPHED_INFERENCE_DRAIN_MS", 15_000),
    },
    semanticIndex: {
      name: optionalText(env, "METAGRAPHED_SEMANTIC_INDEX", "registry"),
      model: embeddingModel,
      dimensions: embeddingDimensions,
      maxVectors: count(env, "METAGRAPHED_SEMANTIC_MAX_VECTORS", 1_000_000),
    },
    state: {
      validatorHistory: {
        maxSourceRows: count(env, "METAGRAPHED_VALIDATOR_SOURCE_ROWS", 500_000),
        maxPageBytes: count(
          env,
          "METAGRAPHED_VALIDATOR_PAGE_BYTES",
          8 * 1024 * 1024,
        ),
        pageRows: count(env, "METAGRAPHED_VALIDATOR_PAGE_ROWS", 1_000),
        maxDurationMillis: count(
          env,
          "METAGRAPHED_VALIDATOR_DURATION_MS",
          30_000,
        ),
      },
      capture: {
        maxRows: count(env, "METAGRAPHED_CAPTURE_MAX_ROWS", 10_000),
        maxDocuments: count(env, "METAGRAPHED_CAPTURE_MAX_DOCUMENTS", 256),
        maxPayloadBytes: count(
          env,
          "METAGRAPHED_CAPTURE_PAYLOAD_BYTES",
          32 * 1024 * 1024,
        ),
        maxConcurrent: count(env, "METAGRAPHED_CAPTURE_CONCURRENCY", 4),
        executionTimeoutMillis: count(
          env,
          "METAGRAPHED_CAPTURE_TIMEOUT_MS",
          60_000,
        ),
        drainTimeoutMillis: count(env, "METAGRAPHED_CAPTURE_DRAIN_MS", 15_000),
      },
      rpcUsage: {
        maxPending: count(env, "METAGRAPHED_RPC_USAGE_MAX_PENDING", 50_000),
        maxPendingBytes: count(
          env,
          "METAGRAPHED_RPC_USAGE_PENDING_BYTES",
          64 * 1024 * 1024,
        ),
        batchSize: count(env, "METAGRAPHED_RPC_USAGE_BATCH", 1_000),
        retentionDays: count(env, "METAGRAPHED_RPC_USAGE_RETENTION_DAYS", 31),
        executionTimeoutMillis: count(
          env,
          "METAGRAPHED_RPC_USAGE_TIMEOUT_MS",
          30_000,
        ),
        drainTimeoutMillis: count(
          env,
          "METAGRAPHED_RPC_USAGE_DRAIN_MS",
          15_000,
        ),
      },
    },
    actors: {
      status: {
        maxConcurrentRequests: count(env, "METAGRAPHED_STATUS_CONCURRENCY", 32),
        maxRequestBytes: count(
          env,
          "METAGRAPHED_STATUS_REQUEST_BYTES",
          1024 * 1024,
        ),
        maxStateBytes: count(
          env,
          "METAGRAPHED_STATUS_STATE_BYTES",
          8 * 1024 * 1024,
        ),
        maxMemberships: count(env, "METAGRAPHED_STATUS_MEMBERSHIPS", 10_000),
        notificationConcurrency: count(
          env,
          "METAGRAPHED_STATUS_NOTIFY_CONCURRENCY",
          16,
        ),
        executionTimeoutMillis: count(
          env,
          "METAGRAPHED_STATUS_TIMEOUT_MS",
          15_000,
        ),
        drainTimeoutMillis: count(env, "METAGRAPHED_STATUS_DRAIN_MS", 10_000),
      },
      alerter: {
        maxConcurrentEvaluations: count(
          env,
          "METAGRAPHED_ALERTER_EVALUATIONS",
          4,
        ),
        maxConcurrentInternal: count(env, "METAGRAPHED_ALERTER_INTERNAL", 8),
        maxConcurrentOutbound: count(env, "METAGRAPHED_ALERTER_OUTBOUND", 8),
        maxRequestBytes: count(
          env,
          "METAGRAPHED_ALERTER_REQUEST_BYTES",
          1024 * 1024,
        ),
        maxInternalResponseBytes: count(
          env,
          "METAGRAPHED_ALERTER_INTERNAL_RESPONSE_BYTES",
          4 * 1024 * 1024,
        ),
        maxOutboundRequestBytes: count(
          env,
          "METAGRAPHED_ALERTER_OUTBOUND_REQUEST_BYTES",
          1024 * 1024,
        ),
        maxOutboundResponseBytes: count(
          env,
          "METAGRAPHED_ALERTER_OUTBOUND_RESPONSE_BYTES",
          1024 * 1024,
        ),
        leaseMilliseconds: count(env, "METAGRAPHED_ALERTER_LEASE_MS", 60_000),
        renewIntervalMillis: count(env, "METAGRAPHED_ALERTER_RENEW_MS", 20_000),
        executionTimeoutMillis: count(
          env,
          "METAGRAPHED_ALERTER_TIMEOUT_MS",
          30_000,
        ),
        drainTimeoutMillis: count(env, "METAGRAPHED_ALERTER_DRAIN_MS", 15_000),
      },
      outbound: {
        timeoutMillis: count(env, "METAGRAPHED_OUTBOUND_TIMEOUT_MS", 15_000),
        maxRequestBytes: count(
          env,
          "METAGRAPHED_OUTBOUND_REQUEST_BYTES",
          1024 * 1024,
        ),
        maxResponseBytes: count(
          env,
          "METAGRAPHED_OUTBOUND_RESPONSE_BYTES",
          4 * 1024 * 1024,
        ),
      },
      chain: {
        maxStateBytes: count(
          env,
          "METAGRAPHED_CHAIN_STATE_BYTES",
          8 * 1024 * 1024,
        ),
        leaseMilliseconds: count(env, "METAGRAPHED_CHAIN_LEASE_MS", 60_000),
        maxConcurrentCalls: count(env, "METAGRAPHED_CHAIN_CONCURRENT_CALLS", 32),
        maxPendingCalls: count(env, "METAGRAPHED_CHAIN_PENDING_CALLS", 256),
        maxRequestBytes: count(
          env,
          "METAGRAPHED_CHAIN_REQUEST_BYTES",
          1024 * 1024,
        ),
        maxSocketMessageBytes: count(
          env,
          "METAGRAPHED_CHAIN_SOCKET_MESSAGE_BYTES",
          8 * 1024 * 1024,
        ),
        maxSocketBufferedBytes: count(
          env,
          "METAGRAPHED_CHAIN_SOCKET_BUFFERED_BYTES",
          32 * 1024 * 1024,
        ),
        maxPendingSocketMessages: count(
          env,
          "METAGRAPHED_CHAIN_PENDING_SOCKET_MESSAGES",
          256,
        ),
        renewIntervalMillis: count(env, "METAGRAPHED_CHAIN_RENEW_MS", 20_000),
        executionTimeoutMillis: count(
          env,
          "METAGRAPHED_CHAIN_TIMEOUT_MS",
          30_000,
        ),
        drainTimeoutMillis: count(env, "METAGRAPHED_CHAIN_DRAIN_MS", 15_000),
      },
      sessions: {
        maxSessions: count(env, "METAGRAPHED_SESSIONS_MAX", 10_000),
        maxBytes: count(
          env,
          "METAGRAPHED_SESSIONS_MAX_BYTES",
          64 * 1024 * 1024,
        ),
        maxStateBytes: count(
          env,
          "METAGRAPHED_SESSIONS_STATE_BYTES",
          1024 * 1024,
        ),
        leaseMilliseconds: count(env, "METAGRAPHED_SESSIONS_LEASE_MS", 60_000),
        maxResidentSessions: count(env, "METAGRAPHED_SESSIONS_RESIDENT", 1_024),
        maxConcurrentCalls: count(
          env,
          "METAGRAPHED_SESSIONS_CONCURRENT_CALLS",
          32,
        ),
        maxPendingCallsPerSession: count(
          env,
          "METAGRAPHED_SESSIONS_PENDING_PER_SESSION",
          16,
        ),
        maxRequestBytes: count(
          env,
          "METAGRAPHED_SESSIONS_REQUEST_BYTES",
          1024 * 1024,
        ),
        maxQueuedFrames: count(env, "METAGRAPHED_SESSIONS_QUEUED_FRAMES", 256),
        renewIntervalMillis: count(
          env,
          "METAGRAPHED_SESSIONS_RENEW_MS",
          20_000,
        ),
        residentIdleMillis: count(
          env,
          "METAGRAPHED_SESSIONS_RESIDENT_IDLE_MS",
          300_000,
        ),
        executionTimeoutMillis: count(
          env,
          "METAGRAPHED_SESSIONS_TIMEOUT_MS",
          30_000,
        ),
        drainTimeoutMillis: count(env, "METAGRAPHED_SESSIONS_DRAIN_MS", 15_000),
      },
    },
    queues: {
      maxMessages: count(env, "METAGRAPHED_QUEUE_MAX_MESSAGES", 10_000),
      maxBytes: count(env, "METAGRAPHED_QUEUE_MAX_BYTES", 64 * 1024 * 1024),
      leaseMilliseconds: count(env, "METAGRAPHED_QUEUE_LEASE_MS", 60_000),
      executionTimeoutMillis: count(env, "METAGRAPHED_QUEUE_TIMEOUT_MS", 60_000),
      drainTimeoutMillis: count(env, "METAGRAPHED_QUEUE_DRAIN_MS", 15_000),
    },
    cron: {
      maxConcurrent: count(env, "METAGRAPHED_CRON_CONCURRENCY", 4),
      leaseMilliseconds: count(env, "METAGRAPHED_CRON_LEASE_MS", 60_000),
      executionTimeoutMillis: count(env, "METAGRAPHED_CRON_TIMEOUT_MS", 300_000),
      drainTimeoutMillis: count(env, "METAGRAPHED_CRON_DRAIN_MS", 15_000),
      maxAttempts: count(env, "METAGRAPHED_CRON_MAX_ATTEMPTS", 3),
      historyLimit: count(env, "METAGRAPHED_CRON_HISTORY", 1_000),
    },
    loops: {
      // The deliberate twelve-second chain-detail ticker stays separate from
      // the bulk cadences (metagraphed-infra#822 keeps them distinct).
      cadence: {
        cronPlan: count(env, "METAGRAPHED_LOOP_CRON_PLAN_MS", 60_000),
        cronRun: count(env, "METAGRAPHED_LOOP_CRON_RUN_MS", 15_000),
        queues: count(env, "METAGRAPHED_LOOP_QUEUES_MS", 5_000),
        mcpAlarms: count(env, "METAGRAPHED_LOOP_MCP_ALARMS_MS", 15_000),
        chainAlarm: count(env, "METAGRAPHED_LOOP_CHAIN_ALARM_MS", 12_000),
        rpcFlush: count(env, "METAGRAPHED_LOOP_RPC_FLUSH_MS", 30_000),
        rpcPrune: count(env, "METAGRAPHED_LOOP_RPC_PRUNE_MS", 3_600_000),
        authPrune: count(env, "METAGRAPHED_LOOP_AUTH_PRUNE_MS", 3_600_000),
      },
      cronRunners: count(env, "METAGRAPHED_LOOP_CRON_RUNNERS", 2),
      mcpAlarmBatch: count(env, "METAGRAPHED_LOOP_MCP_ALARM_BATCH", 32),
      authPruneBatch: count(env, "METAGRAPHED_LOOP_AUTH_PRUNE_BATCH", 1_000),
      stopTimeoutMillis: count(env, "METAGRAPHED_LOOP_STOP_TIMEOUT_MS", 15_000),
    },
    onBackgroundError: report,
  } as NativeEnvironmentOptions;
}

export { NativeConfigError };
