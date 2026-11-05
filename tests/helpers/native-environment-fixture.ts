import type { NativeEnvironmentOptions } from "../../src/native-environment.ts";
import type { NativeOAuthModule } from "../../src/native-oauth-provider.ts";
import { NATIVE_REQUIRED_SECRETS } from "../../src/native-runtime-settings.ts";

/** Isolated fixture policy, never an operator deployment profile. */
export function nativeEnvironmentFixture(
  connectionString: string,
  owner: string,
  paths: { assets: string; archive: string },
  oauthModule: NativeOAuthModule,
): NativeEnvironmentOptions {
  const credentials = (role: keyof typeof NATIVE_REQUIRED_SECRETS) =>
    Object.fromEntries(
      NATIVE_REQUIRED_SECRETS[role].map((key) => [key, "fixture-secret"]),
    );
  return {
    postgres: {
      connectionString,
      maxConnections: 8,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 1000,
      statementTimeoutMillis: 5000,
      onIdleError() {},
    },
    maxRequests: 16,
    maxJobs: 8,
    drainTimeoutMillis: 1000,
    internal: {
      maxConcurrent: 4,
      maxBufferBytes: 32 * 1024 * 1024,
      maxCalls: 100,
      maxDepth: 4,
      timeoutMillis: 1000,
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 1024 * 1024,
    },
    owners: {
      app: owner,
      auth: owner,
      jobs: owner,
      realtime: owner,
      retained: owner,
      search: owner,
    },
    settings: {
      api: {
        ...credentials("api"),
        CHAIN_HEAD_RPC_URL: "https://rpc.example",
        TESTNET_CHAIN_HEAD_RPC_URL: "https://rpc.example",
      },
      data: credentials("data"),
      registry: credentials("registry"),
    },
    exportIdentity: "urn:metagraphed:export:fixture",
    headRequestTimeoutMillis: 1000,
    decoder: { maxAuditBytes: 1024 * 1024 },
    oauthModule,
    staticAssets: {
      directory: paths.assets,
      maxFiles: 100,
      maxAssetBytes: 4096,
      maxTotalBytes: 16384,
      maxConcurrent: 2,
      executionTimeoutMillis: 1000,
      drainTimeoutMillis: 1000,
    },
    archiveContent: {
      directory: paths.archive,
      maxConcurrentOperations: 2,
      maxChunkBytes: 524288,
    },
    inference: {
      identity: {
        embedding: {
          provider: "fixture",
          model: "fixture-embedding",
          dimensions: 2,
        },
        completion: { provider: "fixture", model: "fixture-completion" },
      },
      embedding: {
        baseUrl: "https://inference.example/v1/",
        token: "fixture-token",
      },
      completion: {
        baseUrl: "https://inference.example/v1/",
        token: "fixture-token",
      },
      maxConcurrent: 2,
      maxRequestBytes: 65536,
      maxResponseBytes: 65536,
      maxOutputTokens: 128,
      executionTimeoutMillis: 1000,
      drainTimeoutMillis: 1000,
      transport: async (input) =>
        new URL(String(input)).pathname.endsWith("/embeddings")
          ? Response.json({
              data: [{ index: 0, embedding: [1, 0] }],
              model: "fixture-embedding",
            })
          : Response.json({
              choices: [{ message: { role: "assistant", content: "fixture" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
    },
    semanticIndex: {
      name: "fixture",
      model: "fixture-embedding",
      dimensions: 2,
      maxVectors: 16,
    },
    state: {
      validatorHistory: {
        maxSourceRows: 1000,
        maxPageBytes: 1048576,
        pageRows: 100,
        maxDurationMillis: 1000,
      },
      capture: {
        maxRows: 100,
        maxDocuments: 16,
        maxPayloadBytes: 1048576,
        maxConcurrent: 1,
        executionTimeoutMillis: 1000,
        drainTimeoutMillis: 1000,
      },
      rpcUsage: {
        maxPending: 100,
        maxPendingBytes: 1048576,
        batchSize: 50,
        retentionDays: 31,
        executionTimeoutMillis: 1000,
        drainTimeoutMillis: 1000,
      },
    },
    actors: {
      status: {
        maxConcurrentRequests: 2,
        maxRequestBytes: 65536,
        maxStateBytes: 65536,
        maxMemberships: 100,
        notificationConcurrency: 2,
        executionTimeoutMillis: 1000,
        drainTimeoutMillis: 1000,
      },
      alerter: {
        maxConcurrentEvaluations: 1,
        maxConcurrentInternal: 1,
        maxConcurrentOutbound: 1,
        maxRequestBytes: 65536,
        maxInternalResponseBytes: 65536,
        maxOutboundRequestBytes: 65536,
        maxOutboundResponseBytes: 65536,
        leaseMilliseconds: 10000,
        renewIntervalMillis: 1000,
        executionTimeoutMillis: 1000,
        drainTimeoutMillis: 1000,
      },
      outbound: {
        timeoutMillis: 1000,
        maxRequestBytes: 65536,
        maxResponseBytes: 65536,
      },
      chain: {
        maxStateBytes: 65536,
        leaseMilliseconds: 10000,
        maxConcurrentCalls: 4,
        maxPendingCalls: 8,
        maxRequestBytes: 65536,
        maxSocketMessageBytes: 65536,
        maxSocketBufferedBytes: 131072,
        maxPendingSocketMessages: 8,
        renewIntervalMillis: 1000,
        executionTimeoutMillis: 1000,
        drainTimeoutMillis: 1000,
      },
      sessions: {
        maxSessions: 16,
        maxBytes: 1048576,
        maxStateBytes: 65536,
        leaseMilliseconds: 10000,
        maxResidentSessions: 8,
        maxConcurrentCalls: 4,
        maxPendingCallsPerSession: 8,
        maxRequestBytes: 65536,
        maxQueuedFrames: 16,
        renewIntervalMillis: 1000,
        residentIdleMillis: 1000,
        executionTimeoutMillis: 1000,
        drainTimeoutMillis: 1000,
      },
    },
    queues: {
      maxMessages: 100,
      maxBytes: 1048576,
      leaseMilliseconds: 10000,
      executionTimeoutMillis: 1000,
      drainTimeoutMillis: 1000,
    },
    cron: {
      maxConcurrent: 2,
      leaseMilliseconds: 10000,
      executionTimeoutMillis: 1000,
      drainTimeoutMillis: 1000,
      maxAttempts: 3,
      historyLimit: 100,
    },
    loops: {
      cadence: {
        cronPlan: 3600000,
        cronRun: 3600000,
        queues: 3600000,
        mcpAlarms: 3600000,
        chainAlarm: 3600000,
        rpcFlush: 3600000,
        rpcPrune: 3600000,
        authPrune: 3600000,
      },
      cronRunners: 1,
      mcpAlarmBatch: 8,
      authPruneBatch: 100,
      stopTimeoutMillis: 1000,
    },
    onBackgroundError() {},
  };
}
