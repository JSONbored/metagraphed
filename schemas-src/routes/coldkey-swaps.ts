// GET /api/v1/accounts/pending-coldkey-swaps + /api/v1/accounts/{ss58}/
// coldkey-swap (#13166; #13161, epic #13142). The v2 announce-then-execute
// coldkey-swap state and the key successor lineage, served live from
// app.coldkey_swap_announcements / app.coldkey_swap_policy /
// app.key_successors (migration 0053) through the native store seam. The
// tables' writers -- the engine's SubtensorModule.ColdkeySwapAnnouncements /
// ColdkeySwapDisputes / ColdkeySwapReservedDestination /
// ColdkeySwapV2PolicySnapshots / ColdkeySwapAnnouncementDelay /
// ColdkeySwapReannouncementDelay decode and the HotkeySuccessor / HotkeyRoot
// / ColdkeySuccessor / ColdkeyRoot lineage decode -- land separately, so
// until a store is bound and filled these routes serve the schema-stable
// decline below, never a fabricated swap-free chain.
import { z } from "zod";

export const ColdkeySwapAnnouncementSchema = z
  .object({
    coldkey: z.string().describe("The announcing account (ss58)."),
    new_coldkey: z
      .string()
      .nullable()
      .describe(
        "The reserved destination account (ss58), in cleartext from SubtensorModule.ColdkeySwapReservedDestination. Null when the capture carried no reservation.",
      ),
    announcement_hash: z
      .string()
      .nullable()
      .describe(
        "The H256 commitment stored beside the execute block, 0x-prefixed lowercase hex. Null when not carried.",
      ),
    announced_at: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The block the announcement landed, engine-derived from the ColdkeySwapAnnounced event. Null when not carried -- never fabricated as 0, which would claim an announcement at genesis.",
      ),
    execute_at: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The block the swap can be performed (the u32 in SubtensorModule.ColdkeySwapAnnouncements). Null when not carried.",
      ),
    disputed: z
      .boolean()
      .nullable()
      .describe(
        "The dispute state from SubtensorModule.ColdkeySwapDisputes: true when disputed; false when root cleared the dispute but retained the record (the chain's 0); null when the capture carried no dispute record.",
      ),
    disputed_at: z
      .int()
      .min(0)
      .nullable()
      .describe("The dispute block itself when one is recorded, else null."),
    policy_snapshot: z
      .boolean()
      .nullable()
      .describe(
        "The announcement-time decision from SubtensorModule.ColdkeySwapV2PolicySnapshots on importing the source auto-stake policy. Null when the capture carried no snapshot.",
      ),
    status: z
      .string()
      .nullable()
      .describe(
        "The lifecycle state as the engine spells it -- text, not pinned to an enum the runtime still extends. Null when not carried.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One in-flight v2 coldkey-swap announcement: the announcing account and its reserved destination with the commitment hash, the announce/execute/dispute blocks, the policy snapshot and the capture stamp.",
  );

export const ColdkeySwapPolicySchema = z
  .object({
    announcement_delay: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "SubtensorModule.ColdkeySwapAnnouncementDelay: blocks after an announcement before the swap can be performed. Null when the capture did not carry it.",
      ),
    reannouncement_delay: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "SubtensorModule.ColdkeySwapReannouncementDelay: blocks after the initial delay before a new announcement can be made. Null when the capture did not carry it.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "The chain-wide v2 coldkey-swap delays at the newest capture -- how long an announcement must age before execution, and before it can be replaced.",
  );

export const PendingColdkeySwapsArtifactSchema = z
  .object({
    schema_version: z.int(),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible. An empty
     * swap list is never a measured "no swaps pending" -- it is what an
     * unbound or unfilled store looks like (the engine dependency #13166
     * defers), and publishing it as a count would be the confident-zero
     * failure the sibling account surfaces' own comments are about.
     */
    swap_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many in-flight announcements the capture holds -- `swaps.length`. NULL when the state holds no rows (store unbound, or the swap capture has not run): a zero count is never a measurement and is not published.",
      ),
    captured_at: z.string().nullable(),
    policy: ColdkeySwapPolicySchema.nullable().describe(
      "The chain-wide delays at the newest capture, null until the policy capture lands.",
    ),
    swaps: z
      .array(ColdkeySwapAnnouncementSchema)
      .describe(
        "The in-flight announcements, soonest-executable first (the chain map holds at most one per announcing account).",
      ),
  })
  .strict()
  .describe(
    "Every in-flight v2 coldkey-swap announcement on the chain (#13166). Empty with a null swap_count until the engine's swap capture lands. Mirrors GET /api/v1/accounts/pending-coldkey-swaps.",
  );

export const ColdkeyLineageSchema = z
  .object({
    successor: z
      .string()
      .nullable()
      .describe(
        "SubtensorModule.ColdkeySuccessor: the account this one swapped into. Null when the account is the newest in its lineage.",
      ),
    root: z
      .string()
      .nullable()
      .describe(
        "SubtensorModule.ColdkeyRoot: the first account in this swap lineage. Null when the account is its own root (never swapped into).",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "The account's global coldkey swap lineage: written on each successful swap so watchers can follow owner identity without walking history.",
  );

export const HotkeyLineageEntrySchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    successor: z
      .string()
      .nullable()
      .describe(
        "SubtensorModule.HotkeySuccessor for (netuid, hotkey): the hotkey this one swapped into on the subnet. Null when the hotkey is the newest in its lineage there.",
      ),
    root: z
      .string()
      .nullable()
      .describe(
        "SubtensorModule.HotkeyRoot for (netuid, hotkey): the first hotkey in the subnet's swap lineage. Null when the hotkey is its own root there.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One subnet's hotkey swap lineage for the account: written on each successful hotkey swap on that subnet.",
  );

export const AccountKeyLineageSchema = z
  .object({
    coldkey: ColdkeyLineageSchema.nullable().describe(
      "The global coldkey-swap lineage, null when the capture holds none for this account.",
    ),
    hotkey: z
      .array(HotkeyLineageEntrySchema)
      .describe("The per-subnet hotkey lineage rows, ordered by netuid."),
    /** NULL IS THE DECLINE -- same reasoning as swap_count above. */
    hotkey_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many per-subnet hotkey lineage rows the capture holds -- `hotkey.length`. NULL when there are none (store unbound, or the lineage capture has not run): a zero count is never a measurement and is not published.",
      ),
  })
  .strict()
  .describe(
    "The account's key successor lineage across both key planes (#13166): the global coldkey-swap lineage and the per-subnet hotkey-swap lineage.",
  );

export const AccountColdkeySwapArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    announcement: ColdkeySwapAnnouncementSchema.nullable().describe(
      "The account's in-flight v2 swap announcement. Null when the capture holds none -- not announced, or the swap capture has not run.",
    ),
    lineage: AccountKeyLineageSchema,
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One account's v2 coldkey-swap state and key successor lineage (#13166). Every block declines to null (and hotkey_count stays null over an empty list) until the engine's swap and lineage captures land. Mirrors GET /api/v1/accounts/{ss58}/coldkey-swap.",
  );
