// GET /api/v1/accounts/{ss58}/proxies (#13166; #13161, epic #13142). One
// account's Proxy-pallet delegation state, served live from app.proxies
// (migration 0055) through the native store seam. The table's writer -- the
// engine's Proxy.Proxies decode -- lands separately, so until a store is
// bound and filled this route serves the schema-stable decline below, never
// a fabricated delegation-free account.
import { z } from "zod";

export const AccountProxySchema = z
  .object({
    delegate: z.string().describe("The account the delegation runs to (ss58)."),
    proxy_type: z
      .string()
      .describe(
        "The proxy variant, spelled as the chain's enum spells it (Any / Owner / Staking / Registration ... GammaSpend) -- not pinned to an enum the runtime still extends (23 variants on v490).",
      ),
    delay: z
      .int()
      .min(0)
      .describe(
        "The announcement delay in blocks before this proxy's calls execute. 0 is the chain's own value for an undelayed proxy, read from storage -- not a fabricated default.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One proxy definition of an account: the delegate it runs to, its variant, its announcement delay and the capture stamp.",
  );

export const AccountProxiesArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible. An empty
     * proxy list is never a measured "no proxies" -- it is what an unbound
     * or unfilled store looks like (the engine dependency #13166 defers),
     * and publishing it as a count would be the confident-zero failure the
     * sibling account surfaces' own comments are about.
     */
    proxy_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many proxy definitions this account holds -- `proxies.length`. NULL when the state holds no rows for this account (store unbound, or the proxy capture has not run): a zero count is never a measurement and is not published.",
      ),
    deposit: z
      .string()
      .nullable()
      .describe(
        "The account-level reserve held against its proxy vector (u64 atomic units as a decimal string, stored once per delegating account). Null when the capture did not carry it.",
      ),
    captured_at: z.string().nullable(),
    proxies: z
      .array(AccountProxySchema)
      .describe(
        "The account's proxy definitions, ordered by (delegate, proxy_type, delay).",
      ),
  })
  .strict()
  .describe(
    "One account's Proxy-pallet delegation state (#13166). Empty with a null proxy_count until the engine's proxy capture lands. Mirrors GET /api/v1/accounts/{ss58}/proxies.",
  );
