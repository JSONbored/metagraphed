import type {
  SubnetStatusCaller,
  SubnetStatusService,
} from "./subnet-status-service.ts";

export interface AlerterServiceEnv {
  ALERTER_SERVICE?: unknown;
  ALERTER_HUB?: Pick<DurableObjectNamespace, "get" | "idFromName">;
}

export function alerterService(
  env: AlerterServiceEnv,
): SubnetStatusCaller | undefined {
  const native = env.ALERTER_SERVICE;
  if (native !== undefined) {
    if (!native || typeof (native as { fetch?: unknown }).fetch !== "function")
      throw new TypeError("Invalid native alerter service");
    const service = native as SubnetStatusService;
    return { fetch: (input, init) => service.fetch(new Request(input, init)) };
  }
  const namespace = env.ALERTER_HUB;
  return namespace
    ? {
        fetch: (input, init) =>
          namespace.get(namespace.idFromName("global")).fetch(input, init),
      }
    : undefined;
}
