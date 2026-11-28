// GET /api/v1/gamma/deposits (#13164; #13161, epic #13142). The chain's
// Gamma deposit state, served live from app.gamma_deposits (migration 0047)
// through the native store seam. The burn tick's Gamma capture
// (src/chain-gamma-capture.ts) fills it from SubtensorModule.GammaDeposits,
// so until a store is bound and a capture observed this route serves the
// schema-stable decline below, never a fabricated deposit-free chain.
import { z } from "zod";

export const GammaDepositSchema = z
  .object({
    coldkey: z
      .string()
      .describe(
        "The ss58 address the deposit is keyed by on chain -- its owning account.",
      ),
    hotkey: z.string().describe("The hotkey this deposit is bound to."),
    netuid: z.int().min(0).max(65535),
    balance: z
      .string()
      .describe(
        "The deposit's Gamma balance -- u64 atomic units as a decimal string.",
      ),
    spender: z
      .string()
      .nullable()
      .describe(
        "The account authorized to spend from this deposit (event GammaDepositSpenderSet). Null when no spender is set.",
      ),
    daily_cap: z
      .string()
      .nullable()
      .describe(
        "The deposit's daily spend ceiling (event GammaDepositDailySpendCapSet) -- u64 atomic units as a decimal string. Null when no cap is set, never fabricated as 0 (which would claim a measured zero ceiling).",
      ),
    closed_at: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The block this deposit was closed at (event GammaDepositClosed). Null while the deposit is open -- never fabricated as 0, which would claim closure at genesis.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One Gamma deposit: the owning account and hotkey it is keyed by, the subnet, its balance, the spend controls, and the capture stamp.",
  );

export const GammaDepositsArtifactSchema = z
  .object({
    schema_version: z.int(),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible. An empty
     * deposit list is never a measured "no deposits" -- it is what an
     * unbound or unfilled store looks like (the engine dependency #13164
     * defers), and publishing it as a count would be the confident-zero
     * failure the sibling chain surfaces' own comments are about.
     */
    deposit_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many deposits this answer carries -- `deposits.length`. NULL when the state holds no rows (store unbound, or the deposit capture has not run): a zero count is never a measurement and is not published.",
      ),
    captured_at: z.string().nullable(),
    deposits: z
      .array(GammaDepositSchema)
      .describe("The chain's Gamma deposits, largest balance first."),
  })
  .strict()
  .describe(
    "The chain's Gamma deposit state (#13164). Empty with a null deposit_count until a deposit capture is observed. Mirrors GET /api/v1/gamma/deposits.",
  );
