import { createFileRoute } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";
import { RevenuePage } from "./-revenue-page";
import { COVERAGE_SORT_FIELDS } from "@/lib/metagraphed/coverage-leaderboard-model";

// Sort/filter state lives in the URL so a specific view ("the probe-derived
// subnets, by revenue") is shareable — the same reason /chain/emissions puts
// its own sort there.
//
// #10927: the default is `revenue_usd`, not `subsidy_multiple`. `isMeasured`
// partitions on `revenue_usd`, so it is the one column non-null for every row
// in the ranked group BY CONSTRUCTION. `subsidy_multiple` is a derived ratio
// needing both a revenue figure and a priced emission side, so a subnet that
// was measured but whose emission failed to price sorts to the BOTTOM of a
// table it legitimately belongs in — ranked last on a column it cannot answer.
const revenueSearchSchema = z.object({
  sort: z.enum(COVERAGE_SORT_FIELDS).catch("revenue_usd").default("revenue_usd"),
  dir: z.enum(["asc", "desc"]).catch("desc").default("desc"),
  // Empty means every tier, which is the default: the counts beside each tier
  // are how a reader learns the headline-eligible set is two subnets wide, and
  // defaulting to a filtered view would hide exactly that.
  provenance: z.string().catch("").default(""),
});

export type RevenueSearch = z.infer<typeof revenueSearchSchema>;

const DESCRIPTION =
  "What every Bittensor subnet earns from outside the network, against the TAO the network emits to it. Only chain-verified and probe-derived readings reach the ratio; subnets with no observable external revenue are listed separately rather than ranked as zero.";

export const Route = createFileRoute("/revenue")({
  validateSearch: revenueSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(revenueSearchSchema)] },
  head: () => ({
    meta: [
      { title: "Revenue coverage — Metagraphed" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Revenue coverage — Metagraphed" },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: RevenuePage,
});
