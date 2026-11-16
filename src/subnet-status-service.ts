/** Explicit native service; no namespace, object-id or platform emulation. */
export interface SubnetStatusService {
  fetch(request: Request): Promise<Response>;
}
export interface SubnetStatusServiceEnv {
  SUBNET_STATUS_SERVICE?: unknown;
  SUBNET_STATUS_HUB?: Pick<DurableObjectNamespace, "get" | "idFromName">;
}

export interface SubnetStatusCaller {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

/** A malformed selected native service never falls back to a Worker binding. */
export function subnetStatusService(
  env: SubnetStatusServiceEnv | null | undefined,
): SubnetStatusCaller | undefined {
  const native = env?.SUBNET_STATUS_SERVICE;
  if (native !== undefined) {
    if (!native || typeof (native as { fetch?: unknown }).fetch !== "function")
      throw new TypeError("Invalid native subnet status service");
    const service = native as SubnetStatusService;
    return { fetch: (input, init) => service.fetch(new Request(input, init)) };
  }
  const namespace = env?.SUBNET_STATUS_HUB;
  return namespace
    ? {
        fetch: (input, init) =>
          namespace.get(namespace.idFromName("global")).fetch(input, init),
      }
    : undefined;
}

export interface SubnetStatusNotifier {
  maxConcurrent: number;
  notify(sessionId: string, uri: string, signal: AbortSignal): Promise<unknown>;
}
export function subnetStatusNotifier(
  value: unknown,
): SubnetStatusNotifier | undefined {
  if (value === undefined) return;
  const candidate = value as Partial<SubnetStatusNotifier> | null;
  if (
    !candidate ||
    typeof candidate.notify !== "function" ||
    !Number.isSafeInteger(candidate.maxConcurrent) ||
    candidate.maxConcurrent! < 1 ||
    candidate.maxConcurrent! > 100
  )
    throw new TypeError("Invalid native subnet status notifier");
  return candidate as SubnetStatusNotifier;
}
