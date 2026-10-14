import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { webhookLedgerD1 } from "../../src/webhook-ledger-d1.ts";

export async function nativeWebhookFixture() {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  const db = await runtime.getD1Database("DB");
  const sql = readFileSync(
    new URL(
      "../../migrations/d1/0041_webhook_delivery_ledger.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const statement of sql
    .split("-- statement-breakpoint")
    .filter((s) => s.trim()))
    await db.prepare(statement).run();
  return { runtime, db, ledger: webhookLedgerD1(db) };
}

export function webhookMessage(
  subscriptionId = "sub",
  value: unknown = { type: "metagraph.publish" },
) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return {
    subscription_id: subscriptionId,
    event_id: createHash("sha256").update(body).digest("hex").slice(0, 32),
    body,
  };
}
