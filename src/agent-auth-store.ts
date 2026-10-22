/** Private, owner-approved service-auth state. Secrets are hashed by callers. */
export interface AgentAuthRegistration {
  id: string;
  agentName: string;
  emailHint: string;
  permissions: string[];
  claimVersion: number;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
  ownerKind: "github" | null;
  ownerId: string | null;
  ownerEmail: string | null;
  revokedAt: number | null;
}

export interface AgentAuthOwner {
  kind: "github";
  id: string;
  email: string;
}

export interface AgentAuthCeremony {
  stateHash: string;
  registrationId: string;
  claimVersion: number;
  createdAt: number;
  expiresAt: number;
  oauthConsumedAt: number | null;
  ownerKind: "github" | null;
  ownerId: string | null;
  ownerEmail: string | null;
  attempts: number;
}

export type AgentAuthPollResult =
  | { status: "missing" | "expired" | "revoked" }
  | { status: "rate_limited"; retryAfter: number }
  | { status: "pending"; registration: AgentAuthRegistration }
  | {
      status: "approved";
      registration: AgentAuthRegistration;
      issuedAt: number;
      assertionExpiresAt: number;
    };

export interface AgentAuthStore {
  ready(): Promise<boolean>;
  createRegistration(input: {
    id: string;
    agentName: string;
    emailHint: string;
    permissions: readonly string[];
    claimTokenHash: string;
    userCodeHash: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<AgentAuthRegistration | null>;
  getRegistration(id: string): Promise<AgentAuthRegistration | null>;
  readClaim(
    claimTokenHash: string,
    now: number,
  ): Promise<AgentAuthRegistration | null>;
  createCeremony(input: {
    stateHash: string;
    registrationId: string;
    cookieHash: string;
    csrfHash: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<AgentAuthCeremony | null>;
  getCeremony(input: {
    stateHash: string;
    cookieHash: string;
    now: number;
  }): Promise<AgentAuthCeremony | null>;
  consumeOAuthState(input: {
    stateHash: string;
    cookieHash: string;
    now: number;
  }): Promise<AgentAuthCeremony | null>;
  finishOAuth(input: {
    stateHash: string;
    cookieHash: string;
    owner: AgentAuthOwner;
    now: number;
  }): Promise<AgentAuthCeremony | null>;
  consumeCeremony(input: {
    stateHash: string;
    cookieHash: string;
    csrfHash: string;
    userCodeHash: string;
    now: number;
  }): Promise<AgentAuthRegistration | null>;
  pollClaim(claimTokenHash: string, now: number): Promise<AgentAuthPollResult>;
  rotateClaim(input: {
    registrationId: string;
    claimTokenHash: string;
    nextClaimTokenHash: string;
    nextUserCodeHash: string;
    now: number;
  }): Promise<AgentAuthRegistration | null>;
  issueToken(input: {
    registrationId: string;
    issuedAt: number;
    assertionExpiresAt: number;
    tokenHash: string;
    resource?: string;
    now: number;
    expiresAt: number;
  }): Promise<boolean>;
  resolveToken(
    tokenHash: string,
    now: number,
  ): Promise<
    | (AgentAuthRegistration & { tokenExpiresAt: number; resource: string })
    | null
  >;
  revokeToken(tokenHash: string): Promise<void>;
  revokeRegistration(input: {
    registrationId: string;
    ownerId: string;
    now: number;
  }): Promise<boolean>;
}

export const AGENT_AUTH_TOKEN_RESOURCES: readonly string[] = [
  "https://api.metagraph.sh/mcp",
  "https://api.metagraph.sh/mcp/core",
];
export const AGENT_AUTH_DEFAULT_RESOURCE = AGENT_AUTH_TOKEN_RESOURCES[0]!;
export const AGENT_AUTH_ASSERTION_SECONDS = 3600;
export const AGENT_AUTH_POLL_SECONDS = 5;
export const AGENT_AUTH_MAX_POLLS = 120;
export const AGENT_AUTH_MAX_APPROVAL_ATTEMPTS = 5;

type RegistrationRow = Omit<AgentAuthRegistration, "permissions"> & {
  permissionsJson: string;
};
const registrationColumns = (prefix = "") =>
  `${prefix}id,${prefix}agent_name AS agentName,${prefix}email_hint AS emailHint,
  ${prefix}permissions AS permissionsJson,${prefix}claim_version AS claimVersion,
  ${prefix}created_at AS createdAt,${prefix}expires_at AS expiresAt,
  ${prefix}approved_at AS approvedAt,${prefix}owner_kind AS ownerKind,
  ${prefix}owner_id AS ownerId,${prefix}owner_email AS ownerEmail,
  ${prefix}revoked_at AS revokedAt`;
const ceremonyColumns = `state_hash AS stateHash,registration_id AS registrationId,
  claim_version AS claimVersion,created_at AS createdAt,expires_at AS expiresAt,
  oauth_consumed_at AS oauthConsumedAt,owner_kind AS ownerKind,owner_id AS ownerId,
  owner_email AS ownerEmail,attempts`;

function registration(
  row: RegistrationRow | null,
): AgentAuthRegistration | null {
  if (!row) return null;
  const { permissionsJson, ...rest } = row;
  return { ...rest, permissions: JSON.parse(permissionsJson) as string[] };
}

// Every ceremony operation rechecks the current registration version. Rotating
// a claim immediately invalidates browser states already in flight.
const activeCeremony = `consumed_by IS NULL AND expires_at>?
  AND EXISTS (SELECT 1 FROM agent_auth_registrations r
    WHERE r.id=agent_auth_ceremonies.registration_id
      AND r.claim_version=agent_auth_ceremonies.claim_version
      AND r.revoked_at IS NULL AND r.approved_at IS NULL AND r.expires_at>?)`;

export function createAgentAuthStore(
  db: D1Database | undefined,
): AgentAuthStore | null {
  if (!db) return null;
  const session =
    typeof db.withSession === "function" ? db.withSession("first-primary") : db;
  const getRegistration = async (id: string) =>
    registration(
      await session
        .prepare(
          `SELECT ${registrationColumns()} FROM agent_auth_registrations WHERE id=?`,
        )
        .bind(id)
        .first<RegistrationRow>(),
    );
  return {
    async ready() {
      try {
        for (const [table, columns] of [
          ["github_accounts", "id"],
          [
            "agent_auth_registrations",
            "id,agent_name,email_hint,permissions,claim_token_hash,user_code_hash,claim_version,created_at,expires_at,approved_at,owner_kind,owner_id,owner_email,revoked_at,poll_count,next_poll_at",
          ],
          [
            "agent_auth_ceremonies",
            "state_hash,registration_id,claim_version,cookie_hash,csrf_hash,created_at,expires_at,oauth_consumed_at,owner_kind,owner_id,owner_email,attempts,consumed_by",
          ],
          [
            "agent_auth_tokens",
            "token_hash,registration_id,claim_version,resource,created_at,expires_at",
          ],
        ]) {
          await session
            .prepare(`SELECT ${columns} FROM ${table} LIMIT 0`)
            .first();
        }
        return true;
      } catch {
        return false;
      }
    },
    async createRegistration(input) {
      return registration(
        await session
          .prepare(
            `INSERT INTO agent_auth_registrations
            (id,agent_name,email_hint,permissions,claim_token_hash,user_code_hash,created_at,expires_at)
            VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING
            RETURNING ${registrationColumns()}`,
          )
          .bind(
            input.id,
            input.agentName,
            input.emailHint.trim().toLowerCase(),
            JSON.stringify(input.permissions),
            input.claimTokenHash,
            input.userCodeHash,
            input.createdAt,
            input.expiresAt,
          )
          .first<RegistrationRow>(),
      );
    },
    getRegistration,
    async readClaim(claimTokenHash, now) {
      return registration(
        await session
          .prepare(
            `SELECT ${registrationColumns()} FROM agent_auth_registrations
          WHERE claim_token_hash=? AND revoked_at IS NULL AND approved_at IS NULL
            AND created_at<=? AND expires_at>?`,
          )
          .bind(claimTokenHash, now, now)
          .first<RegistrationRow>(),
      );
    },
    createCeremony(input) {
      return session
        .prepare(
          `INSERT INTO agent_auth_ceremonies
          (state_hash,registration_id,claim_version,cookie_hash,csrf_hash,created_at,expires_at)
          SELECT ?,r.id,r.claim_version,?,?,?,? FROM agent_auth_registrations r
          WHERE r.id=? AND r.revoked_at IS NULL AND r.approved_at IS NULL
            AND r.created_at<=? AND r.expires_at>? AND ?>? AND ?<=r.expires_at
          ON CONFLICT DO NOTHING RETURNING ${ceremonyColumns}`,
        )
        .bind(
          input.stateHash,
          input.cookieHash,
          input.csrfHash,
          input.createdAt,
          input.expiresAt,
          input.registrationId,
          input.createdAt,
          input.createdAt,
          input.expiresAt,
          input.createdAt,
          input.expiresAt,
        )
        .first<AgentAuthCeremony>();
    },
    getCeremony({ stateHash, cookieHash, now }) {
      return session
        .prepare(
          `SELECT ${ceremonyColumns} FROM agent_auth_ceremonies
          WHERE state_hash=? AND cookie_hash=? AND ${activeCeremony}`,
        )
        .bind(stateHash, cookieHash, now, now)
        .first<AgentAuthCeremony>();
    },
    consumeOAuthState({ stateHash, cookieHash, now }) {
      return session
        .prepare(
          `UPDATE agent_auth_ceremonies SET oauth_consumed_at=?
          WHERE state_hash=? AND cookie_hash=? AND oauth_consumed_at IS NULL
            AND ${activeCeremony} RETURNING ${ceremonyColumns}`,
        )
        .bind(now, stateHash, cookieHash, now, now)
        .first<AgentAuthCeremony>();
    },
    finishOAuth({ stateHash, cookieHash, owner, now }) {
      return session
        .prepare(
          `UPDATE agent_auth_ceremonies SET owner_kind=?,owner_id=?,owner_email=?
          WHERE state_hash=? AND cookie_hash=? AND oauth_consumed_at IS NOT NULL
            AND owner_kind IS NULL AND ?='github' AND ?<>''
            AND EXISTS (SELECT 1 FROM github_accounts g WHERE CAST(g.id AS TEXT)=?)
            AND EXISTS (SELECT 1 FROM agent_auth_registrations r
              WHERE r.id=agent_auth_ceremonies.registration_id AND r.email_hint=?)
            AND ${activeCeremony} RETURNING ${ceremonyColumns}`,
        )
        .bind(
          owner.kind,
          owner.id,
          owner.email.trim().toLowerCase(),
          stateHash,
          cookieHash,
          owner.kind,
          owner.id,
          owner.id,
          owner.email.trim().toLowerCase(),
          now,
          now,
        )
        .first<AgentAuthCeremony>();
    },
    async consumeCeremony({
      stateHash,
      cookieHash,
      csrfHash,
      userCodeHash,
      now,
    }) {
      const attempt = crypto.randomUUID();
      // D1 batch is a transaction. Only this attempt's marker can authorize the
      // second statement, so retries/replays cannot renew the approval horizon.
      const results = await session.batch([
        session
          .prepare(
            `UPDATE agent_auth_ceremonies SET attempts=attempts+1,
              consumed_by=CASE WHEN csrf_hash=? AND EXISTS (
                SELECT 1 FROM agent_auth_registrations r
                WHERE r.id=agent_auth_ceremonies.registration_id
                  AND r.user_code_hash=? AND r.email_hint=agent_auth_ceremonies.owner_email
              ) THEN ? ELSE NULL END
            WHERE state_hash=? AND cookie_hash=? AND owner_kind='github'
              AND owner_id IS NOT NULL AND oauth_consumed_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM github_accounts g
                WHERE CAST(g.id AS TEXT)=agent_auth_ceremonies.owner_id)
              AND attempts<? AND ${activeCeremony}`,
          )
          .bind(
            csrfHash,
            userCodeHash,
            attempt,
            stateHash,
            cookieHash,
            AGENT_AUTH_MAX_APPROVAL_ATTEMPTS,
            now,
            now,
          ),
        session
          .prepare(
            `UPDATE agent_auth_registrations SET approved_at=?,owner_kind='github',
              owner_id=(SELECT owner_id FROM agent_auth_ceremonies WHERE state_hash=?),
              owner_email=(SELECT owner_email FROM agent_auth_ceremonies WHERE state_hash=?)
            WHERE approved_at IS NULL AND revoked_at IS NULL AND expires_at>?
              AND EXISTS (SELECT 1 FROM agent_auth_ceremonies c
                WHERE c.registration_id=agent_auth_registrations.id
                  AND c.claim_version=agent_auth_registrations.claim_version
                  AND c.state_hash=? AND c.consumed_by=?)
            RETURNING ${registrationColumns()}`,
          )
          .bind(now, stateHash, stateHash, now, stateHash, attempt),
      ]);
      const rows = results[1]!.results as unknown as RegistrationRow[];
      return registration(rows[0] ?? null);
    },
    async pollClaim(claimTokenHash, now) {
      const row = await session
        .prepare(
          `UPDATE agent_auth_registrations SET poll_count=poll_count+1,next_poll_at=?
          WHERE claim_token_hash=? AND revoked_at IS NULL AND next_poll_at<=?
            AND poll_count<? AND ((approved_at IS NULL AND expires_at>?)
              OR (approved_at IS NOT NULL AND approved_at+?>?))
          RETURNING ${registrationColumns()}`,
        )
        .bind(
          now + AGENT_AUTH_POLL_SECONDS,
          claimTokenHash,
          now,
          AGENT_AUTH_MAX_POLLS,
          now,
          AGENT_AUTH_ASSERTION_SECONDS,
          now,
        )
        .first<RegistrationRow>();
      if (row) {
        const approved = registration(row)!;
        return row.approvedAt === null
          ? { status: "pending", registration: approved }
          : {
              status: "approved",
              registration: approved,
              issuedAt: row.approvedAt,
              assertionExpiresAt: row.approvedAt + AGENT_AUTH_ASSERTION_SECONDS,
            };
      }
      const current = await session
        .prepare(
          `SELECT revoked_at,approved_at,expires_at,poll_count,next_poll_at
          FROM agent_auth_registrations WHERE claim_token_hash=?`,
        )
        .bind(claimTokenHash)
        .first<{
          revoked_at: number | null;
          approved_at: number | null;
          expires_at: number;
          poll_count: number;
          next_poll_at: number;
        }>();
      if (!current) return { status: "missing" };
      if (current.revoked_at !== null) return { status: "revoked" };
      const expires =
        current.approved_at === null
          ? current.expires_at
          : current.approved_at + AGENT_AUTH_ASSERTION_SECONDS;
      if (expires <= now || current.poll_count >= AGENT_AUTH_MAX_POLLS)
        return { status: "expired" };
      return {
        status: "rate_limited",
        retryAfter: Math.max(1, current.next_poll_at - now),
      };
    },
    async rotateClaim(input) {
      return registration(
        await session
          .prepare(
            `UPDATE agent_auth_registrations SET claim_token_hash=?,user_code_hash=?,
          claim_version=claim_version+1,poll_count=0,next_poll_at=?
          WHERE id=? AND claim_token_hash=? AND revoked_at IS NULL
            AND ((approved_at IS NULL AND expires_at>?)
              OR (approved_at IS NOT NULL AND approved_at+?>?))
          RETURNING ${registrationColumns()}`,
          )
          .bind(
            input.nextClaimTokenHash,
            input.nextUserCodeHash,
            input.now,
            input.registrationId,
            input.claimTokenHash,
            input.now,
            AGENT_AUTH_ASSERTION_SECONDS,
            input.now,
          )
          .first<RegistrationRow>(),
      );
    },
    async issueToken(input) {
      const resource =
        input.resource === undefined
          ? AGENT_AUTH_DEFAULT_RESOURCE
          : input.resource;
      if (!AGENT_AUTH_TOKEN_RESOURCES.includes(resource)) return false;
      const issued = await session
        .prepare(
          `INSERT INTO agent_auth_tokens
          (token_hash,registration_id,claim_version,resource,created_at,expires_at)
          SELECT ?,id,claim_version,?,?,? FROM agent_auth_registrations
          WHERE id=? AND revoked_at IS NULL AND owner_kind='github'
            AND EXISTS (SELECT 1 FROM github_accounts g
              WHERE CAST(g.id AS TEXT)=agent_auth_registrations.owner_id)
            AND approved_at=? AND approved_at+?=? AND approved_at<=?
            AND ?<? AND ?>? AND ?<=? AND ?<=?+?
          ON CONFLICT DO NOTHING RETURNING token_hash`,
        )
        .bind(
          input.tokenHash,
          resource,
          input.now,
          input.expiresAt,
          input.registrationId,
          input.issuedAt,
          AGENT_AUTH_ASSERTION_SECONDS,
          input.assertionExpiresAt,
          input.now,
          input.now,
          input.assertionExpiresAt,
          input.expiresAt,
          input.now,
          input.expiresAt,
          input.assertionExpiresAt,
          input.expiresAt,
          input.now,
          AGENT_AUTH_ASSERTION_SECONDS,
        )
        .first<{ token_hash: string }>();
      return issued !== null;
    },
    async resolveToken(tokenHash, now) {
      const row = await session
        .prepare(
          `SELECT ${registrationColumns("r.")},t.expires_at AS tokenExpiresAt,t.resource
          FROM agent_auth_tokens t JOIN agent_auth_registrations r
            ON r.id=t.registration_id AND r.claim_version=t.claim_version
          JOIN github_accounts g ON CAST(g.id AS TEXT)=r.owner_id
          WHERE t.token_hash=? AND t.created_at<=? AND t.expires_at>?
            AND r.revoked_at IS NULL AND r.owner_kind='github'
            AND r.approved_at<=? AND r.approved_at+?>?`,
        )
        .bind(tokenHash, now, now, now, AGENT_AUTH_ASSERTION_SECONDS, now)
        .first<
          RegistrationRow & { tokenExpiresAt: number; resource: string }
        >();
      if (!row) return null;
      const { tokenExpiresAt, resource, ...registered } = row;
      return { ...registration(registered)!, tokenExpiresAt, resource };
    },
    async revokeToken(tokenHash) {
      await session
        .prepare(
          `DELETE FROM agent_auth_tokens WHERE token_hash=? RETURNING token_hash`,
        )
        .bind(tokenHash)
        .first<{ token_hash: string }>();
    },
    async revokeRegistration({ registrationId, ownerId, now }) {
      const revoked = await session
        .prepare(
          `UPDATE agent_auth_registrations SET revoked_at=?
          WHERE id=? AND owner_kind='github' AND owner_id=? AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM github_accounts g
              WHERE CAST(g.id AS TEXT)=agent_auth_registrations.owner_id)
          RETURNING id`,
        )
        .bind(now, registrationId, ownerId)
        .first<{ id: string }>();
      return revoked !== null;
    },
  };
}
