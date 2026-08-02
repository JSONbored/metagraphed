import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ChainEmissionsPage } from "./-chain-emissions-page";

// Filter/sort state lives in the URL so a specific view of the decomposition
// ("the subnets the gate took the most from") is shareable — the same reason
// /chain/governance puts its `view` toggle there.
const emissionsSearchSchema = z.object({
  state: fallback(z.enum(["all", "eligible", "disabled", "ineligible"]), "all").default("all"),
  sort: fallback(
    z.enum([
      "final_share",
      "emission_share",
      "gate_delta",
      "tao_total",
      "liquidity_fraction",
      "netuid",
    ]),
    "final_share",
  ).default("final_share"),
  dir: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
  limit: fallback(z.number().int().min(1).max(200), 50).default(50),
  netuid: fallback(z.string(), "").default(""),
});

export type EmissionsSearch = z.infer<typeof emissionsSearchSchema>;

const DESCRIPTION =
  "Where each block's TAO goes: every Bittensor subnet's emission share decomposed from price share through the miner-burn weighting and the gate, plus the split between pool liquidity injection and chain buys.";

export const Route = createFileRoute("/chain/emissions")({
  validateSearch: zodValidator(emissionsSearchSchema),
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
