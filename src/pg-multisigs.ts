// PostgreSQL implementation of the account-multisigs store (#13166): one
// bounded read of app.multisigs (migration 0055), the resolved multisig
// compositions the engine's Multisig call/event decode fills. Membership is
// either side: the multisig account itself, or any signatory inside the
// JSONB array (the GIN-indexed containment probe). The membership bind
// crosses as JSON TEXT with an explicit ::jsonb cast -- never a raw array
// the driver would reinterpret as a Postgres array literal (#10179,
// validate:pg-json-binds).
import { isFinneySs58Address } from "./finney-ss58.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { AccountMultisigsStore } from "./account-multisigs-store.ts";

/** The hard row bound: an account belongs to a handful of multisigs, so one
 * read is capped well above any plausible membership. */
export const ACCOUNT_MULTISIGS_ROW_CAP = 256;

/** The row the SELECT below produces, named so the read is drift-covered. */
type MultisigRow = {
  multisig: string;
  /** bigint threshold, crossed as text -- see the module header. */
  threshold: string | null;
  signatories: unknown;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgAccountMultisigsStore(
  runtime: Pick<PgStoreRuntime, "read">,
): AccountMultisigsStore {
  return {
    async byMember(ss58: string) {
      // Same identity bound the routes enforce; a store must not widen a
      // malformed address into a scan nothing can have asked for.
      if (!isFinneySs58Address(ss58))
        throw new TypeError("Invalid native account multisigs identity");
      return await runtime.read.query<MultisigRow>(
        "SELECT multisig, threshold::text AS threshold, signatories, " +
          "captured_at::text AS captured_at " +
          "FROM app.multisigs WHERE multisig=$1 OR signatories @> $2::jsonb " +
          `ORDER BY multisig LIMIT ${ACCOUNT_MULTISIGS_ROW_CAP}`,
        [ss58, JSON.stringify([ss58])],
      );
    },
  };
}
