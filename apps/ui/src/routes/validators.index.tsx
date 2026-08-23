import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { ValidatorsPage } from "./-validators-index-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

/**
 * Three keys: the search and the two filters the operator table offers.
 *
 * The `grouped` toggle went with the flat ranking (#11616) -- the page's unit
 * is the operator now, and a hotkey is a child row rather than a peer, so a
 * control that ungrouped them would be offering a view the page no longer
 * has. `sort`/`order`/`watched` went with the table that read them;
 * `validateSearch` REPLACES the search object, so an unread key is dropped on
 * the next parse rather than sitting inert.
 */
export const validatorsSearchSchema = z.object({
  q: z.string().catch("").default(""),
  minStake: z.number().catch(0).default(0),
  named: z.boolean().catch(false).default(false),
});

export type ValidatorsSearch = z.infer<typeof validatorsSearchSchema>;

export const Route = createFileRoute("/validators/")({
  validateSearch: validatorsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(validatorsSearchSchema)] },
  head: () => ({ meta: hubMeta("/validators") }),
  component: ValidatorsPage,
});
