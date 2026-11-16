import { ACCOUNT_IDENTITY_INSERT_COLUMNS } from "./account-identity.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type {
  ValidatorEnrichmentStore,
  ValidatorIdentityRow,
  ValidatorPriceRow,
  ValidatorTempoRow,
} from "./validator-enrichment-store.ts";

/** These relational enrichments share the accepted native store. No neuron
 * JSON view or arbitrary caller SQL is exposed by this capability. */
export function createPgValidatorEnrichmentStore(
  runtime: Pick<PgStoreRuntime, "read">,
): ValidatorEnrichmentStore {
  return {
    prices: () =>
      runtime.read.query<ValidatorPriceRow>(`
      SELECT s.netuid, s.alpha_price_tao, s.tao_in_pool_tao, s.alpha_in_pool
      FROM app.subnet_snapshots s JOIN (
        SELECT netuid, MAX(snapshot_date) AS snapshot_date
        FROM app.subnet_snapshots GROUP BY netuid
      ) latest ON latest.netuid=s.netuid AND latest.snapshot_date=s.snapshot_date`),
    tempos: () =>
      runtime.read.query<ValidatorTempoRow>(
        "SELECT netuid, tempo FROM app.subnet_hyperparams",
      ),
    identities: () =>
      runtime.read.query<ValidatorIdentityRow>(
        `SELECT ${ACCOUNT_IDENTITY_INSERT_COLUMNS.join(", ")} FROM app.account_identity`,
      ),
    async latestCompletedCapture() {
      const rows = await runtime.read.query<{
        captured_at: number | string | null;
      }>(`
        SELECT captured_at FROM app.neurons_passes
        WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1`);
      const capturedAt = Number(rows[0]?.captured_at);
      return Number.isSafeInteger(capturedAt) && capturedAt > 0
        ? capturedAt
        : null;
    },
  };
}
