import type { NativeSource } from "./native-api-process.ts";
import { nativeSource } from "./native-source-manifest.ts";
import type { createSqliteDocumentDecoder } from "./sqlite-document-decoder.ts";
import { createNativeAccountState } from "./native-account-state.ts";
import { createPgNeuronSnapshotStore } from "./pg-neuron-snapshot.ts";
import { createPgNeuronLiveStore } from "./pg-neuron-live.ts";
import { createPgNeuronHistoryStore } from "./pg-neuron-history.ts";
import { createPgNeuronMetricStore } from "./pg-neuron-metrics.ts";
import { createPgNeuronSummaryStore } from "./pg-neuron-summaries.ts";
import { createPgNeuronAggregateStore } from "./pg-neuron-aggregates.ts";
import { createPgNeuronViewStore } from "./pg-neuron-view.ts";
import { createPgNeuronDailyViewStore } from "./pg-neuron-daily-view.ts";
import { createPgValidatorEnrichmentStore } from "./pg-validator-enrichment.ts";
import {
  createPgValidatorHistoryStore,
  type ValidatorHistoryLimits,
} from "./pg-validator-history.ts";
import { createPgSubnetEnrichmentStore } from "./pg-subnet-enrichment.ts";
import {
  createPgNeuronCaptureStore,
  type PgNeuronCaptureOptions,
} from "./pg-neuron-capture.ts";
import { createPgRootBasketStore } from "./root-basket-pg.ts";
import { createPgObservations } from "./observations-pg.ts";
import { createPgLaneHealth } from "./lane-health-pg.ts";
import { createPgRegistrySyncStore } from "./pg-registry-sync.ts";
import { createPgGeneratedArtifactStore } from "./pg-generated-artifacts.ts";
import { createPgSelfHealthStore } from "./pg-self-health.ts";
import { createPgChainConcentrationStore } from "./pg-chain-concentration.ts";
import { createPgRetainedBlocks } from "./retained-blocks-pg.ts";
import { createPgRawCapture } from "./pg-raw-capture.ts";
import { createPgRetentionStore } from "./pg-retention.ts";
import { createPgArchiveCatalog } from "./archive-catalog-pg.ts";
import {
  createPgRpcUsageStore,
  type PgRpcUsageOptions,
} from "./pg-rpc-usage.ts";
import {
  createPgProducerBindings,
  NATIVE_PRODUCER_LANES,
} from "./pg-producer-store.ts";

export interface NativeStateLimits {
  capture: PgNeuronCaptureOptions;
  rpcUsage: PgRpcUsageOptions;
  validatorHistory: Required<ValidatorHistoryLimits>;
}

/** Build the complete application-state family from verified sources. The
 * enclosing application retains pool and adapter lifecycle ownership. */
export function createNativeStateBindings(
  sources: ReadonlyMap<string, NativeSource>,
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
  limits: NativeStateLimits,
  onStartupCleanup: (cleanup: () => Promise<void>) => void,
) {
  const app = nativeSource(sources, "app");
  const retained = nativeSource(sources, "retained");
  const capture = createPgNeuronCaptureStore(app, decoder, limits.capture);
  onStartupCleanup(() => capture.close());
  const rpcUsage = createPgRpcUsageStore(app, limits.rpcUsage);
  onStartupCleanup(() => rpcUsage.close());
  const bindings = Object.freeze({
    ACCOUNT_STATE_STORE: createNativeAccountState(app),
    NEURON_SNAPSHOT_STORE: createPgNeuronSnapshotStore(app, decoder),
    NEURON_LIVE_STORE: createPgNeuronLiveStore(app, decoder),
    NEURON_HISTORY_STORE: createPgNeuronHistoryStore(app, decoder),
    NEURON_METRIC_STORE: createPgNeuronMetricStore(app, decoder),
    NEURON_SUMMARY_STORE: createPgNeuronSummaryStore(app, decoder),
    NEURON_AGGREGATE_STORE: createPgNeuronAggregateStore(app, decoder),
    NEURON_VIEW_STORE: createPgNeuronViewStore(app, decoder),
    NEURON_DAILY_VIEW_STORE: createPgNeuronDailyViewStore(app, decoder),
    VALIDATOR_ENRICHMENT_STORE: createPgValidatorEnrichmentStore(app),
    VALIDATOR_HISTORY_STORE: createPgValidatorHistoryStore(
      app,
      decoder,
      limits.validatorHistory,
    ),
    SUBNET_ENRICHMENT_STORE: createPgSubnetEnrichmentStore(app, decoder),
    NEURON_CAPTURE_STORE: capture,
    ROOT_BASKET_STORE: createPgRootBasketStore(app),
    OBSERVATIONS_STORE: createPgObservations(app),
    LANE_HEALTH_STORE: createPgLaneHealth(app),
    REGISTRY_SYNC_STORE: createPgRegistrySyncStore(app),
    GENERATED_ARTIFACT_STORE: createPgGeneratedArtifactStore(app),
    SELF_HEALTH_STORE: createPgSelfHealthStore(app),
    CHAIN_CONCENTRATION_STORE: createPgChainConcentrationStore(app, decoder),
    RETAINED_BLOCKS_STORE: createPgRetainedBlocks(retained),
    NATIVE_RAW_CAPTURE: createPgRawCapture(app),
    RAW_CAPTURE_STORAGE: "postgresql",
    NATIVE_RETENTION_STORE: createPgRetentionStore(app),
    ARCHIVE_CATALOG_STORE: createPgArchiveCatalog(app),
    RPC_USAGE_STORE: rpcUsage,
    NATIVE_READ_STORE: Object.freeze({
      tables: app.relations,
      store: app.read,
    }),
    ...createPgProducerBindings(app, NATIVE_PRODUCER_LANES),
  });
  return { bindings, rpcUsage, capture };
}
