import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AdminChangesPage } from "./-admin-changes-index-page";

const adminChangesSearchSchema = z.object({
  limit: fallback(z.number().int().min(1).max(100), 50).default(50),
  offset: fallback(z.number().int().min(0), 0).default(0),
  call_function: fallback(z.string(), "").default(""),
  success: fallback(z.enum(["", "true", "false"]), "").default(""),
});

export type AdminChangesSearch = z.infer<typeof adminChangesSearchSchema>;

export const Route = createFileRoute("/admin-changes/")({
  validateSearch: zodValidator(adminChangesSearchSchema),
  head: () => ({
    meta: [
      { title: "Admin changes — Metagraphed" },
      {
        name: "description",
        content:
          "AdminUtils root-origin config changes — subtensor's hyperparameter and network-config admin pathway, newest first.",
      },
      { property: "og:title", content: "Admin changes — Metagraphed" },
      {
        property: "og:description",
        content:
          "AdminUtils root-origin config changes — subtensor's hyperparameter and network-config admin pathway, newest first.",
      },
    ],
  }),
  component: AdminChangesPage,
});
