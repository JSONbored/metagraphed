import { createFileRoute } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";
import { ChainGovernancePage } from "./-chain-governance-page";

// /sudo and /admin-changes shipped BYTE-IDENTICAL search schemas, which is part
// of why they merge cleanly (#8291). The only addition is `view`, the source
// toggle — in the URL so either half stays shareable.
const governanceSearchSchema = z.object({
  view: z.enum(["sudo", "admin"]).catch("sudo").default("sudo"),
  limit: z.number().int().min(1).max(100).catch(50).default(50),
  offset: z.number().int().min(0).catch(0).default(0),
  call_function: z.string().catch("").default(""),
  success: z.enum(["", "true", "false"]).catch("").default(""),
});

export type GovernanceSearch = z.infer<typeof governanceSearchSchema>;

export const Route = createFileRoute("/chain/governance")({
  validateSearch: governanceSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(governanceSearchSchema)] },
  head: () => ({
    meta: [
      { title: "Governance — Metagraphed" },
      {
        name: "description",
        content:
          "Root-origin activity on the Bittensor chain: Sudo calls and AdminUtils config changes for subnet hyperparameters and network config.",
      },
      { property: "og:title", content: "Governance — Metagraphed" },
      {
        property: "og:description",
        content:
          "Root-origin activity on the Bittensor chain: Sudo calls and AdminUtils config changes for subnet hyperparameters and network config.",
      },
    ],
  }),
  component: ChainGovernancePage,
});
