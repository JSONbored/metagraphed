import { createFileRoute } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";
import { ChainEmissionsPage } from "./-chain-emissions-page";
import { EMISSION_SORT_KEYS } from "@/lib/metagraphed/emission-pipeline";

// Filter/sort state lives in the URL so a specific view of the decomposition
// ("the subnets the gate took the most from") is shareable — the same reason
// /chain/governance puts its `view` toggle there.
const emissionsSearchSchema = z.object({
  state: z.enum(["all", "eligible", "disabled", "ineligible"]).catch("all").default("all"),
  sort: z.enum(EMISSION_SORT_KEYS).catch("final_share").default("final_share"),
  dir: z.enum(["asc", "desc"]).catch("desc").default("desc"),
  limit: z.number().int().min(1).max(200).catch(50).default(50),
  netuid: z.string().catch("").default(""),
});

export type EmissionsSearch = z.infer<typeof emissionsSearchSchema>;

const DESCRIPTION =
  "Where each block's TAO goes: every Bittensor subnet's emission share decomposed from price share through the miner-burn weighting and the gate, plus the split between pool liquidity injection and chain buys.";

export const Route = createFileRoute("/chain/emissions")({
  validateSearch: emissionsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(emissionsSearchSchema)] },
  head: () => ({
    meta: [
      { title: "Emissions — Metagraphed" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Emissions — Metagraphed" },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: ChainEmissionsPage,
});
