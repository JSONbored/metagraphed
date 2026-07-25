import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { SudoPage } from "./-sudo-index-page";

const sudoSearchSchema = z.object({
  limit: fallback(z.number().int().min(1).max(100), 50).default(50),
  offset: fallback(z.number().int().min(0), 0).default(0),
  call_function: fallback(z.string(), "").default(""),
  success: fallback(z.enum(["", "true", "false"]), "").default(""),
});

export type SudoSearch = z.infer<typeof sudoSearchSchema>;

export const Route = createFileRoute("/sudo/")({
  validateSearch: zodValidator(sudoSearchSchema),
  head: () => ({
    meta: [
      { title: "Sudo — Metagraphed" },
      {
        name: "description",
        content:
          "Root-origin (Sudo) calls on the Bittensor chain and the account currently holding the Sudo key.",
      },
      { property: "og:title", content: "Sudo — Metagraphed" },
      {
        property: "og:description",
        content:
          "Root-origin (Sudo) calls on the Bittensor chain and the account currently holding the Sudo key.",
      },
    ],
  }),
  component: SudoPage,
});
