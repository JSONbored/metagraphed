import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ValidatorsPage } from "./-validators-index-page";

// #8251: sort is a plain string (client-side sortBy over the full fetched
// set) rather than the API's enum -- the page now fetches EVERY validator in
// one request and sorts locally, so any numeric row field is sortable,
// including take/apy_estimate/nominator_count that the API's own ?sort=
// never supported.
export type ValidatorsSearch = z.infer<typeof validatorsSearchSchema>;

export const validatorsSearchSchema = z.object({
  q: fallback(z.string(), "").default(""),
  // #8256: "Watched" quick filter, matching the /subnets index convention.
  // A search param (not component state) so a filtered view is shareable and
  // survives a reload.
  watched: fallback(z.boolean(), false).default(false),
  // Cluster an operator's keys adjacent under its best-ranked row, so a team
  // running several validators (Ventura Labs, Yuma, …) reads as one entry
  // with a ×N chip instead of the same name repeated at every rank. On by
  // default; the toggle exists for anyone who wants the raw flat ranking.
  grouped: fallback(z.boolean(), true).default(true),
  sort: fallback(z.string(), "total_stake_tao").default("total_stake_tao"),
  // #5344: bring Validators up to the canonical ranked-list interaction model
  // (Subnets) — a sort DIRECTION toggled by clicking a column header, and a row
  // density control — instead of a bare, single-direction <select>.
  order: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
  density: fallback(z.enum(["compact", "comfortable"]), "comfortable").default("comfortable"),
});

export const Route = createFileRoute("/validators/")({
  validateSearch: zodValidator(validatorsSearchSchema),
  search: { middlewares: [stripDefaultSearchParams(validatorsSearchSchema)] },
  head: () => ({
    meta: [
      { title: "Validators — Metagraphed" },
      {
        name: "description",
        content:
          "Network-wide Bittensor validator directory — hotkeys ranked across subnets, with active-subnet and UID counts, computed live from the chain-direct metagraph.",
      },
      { property: "og:title", content: "Validators — Metagraphed" },
      {
        property: "og:description",
        content: "Network-wide Bittensor validator directory across all subnets.",
      },
    ],
  }),
  component: ValidatorsPage,
});
