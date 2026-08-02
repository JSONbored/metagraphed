// Session-bound surface-credential store (#9009). Moves auth_required
// subnet-surface secrets out of call_subnet_surface's tool arguments: an
// AUTHENTICATED caller registers a credential once (store_surface_credential)
// and later call_subnet_surface invocations resolve it from here instead of
// carrying it in-band -- where it would land in client logs, conversation
// transcripts, and (but for redactMcpSensitiveFields) $mcp_parameters.
//
// Identity: both authentication paths ADR 0027 accepts on /mcp resolve to the
// same rpc_accounts id -- a verified mg_ key via the tiered rate-limit gate
// (workers/tiered-rate-limit.ts hands it back as `accountId`), and an OAuth
// bearer via @cloudflare/workers-oauth-provider's ctx.props.accountId
// (src/github-oauth.ts sets it at completeAuthorization). So the store keys
// uniformly on `account:<id>` and never needs to know which door the caller
// came through. Anonymous callers have no identity to bind to and keep the
// in-band `credential` argument (ADR 0027 Model B -- anonymous reach must not
// shrink as a side effect of this cleanup).
//
// Storage: METAGRAPH_CONTROL KV, value encrypted with AES-256-GCM under a
// key derived (SHA-256) from the MCP_SURFACE_CREDENTIAL_SECRET worker secret.
// KV is already the trust boundary for API-key lookup cache entries
// (src/api-key-validation.ts), but those are one-way hashes; these are
// recoverable third-party secrets, so they get real encryption: a leaked KV
// snapshot without the worker secret yields nothing. Non-secret listing
// metadata (shape, timestamps) rides in KV metadata so list_surface_credentials
// never has to decrypt anything.
//
// Unlike the fail-open convention of the limiter bindings, this store fails
// CLOSED: unset secret or missing KV means "store unavailable", surfaced to
// the caller as a typed tool error -- silently degrading to plaintext (or to
// pretending a credential was stored) would be worse than refusing.

export const SURFACE_CREDENTIAL_KV_PREFIX = "mcp-surface-credential:";

// 30 days: long enough that an agent configured once keeps working across
// sessions, short enough that an abandoned registration ages out on its own.
// Callers can shorten or lengthen per registration (KV's own 60s floor, 90d
// ceiling) via ttl_seconds.
export const SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS = 2_592_000;
export const SURFACE_CREDENTIAL_MIN_TTL_SECONDS = 60;
export const SURFACE_CREDENTIAL_MAX_TTL_SECONDS = 7_776_000;

const ENCRYPTION_ALGORITHM = "AES-GCM";
const IV_BYTES = 12;

/** A credential in either shape call_subnet_surface accepts: one opaque
 * string (bearer/api-key/basic) or a {name: value} bundle (signature). */
export type StoredSurfaceCredential = string | Record<string, string>;

export interface SurfaceCredentialMetadata {
  surface_id: string;
  shape: "string" | "object";
  created_at: string;
  expires_at: string;
}

interface CredentialEnvelope {
  v: 1;
  iv: string;
  data: string;
}

/** Minimal KV surface this module needs -- matches KVNamespace, kept loose so
 * tests can inject a Map-backed fake without the full binding type. */
export interface SurfaceCredentialKv {
  get?: (key: string, options?: { type?: string }) => Promise<unknown>;
  put?: (
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ) => Promise<void>;
  delete?: (key: string) => Promise<void>;
  list?: (options?: { prefix?: string; cursor?: string }) => Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface SurfaceCredentialEnv {
  METAGRAPH_CONTROL?: SurfaceCredentialKv;
  MCP_SURFACE_CREDENTIAL_SECRET?: string;
}

/** A deployment where both halves of the store are present. Produced only by
 * the type predicate below, so every function that actually touches KV takes
 * this type and needs no defensive re-check of its own. */
export interface ConfiguredSurfaceCredentialEnv {
  METAGRAPH_CONTROL: Required<SurfaceCredentialKv>;
  MCP_SURFACE_CREDENTIAL_SECRET: string;
}

/** True when both halves of the store (the KV binding and the encryption
 * secret) are provisioned. Anything less and every operation refuses -- this
 * store never degrades to plaintext or to a silent no-op. A KV binding either
 * carries its whole method set or is not one, so the binding's presence is
 * checked, not each method. */
export function isSurfaceCredentialStoreConfigured(
  env: SurfaceCredentialEnv | null | undefined,
): env is ConfiguredSurfaceCredentialEnv {
  return Boolean(env?.METAGRAPH_CONTROL && env?.MCP_SURFACE_CREDENTIAL_SECRET);
}

/**
 * The caller's store identity, or null for anonymous callers. Prefers the
 * rate-limit gate's mg_-key accountId (present on every keyed request),
 * falling back to the OAuth provider's props.accountId -- both are the same
 * rpc_accounts id, namespaced here so a future second identity system can
 * coexist without key collisions.
 */
export function resolveSurfaceCredentialIdentity(ctx: {
  accountId?: string | null;
  executionCtx?: { props?: { accountId?: unknown } };
}): string | null {
  const candidate = ctx.accountId ?? ctx.executionCtx?.props?.accountId ?? null;
  if (candidate === null || candidate === undefined) return null;
  const id = String(candidate).trim();
  // Account ids are opaque here, but they become KV-key segments: reject
  // anything empty or containing the key delimiter so one identity can never
  // alias another's prefix.
  if (!id || id.includes(":")) return null;
  return `account:${id}`;
}

function credentialKvKey(identity: string, surfaceId: string): string {
  return `${SURFACE_CREDENTIAL_KV_PREFIX}${identity}:${surfaceId}`;
}

async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: ENCRYPTION_ALGORITHM },
    false,
    ["encrypt", "decrypt"],
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encryptCredential(
  secret: string,
  credential: StoredSurfaceCredential,
): Promise<CredentialEnvelope> {
  const key = await deriveEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(credential));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ENCRYPTION_ALGORITHM, iv },
    key,
    plaintext,
  );
  return {
    v: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptCredential(
  secret: string,
  envelope: CredentialEnvelope,
): Promise<StoredSurfaceCredential | null> {
  try {
    const key = await deriveEncryptionKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: ENCRYPTION_ALGORITHM, iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.data),
    );
    return JSON.parse(
      new TextDecoder().decode(plaintext),
    ) as StoredSurfaceCredential;
  } catch {
    // Undecryptable means the secret rotated (or the envelope is corrupt).
    // Either way the record is unusable -- callers treat null as "nothing
    // stored" and re-register.
    return null;
  }
}

