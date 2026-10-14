import type { D1StoreBinding } from "./d1-store.ts";
import { sha256Hex } from "./sha256-hex.ts";
import {
  deliveryRecordFor,
  mapBounded,
  webhookEventId,
  webhookIdempotencyKey,
  WEBHOOK_DELIVERY_TTL_SECONDS,
} from "./webhooks.ts";
import {
  validWebhookDeliveryMessage,
  type WebhookDeliveryMessage,
} from "./webhook-queue.ts";

type Row = Record<string, unknown>;
interface Intent {
  subscription_id: string;
  event_id: string;
  idempotency_key: string;
  state: "ready" | "sending" | "pending" | "delivered" | "dead";
  sequence: number;
  generation: number;
  replay_token: string | null;
  uncertain_history?: number;
  lease_token: string | null;
  lease_until: number | null;
  queued_at: number | null;
  round: number;
  reason: string | null;
  status_code: number | null;
  last_attempt_at: number | null;
  next_attempt_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}
interface WebhookAttempt {
  subscriptionId: string;
  eventId: string;
  sequence: number;
  token: string;
  round: number;
}
type WebhookClaim =
  | { kind: "claimed"; attempt: WebhookAttempt }
  | { kind: "delivered" | "dead" | "busy" | "stale"; record: Row };
const TTL = WEBHOOK_DELIVERY_TTL_SECONDS * 1000;
const LEASE_MS = 60_000;
const iso = (v: number | null) =>
  v === null ? null : new Date(v).toISOString();
function time(now: number) {
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !Number.isSafeInteger(now + TTL)
  )
    throw new Error("Invalid webhook ledger clock");
}
function record(row: Intent, now: number): Row {
  const expired = row.state === "sending" && row.lease_until! <= now;
  const uncertain =
    row.state !== "delivered" && (expired || row.uncertain_history === 1);
  return {
    ...deliveryRecordFor({
      subscriptionId: row.subscription_id,
      eventId: row.event_id,
      result: { reason: row.reason, status_code: row.status_code },
      disposition:
        row.state === "delivered"
          ? "delivered"
          : row.state === "dead"
            ? "dead"
            : "retry",
      attempts: row.round,
      nowIso: iso(row.last_attempt_at) ?? new Date(now).toISOString(),
      nextAttemptAt: iso(row.next_attempt_at),
    }),
    state: expired
      ? "ambiguous"
      : row.state === "ready"
        ? "pending"
        : row.state,
    round: row.round,
    reason: uncertain
      ? row.reason?.includes("outcome-unknown")
        ? row.reason
        : `outcome-unknown; at-least-once retry may repeat a remote effect${row.reason ? `; ${row.reason}` : ""}`
      : row.reason,
    status_code: row.status_code,
    last_attempt_at: iso(row.last_attempt_at),
    next_attempt_at: iso(row.next_attempt_at),
  };
}

