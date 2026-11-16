// GET /api/v1/accounts/{ss58}/locks (#13163; #13161, epic #13142). One
// coldkey's conviction-lock state, served live from app.stake_locks
// (migration 0045) through the native store seam. The table's writers -- the
// engine's SubtensorModule.Lock / HotkeyLock / DecayingLock / OwnerLock
// decode -- land separately, so until a store is bound and filled this route
// serves the schema-stable decline below, never a fabricated lock-free
// account.
import { z } from "zod";

export const StakeLockSchema = z
  .object({
    hotkey: z.string().describe("The hotkey this lock binds."),
    netuid: z.int().min(0).max(65535),
    kind: z
      .string()
      .describe(
        "The lock variant, spelled as the chain's storage item spells it (Lock / HotkeyLock / DecayingLock / OwnerLock and their decaying variants) -- not pinned to an enum the runtime still extends.",
      ),
    amount: z
      .string()
      .describe("The locked quantity -- u64 atomic units as a decimal string."),
    maturity_block: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The block at which this lock matures. Null for a lock without a maturity (perpetual, or a variant that does not carry one) -- never fabricated as 0, which would claim maturity at genesis.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One conviction lock of an account: the hotkey and subnet it binds, its variant, the locked amount, its maturity and the capture stamp.",
  );

export const AccountLocksArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible. An empty
     * lock list is never a measured "no locks" -- it is what an unbound or
     * unfilled store looks like (the engine dependency #13163 defers), and
     * publishing it as a count would be the confident-zero failure the
     * sibling subnet surfaces' own comments are about.
     */
    lock_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many locks this account holds here -- `locks.length`. NULL when the state holds no rows for this account (store unbound, or the lock capture has not run): a zero count is never a measurement and is not published.",
      ),
    captured_at: z.string().nullable(),
    locks: z
      .array(StakeLockSchema)
      .describe("The account's locks, ordered by (netuid, hotkey, kind)."),
  })
  .strict()
  .describe(
    "One account's conviction-lock state (#13163). Empty with a null lock_count until the engine's lock capture lands. Mirrors GET /api/v1/accounts/{ss58}/locks.",
  );
