import {
  deliveryStoragePrefix,
  summarizeDeliveryRecords,
  WEBHOOK_REDELIVERY_LIST_LIMIT,
} from "./webhooks.ts";
import { webhookLedgerForEnv } from "./webhook-ledger-d1.ts";

type Row = Record<string, unknown>;
/** Native outcomes take precedence; legacy status remains visible during migration. */
export async function webhookDeliveryStatus(
  env: unknown,
  id: string,
): Promise<Row> {
  const ledger = webhookLedgerForEnv(env);
  let native: Row[] = [];
  if (ledger) {
    try {
      native = await ledger.recent(id, Date.now());
    } catch {
      throw new Error("Webhook delivery status unavailable");
    }
  }
  const kv =
    env && typeof env === "object"
      ? (env as { METAGRAPH_CONTROL?: Pick<KVNamespace, "get" | "list"> })
          .METAGRAPH_CONTROL
      : undefined;
  let legacy: Row[] = [];
  try {
    if (kv?.list) {
      const { keys } = await kv.list({
        prefix: deliveryStoragePrefix(id),
        limit: WEBHOOK_REDELIVERY_LIST_LIMIT,
      });
      const values = await Promise.all(
        keys
          .slice(0, WEBHOOK_REDELIVERY_LIST_LIMIT)
          .map((k) => kv.get(k.name, { type: "json" })),
      );
      legacy = values.filter(
        (r): r is Row =>
          r !== null && typeof r === "object" && !Array.isArray(r),
      );
    }
  } catch {
    /* A legacy projection failure does not erase authoritative outcomes. */
  }
  if (ledger && legacy.length) {
    try {
      const reconciled = await ledger.byEvents(
        id,
        [
          ...new Set(
            legacy
              .map((r) => r.event_id)
              .filter((v): v is string => typeof v === "string"),
          ),
        ],
        Date.now(),
      );
      const included = new Set(native.map((r) => r.event_id));
      native.push(...reconciled.filter((r) => !included.has(r.event_id)));
    } catch {
      throw new Error("Webhook delivery status unavailable");
    }
  }
  const owned = new Set(native.map((r) => r.event_id));
  return summarizeDeliveryRecords([
    ...native,
    ...legacy.filter((r) => !owned.has(r.event_id)),
  ]);
}