/** One existing native D1 owner. Queue retries retain their published policy. */
export function webhookLedgerD1(db: D1StoreBinding) {
  type ProvenIntent = Intent & {
    proven_sequence: number | null;
    proven_status: number | null;
    proven_at: number | null;
  };
  const projection = `SELECT i.*,a.sequence AS proven_sequence,a.status_code AS proven_status,a.finished_at AS proven_at,EXISTS(SELECT 1 FROM webhook_delivery_attempts u WHERE u.subscription_id=i.subscription_id AND u.event_id=i.event_id AND u.outcome='ambiguous') AS uncertain_history
    FROM webhook_delivery_intents i LEFT JOIN webhook_delivery_attempts a ON a.subscription_id=i.subscription_id AND a.event_id=i.event_id
    AND a.sequence=(SELECT sequence FROM webhook_delivery_attempts p WHERE p.subscription_id=i.subscription_id AND p.event_id=i.event_id AND p.outcome='delivered' ORDER BY sequence LIMIT 1)`;
  const proven = (row: ProvenIntent): Intent =>
    row.proven_sequence !== null && row.proven_sequence !== undefined
      ? {
          ...row,
          state: "delivered",
          lease_token: null,
          lease_until: null,
          reason: null,
          status_code: row.proven_status,
          last_attempt_at: row.proven_at,
          next_attempt_at: null,
        }
      : row;
  const read = async (s: string, e: string) => {
    const row = await db
      .prepare(projection + " WHERE i.subscription_id=? AND i.event_id=?")
      .bind(s, e)
      .first<ProvenIntent>();
    return row ? proven(row) : null;
  };
  const ensure = async (
    message: WebhookDeliveryMessage,
    now: number,
    legacy?: Row | null,
  ) => {
    time(now);
    if (
      typeof message.subscription_id !== "string" ||
      !message.subscription_id ||
      message.subscription_id.length > 128 ||
      (message.generation !== undefined &&
        (!Number.isSafeInteger(message.generation) ||
          message.generation < 0)) ||
      typeof message.body !== "string" ||
      !message.body ||
      new TextEncoder().encode(message.body).byteLength > 128 * 1024 ||
      (await webhookEventId(message.body)) !== message.event_id
    )
      throw new Error("Webhook event identity or payload budget differs");
    const digest = await sha256Hex(message.body),
      idempotency = await webhookIdempotencyKey(
        message.subscription_id,
        message.body,
      );
    await db.batch([
      db
        .prepare(
          "INSERT INTO webhook_delivery_events(event_id,payload_sha256,body,created_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING",
        )
        .bind(message.event_id, digest, message.body, now, now + TTL),
      db
        .prepare(
          "INSERT INTO webhook_delivery_intents(subscription_id,event_id,idempotency_key,created_at,updated_at,expires_at) SELECT ?,?,?,?,?,? FROM webhook_delivery_events WHERE event_id=? AND payload_sha256=? AND body=? ON CONFLICT(subscription_id,event_id) DO NOTHING",
        )
        .bind(
          message.subscription_id,
          message.event_id,
          idempotency,
          now,
          now,
          now + TTL,
          message.event_id,
          digest,
          message.body,
        ),
      db
        .prepare(
          "UPDATE webhook_delivery_intents SET updated_at=MAX(updated_at,?),expires_at=MAX(expires_at,?) WHERE subscription_id=? AND event_id=? AND idempotency_key=?",
        )
        .bind(
          now,
          now + TTL,
          message.subscription_id,
          message.event_id,
          idempotency,
        ),
      db
        .prepare(
          "UPDATE webhook_delivery_events SET expires_at=MAX(expires_at,?) WHERE event_id=?",
        )
        .bind(now + TTL, message.event_id),
    ]);
    const event = await db
      .prepare(
        "SELECT payload_sha256,body FROM webhook_delivery_events WHERE event_id=?",
      )
      .bind(message.event_id)
      .first<{ payload_sha256: string; body: string }>();
    let row = await read(message.subscription_id, message.event_id);
    if (
      !event ||
      event.payload_sha256 !== digest ||
      event.body !== message.body ||
      !row ||
      row.idempotency_key !== idempotency
    )
      throw new Error("Webhook durable intent identity was not committed");
    if (
      legacy?.state === "delivered" &&
      legacy.event_id === message.event_id &&
      legacy.subscription_id === message.subscription_id &&
      row.state !== "delivered"
    ) {
      const at =
        typeof legacy.last_attempt_at === "string"
          ? Date.parse(legacy.last_attempt_at)
          : NaN;
      await db
        .prepare(
          "UPDATE webhook_delivery_intents SET state='delivered',lease_token=NULL,lease_until=NULL,reason=NULL,status_code=?,last_attempt_at=?,next_attempt_at=NULL,updated_at=?,expires_at=? WHERE subscription_id=? AND event_id=? AND state<>'delivered'",
        )
        .bind(
          typeof legacy.status_code === "number" ? legacy.status_code : null,
          Number.isFinite(at) ? at : null,
          now,
          now + TTL,
          message.subscription_id,
          message.event_id,
        )
        .run();
      row = await read(message.subscription_id, message.event_id);
      if (!row || row.state !== "delivered")
        throw new Error("Legacy webhook success was not retained");
    }
    return row;
  };
  const claim = async (
    message: WebhookDeliveryMessage,
    targetUrl: string,
    round: number,
    now: number,
    legacy?: Row | null,
  ): Promise<WebhookClaim> => {
    if (
      typeof targetUrl !== "string" ||
      targetUrl.length > 8192 ||
      !Number.isSafeInteger(round) ||
      round < 1 ||
      round > 8
    )
      throw new Error("Invalid webhook attempt");
    const row = await ensure(message, now, legacy);
    if ((message.generation ?? 0) !== row.generation)
      return { kind: "stale", record: record(row, now) };
    if (row.state === "delivered" || row.state === "dead")
      return { kind: row.state, record: record(row, now) };
    if (row.state !== "ready" && round <= row.round)
      return { kind: "stale", record: record(row, now) };
    if (
      row.state === "pending" &&
      row.next_attempt_at !== null &&
      row.next_attempt_at > now
    )
      return { kind: "busy", record: record(row, now) };
    if (row.state === "sending" && row.lease_until! > now)
      return { kind: "busy", record: record(row, now) };
    if (!Number.isSafeInteger(row.sequence + 1))
      throw new Error("Webhook attempt sequence exceeds its budget");
    const token = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          "UPDATE webhook_delivery_attempts SET outcome='ambiguous',finished_at=?,ambiguous_at=COALESCE(ambiguous_at,?),reason='outcome-unknown' WHERE subscription_id=? AND event_id=? AND outcome='sending' AND token IN (SELECT lease_token FROM webhook_delivery_intents WHERE subscription_id=? AND event_id=? AND state='sending' AND lease_until<=?)",
        )
        .bind(
          now,
          now,
          message.subscription_id,
          message.event_id,
          message.subscription_id,
          message.event_id,
          now,
        ),
      db
        .prepare(
          "UPDATE webhook_delivery_intents SET state='sending',sequence=sequence+1,lease_token=?,lease_until=?,queued_at=COALESCE(queued_at,?),round=?,reason='outcome-pending',status_code=NULL,last_attempt_at=?,next_attempt_at=NULL,updated_at=?,expires_at=? WHERE subscription_id=? AND event_id=? AND sequence=? AND state<>'delivered' AND NOT EXISTS(SELECT 1 FROM webhook_delivery_attempts a WHERE a.subscription_id=webhook_delivery_intents.subscription_id AND a.event_id=webhook_delivery_intents.event_id AND a.outcome='delivered') AND generation=? AND state<>'dead' AND (state='ready' OR round<?) AND (state<>'pending' OR next_attempt_at IS NULL OR next_attempt_at<=?) AND (state<>'sending' OR lease_until<=?)",
        )
        .bind(
          token,
          now + LEASE_MS,
          now,
          round,
          now,
          now,
          now + TTL,
          message.subscription_id,
          message.event_id,
          row.sequence,
          message.generation ?? 0,
          round,
          now,
          now,
        ),
      db
        .prepare(
          "INSERT INTO webhook_delivery_attempts(subscription_id,event_id,sequence,token,target_url,generation,round,started_at) SELECT subscription_id,event_id,sequence,lease_token,?,generation,round,? FROM webhook_delivery_intents WHERE subscription_id=? AND event_id=? AND lease_token=? ON CONFLICT(token) DO NOTHING",
        )
        .bind(targetUrl, now, message.subscription_id, message.event_id, token),
    ]);
    const current = await read(message.subscription_id, message.event_id);
    if (!current) throw new Error("Webhook claim was not committed");
    if (current.lease_token !== token)
      return {
        kind:
          current.state === "delivered"
            ? "delivered"
            : current.state === "dead"
              ? "dead"
              : "busy",
        record: record(current, now),
      };
    const attempt = await db
      .prepare("SELECT token FROM webhook_delivery_attempts WHERE token=?")
      .bind(token)
      .first<{ token: string }>();
    if (!attempt) throw new Error("Webhook attempt intent was not committed");
    return {
      kind: "claimed",
      attempt: {
        subscriptionId: message.subscription_id,
        eventId: message.event_id,
        sequence: current.sequence,
        token,
        round: current.round,
      },
    };
  };
  const finish = async (
    attempt: WebhookAttempt,
    result: Row,
    disposition: "delivered" | "retry" | "dead",
    now: number,
    nextAttemptAt: number | null,
  ) => {
    time(now);
    const known = await db
      .prepare(
        "SELECT outcome FROM webhook_delivery_attempts WHERE subscription_id=? AND event_id=? AND sequence=? AND token=?",
      )
      .bind(
        attempt.subscriptionId,
        attempt.eventId,
        attempt.sequence,
        attempt.token,
      )
      .first<{ outcome: string }>();
    if (!known) throw new Error("Webhook attempt identity differs");
    const outcome =
      disposition === "delivered"
        ? "delivered"
        : result.status === "skipped" || result.status === "filtered"
          ? "skipped"
          : result.reason === "resolve-error"
            ? "failed"
            : "ambiguous";
    const detail =
      typeof result.reason === "string"
        ? result.reason.slice(0, 450)
        : outcome === "skipped"
          ? String(result.status)
          : "outcome-unknown";
    const reason =
      disposition === "delivered"
        ? null
        : outcome === "ambiguous"
          ? `outcome-unknown: ${detail}`
          : detail;
    const status =
      typeof result.status_code === "number" &&
      Number.isInteger(result.status_code)
        ? result.status_code
        : null;
    await db.batch([
      db
        .prepare(
          "UPDATE webhook_delivery_attempts SET outcome=?,finished_at=?,ambiguous_at=CASE WHEN ?='ambiguous' THEN COALESCE(ambiguous_at,?) ELSE ambiguous_at END,reason=?,status_code=? WHERE subscription_id=? AND event_id=? AND sequence=? AND token=? AND outcome IN ('sending','ambiguous')",
        )
        .bind(
          outcome,
          now,
          outcome,
          now,
          reason,
          status,
          attempt.subscriptionId,
          attempt.eventId,
          attempt.sequence,
          attempt.token,
        ),
      db
        .prepare(
          "UPDATE webhook_delivery_intents SET state=?,lease_token=NULL,lease_until=NULL,reason=?,status_code=?,last_attempt_at=?,next_attempt_at=?,updated_at=?,expires_at=? WHERE subscription_id=? AND event_id=? AND state<>'delivered' AND ((?='delivered' AND EXISTS(SELECT 1 FROM webhook_delivery_attempts a WHERE a.token=? AND a.outcome='delivered')) OR (lease_token=? AND EXISTS(SELECT 1 FROM webhook_delivery_attempts a WHERE a.token=? AND a.outcome=?) AND NOT EXISTS(SELECT 1 FROM webhook_delivery_attempts a WHERE a.subscription_id=webhook_delivery_intents.subscription_id AND a.event_id=webhook_delivery_intents.event_id AND a.outcome='delivered')))",
        )
        .bind(
          disposition === "retry" ? "pending" : disposition,
          reason,
          status,
          now,
          disposition === "retry" ? nextAttemptAt : null,
          now,
          now + TTL,
          attempt.subscriptionId,
          attempt.eventId,
          disposition,
          attempt.token,
          attempt.token,
          attempt.token,
          outcome,
        ),
    ]);
    const terminal = await db
      .prepare("SELECT outcome FROM webhook_delivery_attempts WHERE token=?")
      .bind(attempt.token)
      .first<{ outcome: string }>();
    const current = await read(attempt.subscriptionId, attempt.eventId);
    if (!terminal || terminal.outcome !== outcome || !current)
      throw new Error("Webhook outcome was not committed");
    if (current.lease_token === attempt.token)
      throw new Error("Webhook outcome projection was not committed");
    if (disposition === "delivered" && current.state !== "delivered")
      throw new Error("Webhook success was not committed");
    return record(current, now);
  };
  return {
    ensure,
    /** Admit the complete selected KV page in one native transaction. There
     * is no partially committed recipient cursor to lose on a reply failure. */
    async ensureFanout(messages: WebhookDeliveryMessage[], now: number) {
      time(now);
      if (messages.length > 1000)
        throw new Error("Webhook fanout exceeds the selected KV page budget");
      if (!messages.length) return;
      const event = messages[0];
      if (
        !validWebhookDeliveryMessage(event) ||
        new TextEncoder().encode(event.body).byteLength > 131072 ||
        (await webhookEventId(event.body)) !== event.event_id
      )
        throw new Error("Webhook fanout event identity differs");
      const seen = new Set<string>();
      for (const message of messages) {
        if (
          message.body !== event.body ||
          message.event_id !== event.event_id ||
          typeof message.subscription_id !== "string" ||
          !message.subscription_id ||
          message.subscription_id.length > 128 ||
          seen.has(message.subscription_id) ||
          (message.generation ?? 0) !== 0
        )
          throw new Error("Webhook fanout recipient identity differs");
        seen.add(message.subscription_id);
      }
      const digest = await sha256Hex(event.body);
      const recipients = await mapBounded(messages, 6, async (message) => ({
        id: message.subscription_id,
        key: await webhookIdempotencyKey(message.subscription_id, event.body),
      }));
      const encoded = JSON.stringify(recipients);
      await db.batch([
        db
          .prepare(
            "INSERT INTO webhook_delivery_events(event_id,payload_sha256,body,created_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING",
          )
          .bind(event.event_id, digest, event.body, now, now + TTL),
        db
          .prepare(
            "INSERT INTO webhook_delivery_intents(subscription_id,event_id,idempotency_key,created_at,updated_at,expires_at) SELECT json_extract(r.value,'$.id'),?,json_extract(r.value,'$.key'),?,?,? FROM json_each(?) r WHERE EXISTS(SELECT 1 FROM webhook_delivery_events WHERE event_id=? AND payload_sha256=? AND body=?) ON CONFLICT(subscription_id,event_id) DO NOTHING",
          )
          .bind(
            event.event_id,
            now,
            now,
            now + TTL,
            encoded,
            event.event_id,
            digest,
            event.body,
          ),
        db
          .prepare(
            "UPDATE webhook_delivery_intents SET updated_at=MAX(updated_at,?),expires_at=MAX(expires_at,?) WHERE event_id=? AND subscription_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
          )
          .bind(now, now + TTL, event.event_id, encoded),
        db
          .prepare(
            "UPDATE webhook_delivery_events SET expires_at=MAX(expires_at,?) WHERE event_id=?",
          )
          .bind(now + TTL, event.event_id),
      ]);
      const original = await db
        .prepare(
          "SELECT payload_sha256,body FROM webhook_delivery_events WHERE event_id=?",
        )
        .bind(event.event_id)
        .first<{ payload_sha256: string; body: string }>();
      const saved = await db
        .prepare(
          "SELECT subscription_id,idempotency_key FROM webhook_delivery_intents WHERE event_id=? AND subscription_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
        )
        .bind(event.event_id, encoded)
        .all<{ subscription_id: string; idempotency_key: string }>();
      const identities = new Map(
        saved.results.map((r) => [r.subscription_id, r.idempotency_key]),
      );
      if (
        original?.payload_sha256 !== digest ||
        original.body !== event.body ||
        recipients.some((r) => identities.get(r.id) !== r.key)
      )
        throw new Error("Webhook complete fanout was not durably acknowledged");
    },
    claim,
    finish,
    /** Called only by an authenticated operator replay action, never by queue
     * redelivery. A stable request token resolves a lost authorization reply. */
    async authorizeReplay(
      message: WebhookDeliveryMessage,
      requestToken: string,
      now: number,
    ) {
      if (
        typeof requestToken !== "string" ||
        !requestToken ||
        requestToken.length > 128
      )
        throw new Error("Invalid webhook replay authorization");
      const previous = await ensure(message, now);
      if (previous.replay_token !== requestToken) {
        await db
          .prepare(
            "UPDATE webhook_delivery_intents SET generation=generation+1,replay_token=?,state='ready',round=0,queued_at=NULL,reason=NULL,status_code=NULL,last_attempt_at=NULL,next_attempt_at=NULL,updated_at=?,expires_at=? WHERE subscription_id=? AND event_id=? AND generation=? AND state='dead' AND NOT EXISTS(SELECT 1 FROM webhook_delivery_attempts a WHERE a.subscription_id=webhook_delivery_intents.subscription_id AND a.event_id=webhook_delivery_intents.event_id AND a.outcome='delivered')",
          )
          .bind(
            requestToken,
            now,
            now + TTL,
            message.subscription_id,
            message.event_id,
            message.generation ?? 0,
          )
          .run();
      }
      const current = await read(message.subscription_id, message.event_id);
      if (
        !current ||
        current.replay_token !== requestToken ||
        current.state === "delivered"
      )
        throw new Error("Webhook manual replay was not authorized");
      return { ...message, generation: current.generation };
    },
    async enqueued(s: string, e: string, now: number, generation = 0) {
      time(now);
      const existing = await read(s, e);
      if (existing?.state === "delivered") return;
      await db
        .prepare(
          "UPDATE webhook_delivery_intents SET queued_at=COALESCE(queued_at,?),updated_at=MAX(updated_at,?),expires_at=MAX(expires_at,?) WHERE subscription_id=? AND event_id=? AND generation=?",
        )
        .bind(now, now, now + TTL, s, e, generation)
        .run();
      const r = await read(s, e);
      if (r && r.generation !== generation) return;
      if (!r?.queued_at)
        throw new Error("Webhook enqueue acknowledgment was not committed");
    },
    async outbox(now: number): Promise<WebhookDeliveryMessage[]> {
      time(now);
      const r = await db
        .prepare(
          "SELECT i.subscription_id,i.event_id,i.generation,e.body FROM webhook_delivery_intents i JOIN webhook_delivery_events e USING(event_id) WHERE i.state='ready' AND i.queued_at IS NULL AND i.expires_at>? AND NOT EXISTS(SELECT 1 FROM webhook_delivery_attempts a WHERE a.subscription_id=i.subscription_id AND a.event_id=i.event_id AND a.outcome='delivered') ORDER BY i.created_at,i.subscription_id,i.event_id LIMIT 4",
        )
        .bind(now)
        .all<WebhookDeliveryMessage>();
      return r.results.map(({ generation, ...message }) =>
        generation ? { ...message, generation } : message,
      );
    },
    async recent(s: string, now: number) {
      time(now);
      const r = await db
        .prepare(
          projection +
            " WHERE i.subscription_id=? AND i.expires_at>? ORDER BY i.updated_at DESC,i.event_id LIMIT 256",
        )
        .bind(s, now)
        .all<ProvenIntent>();
      return r.results.map((r) => record(proven(r), now));
    },
    async byEvents(s: string, events: string[], now: number) {
      time(now);
      if (events.length > 256)
        throw new Error("Webhook status ownership batch exceeds its budget");
      if (!events.length) return [];
      const rows: ProvenIntent[] = [];
      for (let offset = 0; offset < events.length; offset += 98) {
        const keys = events.slice(offset, offset + 98);
        const result = await db
          .prepare(
            projection +
              ` WHERE i.subscription_id=? AND i.event_id IN (${keys.map(() => "?").join(",")}) AND i.expires_at>?`,
          )
          .bind(s, ...keys, now)
          .all<ProvenIntent>();
        rows.push(...result.results);
      }
      return rows.map((r) => record(proven(r), now));
    },
    /** Queue+DLQ retention is at most14days each. Past32 inactive days,
     * no transport message can survive; retain a terminal unknown outcome.
     * This finalizes evidence only and never sends or schedules HTTP. */
    async recoverExpired(now: number): Promise<number> {
      time(now);
      const cutoff = now - 32 * 86400000;
      const stale = await db
        .prepare(
          "SELECT i.subscription_id,i.event_id,i.generation,e.body FROM webhook_delivery_intents i JOIN webhook_delivery_events e USING(event_id) WHERE i.state IN ('pending','sending','ready') AND i.queued_at IS NOT NULL AND i.updated_at<? ORDER BY i.updated_at LIMIT 4",
        )
        .bind(cutoff)
        .all<WebhookDeliveryMessage>();
      for (const message of stale.results)
        await this.deadLetter(
          message,
          now,
          "queue-retention-expired; outcome-unknown",
        );
      return stale.results.length;
    },
    async deadLetter(
      message: WebhookDeliveryMessage,
      now: number,
      cause = "dead-letter",
    ) {
      const r = await ensure(message, now);
      if ((message.generation ?? 0) !== r.generation)
        return { ...record(r, now), state: "stale" };
      // A duplicate transport can exhaust before another copy's logical
      // retry. DLQ exhaustion is not ownership of that persisted retry.
      if (
        cause === "dead-letter" &&
        (r.state === "pending" ||
          (r.state === "ready" && r.queued_at !== null) ||
          (r.state === "sending" && r.lease_until! <= now && r.round < 8))
      ) {
        if (r.state === "sending")
          await db
            .prepare(
              "UPDATE webhook_delivery_attempts SET outcome='ambiguous',finished_at=?,ambiguous_at=COALESCE(ambiguous_at,?),reason='outcome-unknown' WHERE token=? AND outcome='sending'",
            )
            .bind(now, now, r.lease_token)
            .run();
        const current = await read(message.subscription_id, message.event_id);
        if (!current)
          throw new Error("Webhook transport exhaustion was not retained");
        return { ...record(current, now), state: "stale" };
      }
      if (
        r.state !== "delivered" &&
        !(r.state === "sending" && r.lease_until! > now)
      ) {
        await db.batch([
          db
            .prepare(
              "UPDATE webhook_delivery_attempts SET outcome='ambiguous',finished_at=?,ambiguous_at=COALESCE(ambiguous_at,?),reason='outcome-unknown' WHERE token IN (SELECT lease_token FROM webhook_delivery_intents WHERE subscription_id=? AND event_id=? AND state='sending' AND lease_until<=?) AND outcome='sending'",
            )
            .bind(now, now, message.subscription_id, message.event_id, now),
          db
            .prepare(
              "UPDATE webhook_delivery_intents SET state='dead',lease_token=NULL,lease_until=NULL,reason=CASE WHEN state='sending' THEN ?||'; outcome-unknown' ELSE COALESCE(reason,?) END,next_attempt_at=NULL,updated_at=?,expires_at=? WHERE subscription_id=? AND event_id=? AND state<>'delivered' AND NOT EXISTS(SELECT 1 FROM webhook_delivery_attempts a WHERE a.subscription_id=webhook_delivery_intents.subscription_id AND a.event_id=webhook_delivery_intents.event_id AND a.outcome='delivered') AND generation=? AND (state<>'sending' OR lease_until<=?)",
            )
            .bind(
              cause,
              cause,
              now,
              now + TTL,
              message.subscription_id,
              message.event_id,
              message.generation ?? 0,
              now,
            ),
        ]);
      }
      const current = await read(message.subscription_id, message.event_id);
      if (!current)
        throw new Error("Webhook dead-letter record was not committed");
      if (
        current.state !== "delivered" &&
        !(current.state === "sending" && current.lease_until! > now) &&
        current.state !== "dead"
      )
        throw new Error("Webhook dead-letter outcome was not committed");
      return record(current, now);
    },
    async prune(now: number) {
      time(now);
      await db.batch([
        db
          .prepare(
            "DELETE FROM webhook_delivery_intents WHERE (subscription_id,event_id) IN (SELECT subscription_id,event_id FROM webhook_delivery_intents WHERE expires_at<=? ORDER BY expires_at LIMIT 1024)",
          )
          .bind(now),
        db
          .prepare(
            "DELETE FROM webhook_delivery_events WHERE event_id IN (SELECT e.event_id FROM webhook_delivery_events e WHERE e.expires_at<=? AND NOT EXISTS(SELECT 1 FROM webhook_delivery_intents i WHERE i.event_id=e.event_id) ORDER BY e.expires_at,e.event_id LIMIT 1024)",
          )
          .bind(now),
      ]);
    },
  };
}

type WebhookLedger = ReturnType<typeof webhookLedgerD1>;

/** No legacy write fallback: native delivery needs this existing bound owner. */
export function webhookLedgerForEnv(env: unknown): WebhookLedger | null {
  const db =
    env && typeof env === "object"
      ? (env as { D1_STATE?: D1StoreBinding }).D1_STATE
      : undefined;
  return typeof db?.prepare === "function" && typeof db.batch === "function"
    ? webhookLedgerD1(db)
    : null;
}
