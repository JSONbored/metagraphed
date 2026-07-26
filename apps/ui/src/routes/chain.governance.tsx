import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ChainGovernancePage } from "./-chain-governance-page";

// /sudo and /admin-changes shipped BYTE-IDENTICAL search schemas, which is part
// of why they merge cleanly (#8291). The only addition is `view`, the source
// toggle — in the URL so either half stays shareable.
const governanceSearchSchema = z.object({
  view: fallback(z.enum(["sudo", "admin"]), "sudo").default("sudo"),
  limit: fallback(z.number().int().min(1).max(100), 50).default(50),
  offset: fallback(z.number().int().min(0), 0).default(0),
  call_function: fallback(z.string(), "").default(""),
  success: fallback(z.enum(["", "true", "false"]), "").default(""),
});

export type GovernanceSearch = z.infer<typeof governanceSearchSchema>;

export const Route = createFileRoute("/chain/governance")({
  validateSearch: zodValidator(governanceSearchSchema),
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
