import type {
  AccountIdentity,
  SubnetHyperparams,
  SubnetSnapshots,
} from "../generated/db/types.ts";
import type { ACCOUNT_IDENTITY_INSERT_COLUMNS } from "./account-identity.ts";

export type ValidatorPriceRow = Pick<
  SubnetSnapshots,
  "netuid" | "alpha_price_tao" | "tao_in_pool_tao" | "alpha_in_pool"
>;
export type ValidatorTempoRow = Pick<SubnetHyperparams, "netuid" | "tempo">;
export type ValidatorIdentityRow = Pick<
  AccountIdentity,
  (typeof ACCOUNT_IDENTITY_INSERT_COLUMNS)[number]
>;

export interface ValidatorEnrichmentStore {
  prices(): Promise<ValidatorPriceRow[]>;
  tempos(): Promise<ValidatorTempoRow[]>;
  identities(): Promise<ValidatorIdentityRow[]>;
  latestCompletedCapture(): Promise<number | null>;
}

export function selectedValidatorEnrichmentStore(
  env: unknown,
): ValidatorEnrichmentStore | null {
  if (!env || typeof env !== "object" || !("VALIDATOR_ENRICHMENT_STORE" in env))
    return null;
  const store = env.VALIDATOR_ENRICHMENT_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !["prices", "tempos", "identities", "latestCompletedCapture"].every(
      (name) => typeof (store as Record<string, unknown>)[name] === "function",
    )
  )
    throw new TypeError("Invalid native validator enrichment store");
  return store as ValidatorEnrichmentStore;
}
