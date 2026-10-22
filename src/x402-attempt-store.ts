export interface X402Attempt {
  identityKey: string;
  requestFingerprint: string;
  facilitatorUrl: string;
  envelope: string | null;
  payer: string;
  state: "pending" | "consumed";
  receipt: string | null;
}

export interface X402AttemptStore {
  get(identityKey: string): Promise<X402Attempt | null>;
  bind(input: {
    identityKey: string;
    requestFingerprint: string;
    facilitatorUrl: string;
    envelope: string;
    payer: string;
  }): Promise<X402Attempt>;
  consume(
    identityKey: string,
    requestFingerprint: string,
    receipt: string,
  ): Promise<boolean>;
}

const columns = `identity_key AS identityKey,
  request_fingerprint AS requestFingerprint,facilitator_url AS facilitatorUrl,
  envelope,payer,state,receipt`;

/** Bind a verified payment before settlement, then claim paid work once.
 * Pending envelopes survive ambiguous settlement replies; consumed tombstones
 * retain the receipt permanently so the same signed payment cannot run again. */
export function createX402AttemptStore(
  db: D1Database | undefined,
): X402AttemptStore | null {
  if (!db) return null;
  // Sessions make the first lookup authoritative even with read replication.
  // Older bindings and SQLite adapters retain the primary-binding behavior.
  const session =
    typeof db.withSession === "function" ? db.withSession("first-primary") : db;
  const get = (identityKey: string) =>
    session
      .prepare(
        `SELECT ${columns} FROM x402_payment_attempts WHERE identity_key=?`,
      )
      .bind(identityKey)
      .first<X402Attempt>();
  return {
    get,
    async bind(input) {
      const inserted = await session
        .prepare(
          `INSERT INTO x402_payment_attempts
          (identity_key,request_fingerprint,facilitator_url,envelope,payer)
          VALUES (?,?,?,?,?) ON CONFLICT(identity_key) DO NOTHING
          RETURNING ${columns}`,
        )
        .bind(
          input.identityKey,
          input.requestFingerprint,
          input.facilitatorUrl,
          input.envelope,
          input.payer,
        )
        .first<X402Attempt>();
      if (inserted) return inserted;
      const existing = await get(input.identityKey);
      if (!existing) throw new Error("Payment attempt was not acknowledged");
      return existing;
    },
    async consume(identityKey, requestFingerprint, receipt) {
      const claimed = await session
        .prepare(
          `UPDATE x402_payment_attempts
          SET state='consumed',receipt=?,envelope=NULL
          WHERE identity_key=? AND request_fingerprint=? AND state='pending'
          RETURNING identity_key`,
        )
        .bind(receipt, identityKey, requestFingerprint)
        .first<{ identity_key: string }>();
      return claimed !== null;
    },
  };
}
