// GET /api/v1/subnets/{netuid}/alpha-dividends (#13163; #13161, epic #13142).
// One subnet's pending alpha dividend accrual, served live from
// app.subnet_alpha_dividends (migration 0045) through the native store seam.
// The table's writers -- the engine's AlphaDividendsPerSubnet /
// RootAlphaDividendsPerSubnet decode -- land separately, so until a store is
// bound and filled this route serves the schema-stable decline below, never a
// fabricated zero-dividend subnet.
import { z } from "zod";

export const SubnetAlphaDividendSchema = z
  .object({
    hotkey: z
      .string()
      .describe("The hotkey this pending dividend accrual belongs to."),
    alpha_divs: z
      .string()
      .nullable()
      .describe(
        "Pending alpha dividends for this hotkey on this subnet, from SubtensorModule.AlphaDividendsPerSubnet -- u64 alpha atomic units as a decimal string. Null when the chain carried no value for it at capture time, never fabricated as 0.",
      ),
    root_alpha_divs: z
      .string()
      .nullable()
      .describe(
        "Pending root alpha dividends for this hotkey on this subnet, from SubtensorModule.RootAlphaDividendsPerSubnet -- u64 alpha atomic units as a decimal string. Null when not captured.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One hotkey's pending alpha dividend accrual on a subnet: the alpha and root-alpha amounts with their capture stamp.",
  );

export const SubnetAlphaDividendsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible. An empty
     * accrual registry is never a measured "no pending dividends" -- it is
     * what an unbound or unfilled store looks like (the engine dependency
     * #13163 defers), and publishing it as a count would be the
     * confident-zero failure the sibling mechanism surface's own comments
     * are about.
     */
    hotkey_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many hotkeys carry a pending accrual row here -- `dividends.length`. NULL when the registry holds no rows for this subnet (store unbound, or the accrual capture has not run): a zero count is never a measurement and is not published.",
      ),
    captured_at: z.string().nullable(),
    dividends: z
      .array(SubnetAlphaDividendSchema)
      .describe(
        "The subnet's pending dividend accruals, largest alpha_divs first.",
      ),
  })
  .strict()
  .describe(
    "One subnet's pending alpha dividend accrual (#13163). Empty with a null hotkey_count until the engine's dividend capture lands. Mirrors GET /api/v1/subnets/{netuid}/alpha-dividends.",
  );
