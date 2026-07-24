import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ValidatorsPage } from "./-validators-index-page";

// The full GlobalValidatorSort set the /api/v1/validators endpoint accepts.
// Stake / emission / dominance / trust get their own columns in #3359; this
// baseline page only renders hotkey identity + subnet/UID counts (#3360 adds the
// dedicated active-subnet column), but every sort key stays selectable.
const validatorSortKeys = [
  "subnet_count",
  "uid_count",
  "stake_dominance",
  "total_stake",
  "total_emission",
  "avg_validator_trust",
  "max_validator_trust",
] as const;

const validatorsSearchSchema = z.object({
  sort: fallback(z.enum(validatorSortKeys), "subnet_count").default("subnet_count"),
  // #5344: bring Validators up to the canonical ranked-list interaction model
  // (Subnets) — a sort DIRECTION toggled by clicking a column header, and a row
  // density control — instead of a bare, single-direction <select>.
  order: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
  density: fallback(z.enum(["compact", "comfortable"]), "comfortable").default("comfortable"),
});

export const Route = createFileRoute("/validators/")({
  validateSearch: zodValidator(validatorsSearchSchema),
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
