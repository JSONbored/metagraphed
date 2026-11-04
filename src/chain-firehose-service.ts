import type {
  SubnetStatusCaller,
  SubnetStatusService,
} from "./subnet-status-service.ts";
export interface ChainFirehoseServiceEnv {
  CHAIN_FIREHOSE_SERVICE?: unknown;
  CHAIN_FIREHOSE_HUB?: Pick<DurableObjectNamespace, "get" | "idFromName">;
}
/** The chain actor itself is separate; this selects only its existing internal protocol. */
export function chainFirehoseService(
  env: ChainFirehoseServiceEnv,
): SubnetStatusCaller | undefined {
  const native = env.CHAIN_FIREHOSE_SERVICE;
  if (native !== undefined) {
    if (!native || typeof (native as { fetch?: unknown }).fetch !== "function")
      throw new TypeError("Invalid native chain firehose service");
    const service = native as SubnetStatusService;
    return { fetch: (input, init) => service.fetch(new Request(input, init)) };
  }
  const namespace = env.CHAIN_FIREHOSE_HUB;
  return namespace
    ? {
        fetch: (input, init) =>
          namespace.get(namespace.idFromName("global")).fetch(input, init),
      }
    : undefined;
}