/** Clamp a caller-supplied TTL to the KV floor / policy ceiling; undefined
 * takes the 30-day default. */
export function clampSurfaceCredentialTtl(ttlSeconds?: number): number {
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds)) {
    return SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS;
  }
  return Math.min(
    Math.max(Math.round(ttlSeconds), SURFACE_CREDENTIAL_MIN_TTL_SECONDS),
    SURFACE_CREDENTIAL_MAX_TTL_SECONDS,
  );
}

export interface StoreSurfaceCredentialResult {
  expiresAt: string;
  replaced: boolean;
}

/**
 * Encrypt and persist one credential for (identity, surface). Returns the
 * expiry and whether an existing registration was overwritten.
 */
export async function storeSurfaceCredential(
  env: ConfiguredSurfaceCredentialEnv,
  identity: string,
  surfaceId: string,
  credential: StoredSurfaceCredential,
  ttlSeconds?: number,
): Promise<StoreSurfaceCredentialResult> {
  const kv = env.METAGRAPH_CONTROL;
  const secret = env.MCP_SURFACE_CREDENTIAL_SECRET;
  const key = credentialKvKey(identity, surfaceId);
  const existing = await kv.get(key, { type: "json" });
  const ttl = clampSurfaceCredentialTtl(ttlSeconds);
  const now = Date.now();
  const expiresAt = new Date(now + ttl * 1000).toISOString();
  const metadata: SurfaceCredentialMetadata = {
    surface_id: surfaceId,
    shape: typeof credential === "string" ? "string" : "object",
    created_at: new Date(now).toISOString(),
    expires_at: expiresAt,
  };
  const envelope = await encryptCredential(secret, credential);
  await kv.put(key, JSON.stringify(envelope), {
    expirationTtl: ttl,
    metadata,
  });
  return { expiresAt, replaced: existing !== null && existing !== undefined };
}

/**
 * Resolve the stored credential for (identity, surface), or null when none
 * is registered, the envelope is unreadable, or the store is unconfigured --
 * the caller cannot distinguish these on purpose: every null means "behave
 * as if nothing was stored".
 */
export async function loadSurfaceCredential(
  env: SurfaceCredentialEnv | null | undefined,
  identity: string,
  surfaceId: string,
): Promise<StoredSurfaceCredential | null> {
  if (!isSurfaceCredentialStoreConfigured(env)) return null;
  const kv = env.METAGRAPH_CONTROL;
  const secret = env.MCP_SURFACE_CREDENTIAL_SECRET;
  let envelope: unknown;
  try {
    envelope = await kv.get(credentialKvKey(identity, surfaceId), {
      type: "json",
    });
  } catch {
    // KV read failure is non-fatal: the call degrades to "no stored
    // credential", the same experience as an expired registration.
    return null;
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    (envelope as CredentialEnvelope).v !== 1 ||
    typeof (envelope as CredentialEnvelope).iv !== "string" ||
    typeof (envelope as CredentialEnvelope).data !== "string"
  ) {
    return null;
  }
  return decryptCredential(secret, envelope as CredentialEnvelope);
}

/** List (identity)'s registrations from KV metadata alone -- no decryption,
 * no secret values in the result. */
export async function listSurfaceCredentials(
  env: ConfiguredSurfaceCredentialEnv,
  identity: string,
): Promise<SurfaceCredentialMetadata[]> {
  const kv = env.METAGRAPH_CONTROL;
  const prefix = `${SURFACE_CREDENTIAL_KV_PREFIX}${identity}:`;
  const results: SurfaceCredentialMetadata[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const entry of page.keys) {
      const meta = entry.metadata as SurfaceCredentialMetadata | undefined;
      results.push({
        surface_id:
          typeof meta?.surface_id === "string"
            ? meta.surface_id
            : entry.name.slice(prefix.length),
        shape: meta?.shape === "object" ? "object" : "string",
        created_at: typeof meta?.created_at === "string" ? meta.created_at : "",
        expires_at: typeof meta?.expires_at === "string" ? meta.expires_at : "",
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return results;
}

/** Delete one registration. Returns whether anything was there to delete. */
export async function deleteSurfaceCredential(
  env: ConfiguredSurfaceCredentialEnv,
  identity: string,
  surfaceId: string,
): Promise<boolean> {
  const kv = env.METAGRAPH_CONTROL;
  const key = credentialKvKey(identity, surfaceId);
  const existing = await kv.get(key, { type: "json" });
  if (existing === null || existing === undefined) return false;
  await kv.delete(key);
  return true;
}
