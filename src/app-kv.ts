import type { AppKv, AppKvEnv, OAuthPendingEnv } from "./app-kv-types.ts";
export type { AppKv, AppKvEnv, OAuthPendingEnv } from "./app-kv-types.ts";

export function appKv(
  env: AppKvEnv | null | undefined,
): Partial<AppKv> | undefined {
  return env && "CONTROL_KV_STORE" in env
    ? nativeKv(env.CONTROL_KV_STORE)
    : env?.METAGRAPH_CONTROL;
}

/** Select only application pending state; provider grant storage has its own owner. */
export function oauthPendingKv(env: OAuthPendingEnv): AppKv | undefined {
  return "OAUTH_PENDING_STORE" in env
    ? nativeKv(env.OAUTH_PENDING_STORE)
    : env.OAUTH_KV;
}

function nativeKv(value: AppKv | undefined): AppKv {
  if (
    !value ||
    [value.get, value.put, value.delete, value.list, value.consume].some(
      (method) => typeof method !== "function",
    )
  ) {
    throw new TypeError("Native KV capability is incomplete");
  }
  return value;
}

export async function consumeKvText(
  kv: Pick<AppKv, "get" | "delete" | "consume">,
  key: string,
): Promise<string | null> {
  if (kv.consume) return kv.consume(key);
  const value = await kv.get(key);
  if (value !== null) await kv.delete(key);
  return value;
}
