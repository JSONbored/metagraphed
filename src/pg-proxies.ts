// PostgreSQL implementation of the account-proxies store (#13166): one
// bounded read of app.proxies (migration 0055), the Proxy pallet delegation
// state the engine's Proxy.Proxies decode fills. deposit is u64 decimal text
// in the column already; the bigint columns cross as text because the driver
// would otherwise hand back BigInts the JSON builders cannot serialize.
import { isFinneySs58Address } from "./finney-ss58.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { AccountProxiesStore } from "./account-proxies-store.ts";

/** The row the SELECT below produces, named so the read is drift-covered. */
type ProxyRow = {
  delegate: string;
  proxy_type: string;
  /** bigint announcement delay in blocks, crossed as text. */
  delay: string;
  deposit: string | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgAccountProxiesStore(
  runtime: Pick<PgStoreRuntime, "read">,
): AccountProxiesStore {
  return {
    async rows(delegator: string) {
      // Same identity bound the routes enforce; a store must not widen a
      // malformed address into a scan nothing can have asked for.
      if (!isFinneySs58Address(delegator))
        throw new TypeError("Invalid native account proxies identity");
      return await runtime.read.query<ProxyRow>(
        "SELECT delegate, proxy_type, delay::text AS delay, deposit, " +
          "captured_at::text AS captured_at " +
          "FROM app.proxies WHERE delegator=$1 " +
          "ORDER BY delegate, proxy_type, delay",
        [delegator],
      );
    },
  };
}
