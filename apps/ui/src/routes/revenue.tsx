import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { RevenuePage } from "./-revenue-page";

// Sort/filter state lives in the URL so a specific view ("the probe-derived
// subnets, by subsidy multiple") is shareable — the same reason /chain/emissions
// puts its own sort there.
const revenueSearchSchema = z.object({
  sort: fallback(
    z.enum(["subsidy_multiple", "coverage_ratio", "emission_usd", "revenue_usd", "netuid"]),
    "subsidy_multiple",
  ).default("subsidy_multiple"),
  dir: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
  // Empty means every tier, which is the default: the counts beside each tier
  // are how a reader learns the headline-eligible set is two subnets wide, and
  // defaulting to a filtered view would hide exactly that.
  provenance: fallback(z.string(), "").default(""),
});

export type RevenueSearch = z.infer<typeof revenueSearchSchema>;

const DESCRIPTION =
  "What every Bittensor subnet earns from outside the network, against the TAO the network emits to it. Only chain-verified and probe-derived readings reach the ratio; subnets with no observable external revenue are listed separately rather than ranked as zero.";

export const Route = createFileRoute("/revenue")({
  validateSearch: zodValidator(revenueSearchSchema),
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
