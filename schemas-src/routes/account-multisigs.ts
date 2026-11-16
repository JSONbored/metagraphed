// GET /api/v1/accounts/{ss58}/multisigs (#13166; #13161, epic #13142). Every
// multisig an account belongs to, served live from app.multisigs (migration
// 0055) through the native store seam. The Multisig pallet's own storage
// keys OPEN OPERATIONS by (multisig, call hash); a multisig account's
// composition -- its signatory set and threshold -- is derivable only from
// the as_multi call decode, which is the writer the engine lands separately.
// Until then this route serves the schema-stable decline below, never a
// fabricated multisig-free account.
import { z } from "zod";

export const AccountMultisigSchema = z
  .object({
    multisig: z.string().describe("The multisig account itself (ss58)."),
    threshold: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many signatory approvals the multisig requires. Null when the capture has not resolved the composition.",
      ),
    signatories: z
      .array(z.string())
      .nullable()
      .describe(
        "The signatory set behind the multisig account, as resolved from the call decode. Null when the capture has not resolved it -- never an empty list, which would claim a measured signatory-less multisig.",
      ),
    signatory_count: z
      .int()
      .min(1)
      .nullable()
      .describe("`signatories.length`, null exactly when signatories is null."),
    role: z
      .enum(["multisig", "signatory"])
      .describe(
        "Which side of the membership matched: the queried account IS this multisig account, or it signs for it.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One multisig an account belongs to: the multisig account, its resolved composition and the capture stamp.",
  );

export const AccountMultisigsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    /** NULL IS THE DECLINE -- same reasoning as proxy_count's. */
    multisig_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many multisigs this account belongs to here -- `multisigs.length`. NULL when the state holds no rows for this account (store unbound, or the multisig capture has not run): a zero count is never a measurement and is not published.",
      ),
    captured_at: z.string().nullable(),
    multisigs: z
      .array(AccountMultisigSchema)
      .describe(
        "The multisigs the account belongs to -- as the multisig account itself or as a signatory -- ordered by multisig address, store-capped.",
      ),
  })
  .strict()
  .describe(
    "One account's Multisig-pallet membership (#13166). Empty with a null multisig_count until the engine's multisig capture lands. Mirrors GET /api/v1/accounts/{ss58}/multisigs.",
  );
