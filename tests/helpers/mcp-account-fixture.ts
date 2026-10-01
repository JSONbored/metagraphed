import { authLookupCacheWrite } from "../../src/auth-lookup-cache.ts";
import { mockEnv, type Row } from "../row-type.ts";

// Model the account context already validated by the OAuth provider. The
// ordinary tier gate still resolves its cached entitlement; no auth bypass.
export const mcpAccountContext = { waitUntil() {}, props: { accountId: 7 } };

export function withMcpAccount(env: Row): Env {
  const kv = env.METAGRAPH_CONTROL;
  return mockEnv({
    ...env,
    METAGRAPH_CONTROL: {
      ...kv,
      async get(key: string, options: Row) {
        if (key === "oauth-account-tier:v2:7")
          return JSON.parse(
            authLookupCacheWrite(
              { found: true, tier: "free" },
              { positiveTtlSeconds: 300, negativeTtlSeconds: 30 },
            ).value,
          );
        return kv?.get ? kv.get(key, options) : null;
      },
    },
  });
}
