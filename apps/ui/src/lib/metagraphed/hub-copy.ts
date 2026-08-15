/**
 * The <title> and <meta name="description"> for every hub page, in one place.
 *
 * #11320. Two reasons this is a module and not eight pairs of constants in
 * eight route files.
 *
 * **Drift.** Every route below had its copy written inline, and two of the
 * eight had already gone wrong by the time this was written: `/apis` emitted
 * `title: "API catalog — Metagraphed"` alongside `og:title: "Surfaces —
 * Metagraphed"`, so the browser tab and the link unfurl named the same page
 * differently; `/validators` carried two DIFFERENT description strings, a long
 * one for `meta` and a short one for `og:description`. Neither is a typo — it
 * is what happens when one page's copy lives in four string literals. Here,
 * one entry feeds all four tags.
 *
 * **The gate.** `indexable-routes.spec.ts` asserts the budgets below against
 * the rendered HTML, and it iterates THIS map rather than a hand-written list
 * of paths. A hub added without an entry fails; an entry added without a route
 * fails. Every gate in this repo that listed its own subjects has since gone
 * blind to something (#11288's `ALLOW_GENERIC`, #11234's tag list), so the
 * subject list has to be the data itself.
 *
 * Dependency-free like identity.ts: imported by route `head()` (which runs in
 * the Worker) and by the e2e spec (which runs in Node).
 */
import { SUBNET_SLOT_CAP } from "./bittensor";

/**
 * Google truncates a title around 60 characters and a description around 160.
 * Exported so the gate asserts the same numbers the copy was written against
 * rather than a second opinion about them.
 */
export const HUB_TITLE_MAX = 60;
export const HUB_DESCRIPTION_MAX = 160;

export interface HubCopy {
  readonly title: string;
  readonly description: string;
}

/**
 * Brand goes LAST in every title.
 *
 * Leading with a name nobody searches spends the highest-weighted characters
 * in the tag on nothing: measured 2026-08-15, a brand search for this project
 * returns the Bittensor SDK's `bt.metagraph` docs and not us. The terms a
 * stranger types come first; the brand rides at the end where it still builds
 * recognition without costing a query term.
 */
const BRAND = " · Metagraphed";

/** Every hub page's copy. Keys are the pathnames the router serves. */
export const HUB_COPY = {
  "/": {
    title: `Bittensor subnet registry & block explorer${BRAND}`,
    description:
      "Unofficial registry and block explorer for Bittensor — subnet APIs, schemas, docs, endpoints, providers, health, plus live blocks, extrinsics, and events.",
  },
  "/subnets": {
    // SUBNET_SLOT_CAP, not a literal and not a fetch: the count is capped by
    // the protocol, so a registration changes which project holds a netuid,
    // never how many exist. 128 rather than 129 because root (netuid 0) is
    // governance, not a subnet anyone browsing this list means — a title
    // claiming 129 would disagree with the rows beneath it.
    title: `All ${SUBNET_SLOT_CAP} Bittensor subnets — live API health${BRAND}`,
    description:
      `All ${SUBNET_SLOT_CAP} Bittensor subnets, plus root: which expose a public API, whether it ` +
      "answered our last probe, and the endpoints and economics behind each.",
  },
  "/validators": {
    title: `Bittensor validators — stake & performance${BRAND}`,
    description:
      "Every Bittensor validator ranked by stake across all subnets — take, estimated APY, " +
      "nominators and dominance, computed live from the chain-direct metagraph.",
  },
  "/apis": {
    title: `Bittensor subnet APIs — live health & docs${BRAND}`,
    description:
      "Every public interface a Bittensor subnet exposes — APIs, docs, dashboards, repos and " +
      "SDKs — each probed every 15 minutes so you know what actually answers.",
  },
  "/apis/providers": {
    title: `Bittensor API providers — endpoints & uptime${BRAND}`,
    description:
      "Every team and infrastructure provider behind a Bittensor subnet surface — the endpoints " +
      "they run and whether those answered our last probe.",
  },
  "/apis/endpoints": {
    title: `Bittensor RPC endpoints — health & latency${BRAND}`,
    description:
      "Public Subtensor RPC and WSS endpoints for Bittensor, with live status, measured latency " +
      "and pool eligibility — probe-derived, never self-reported.",
  },
  "/apis/schemas": {
    title: `Bittensor API schemas — machine-readable${BRAND}`,
    description:
      "Machine-readable schemas for every catalogued Bittensor subnet API — OpenAPI, contracts, " +
      "the schema index, and drift against the previous snapshot.",
  },
  "/chain": {
    // "block explorer" is the phrase that competes with taostats, so it leads.
    // "events" over "extrinsics" because the tag had two characters spare and
    // more people search it — extrinsics stays in the description.
    title: `Bittensor block explorer — blocks & events${BRAND}`,
    description:
      "The Bittensor chain at a glance — blocks, extrinsics, events, daily activity, fees and " +
      "call mix, computed live from the chain-direct tiers.",
  },
} as const satisfies Record<string, HubCopy>;

export type HubPath = keyof typeof HUB_COPY;

/**
 * The four `<meta>` tags a hub emits, built from one entry.
 *
 * Returning them together is the point: the two failures this module was
 * written for were both a page whose `title` and `og:title`, or `description`
 * and `og:description`, had been allowed to say different things.
 */
export function hubMeta(path: HubPath) {
  const { title, description } = HUB_COPY[path];
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
  ];
}
