export interface QueuePayload {
  id: string;
  createdAtMs: number;
  attempts: number;
  body: unknown;
}
export type QueueDecision =
  { action: "ack" } | { action: "retry"; delaySeconds?: number };

export function queueDelaySeconds(
  value: number | undefined,
  fallback = 0,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > 86400)
    throw new RangeError(
      "Queue delay must be an integer from 0 to 86400 seconds",
    );
  return value;
}

function retryDecision(options?: QueueRetryOptions): QueueDecision {
  return {
    action: "retry",
    ...(options?.delaySeconds === undefined
      ? {}
      : { delaySeconds: queueDelaySeconds(options.delaySeconds) }),
  };
}

/** Individual decisions override the batch default; each scope is first-call-wins. */
export function queueDelivery(
  queue: string,
  payloads: readonly QueuePayload[],
  metrics: QueueMetrics,
) {
  let open = true;
  let batchDecision: QueueDecision | undefined;
  const decisions = new Map<string, QueueDecision>();
  const decide = (id: string, decision: () => QueueDecision) => {
    if (open && !decisions.has(id)) decisions.set(id, decision());
  };
  const batch: MessageBatch<unknown> = {
    queue,
    metadata: { metrics },
    messages: payloads.map((payload) => ({
      id: payload.id,
      timestamp: new Date(payload.createdAtMs),
      attempts: payload.attempts,
      body: payload.body,
      ack: () => decide(payload.id, () => ({ action: "ack" })),
      retry: (options) => decide(payload.id, () => retryDecision(options)),
    })),
    ackAll() {
      if (open && !batchDecision) batchDecision = { action: "ack" };
    },
    retryAll(options) {
      if (open && !batchDecision) batchDecision = retryDecision(options);
    },
  };
  return {
    batch,
    finish(failed: boolean): readonly QueueDecision[] {
      open = false;
      return payloads.map(
        (payload) =>
          decisions.get(payload.id) ??
          batchDecision ?? { action: failed ? "retry" : "ack" },
      );
    },
  };
}
