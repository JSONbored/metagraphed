// PostgreSQL implementation of the subnet-services store (#13164): one
// bounded read of app.subnet_services (migration 0047), the service-URL
// registry the engine's Services decode fills (events ServiceSet /
// ServiceRemoved). The bigint columns cross as text because the driver would
// otherwise hand back BigInts the JSON builders cannot serialize.
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { SubnetServicesStore } from "./subnet-services-store.ts";

/** The row the SELECT below produces, named so the read is drift-covered. */
type SubnetServiceRow = {
  hotkey: string;
  service_url: string;
  /** bigint block height, crossed as text -- see the module header. */
  set_at: string | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgSubnetServicesStore(
  runtime: Pick<PgStoreRuntime, "read">,
): SubnetServicesStore {
  return {
    async rows(netuid: number) {
      // Same identity bound the routes enforce (a netuid is a u16); a store
      // must not widen it into a scan nothing can have asked for.
      if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
        throw new TypeError("Invalid native subnet services identity");
      return await runtime.read.query<SubnetServiceRow>(
        "SELECT hotkey, service_url, set_at::text AS set_at, " +
          "captured_at::text AS captured_at " +
          "FROM app.subnet_services WHERE netuid=$1::bigint ORDER BY hotkey",
        [netuid],
      );
    },
  };
}
