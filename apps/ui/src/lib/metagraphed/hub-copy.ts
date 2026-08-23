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

/** One titled block of prose. Rendered through ui-kit's `SectionHeading`. */
export interface HubSection {
  readonly heading: string;
  readonly body: string;
}

export interface HubCopy {
  readonly title: string;
  readonly description: string;
  /**
   * The prose a hub needs to be eligible for the informational query, split by
   * where it sits relative to the table.
   *
   * `lede` goes ABOVE the table and is deliberately short. The requirement was
   * "150–250 words of intro prose above the table", and writing it that way
   * would have pushed the table off a phone — mobile-first indexing means the
   * layout Google evaluates is the narrow one. So the lede answers the query in
   * a sentence or two and the rest sits below, where a reader who scrolled past
   * the data is the one who wants it. Same word count, no buried table.
   *
   * `sections` are the remainder. Together with the lede they give every hub
   * the three headings a scannable page needs — `/validators` measured ZERO
   * before this, `/subnets` and `/apis` one each.
   */
  readonly intro: {
    readonly lede: HubSection;
    readonly sections: readonly HubSection[];
  };
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
    intro: {
      lede: {
        heading: "What Metagraphed is",
        body: `An independent registry and block explorer for Bittensor: what each of the ${SUBNET_SLOT_CAP} subnets publishes, whether those endpoints actually answer, and the chain activity underneath. Every health figure here is probe-derived — measured on a 15-minute cycle, never self-reported by the team that owns the surface.`,
      },
      sections: [
        {
          heading: "Why a registry and not just an explorer",
          body: "Chain explorers show state: stake, emission, blocks. They cannot tell you whether a subnet's API is reachable, what schema it speaks, or where its documentation lives — that is application-layer information, and it lives off-chain. Metagraphed catalogues it, verifies it against the operator's own sources, and serves the result as JSON, GraphQL, MCP tools and CSV as well as these pages.",
        },
        {
          heading: "What you can rely on",
          body: "Identity comes from on-chain metadata and operator-published sources; health comes from our own probes; anything we could not verify is marked rather than guessed. Absence is stated explicitly instead of rendered as a zero, because a missing measurement and a measurement of nothing are different facts.",
        },
      ],
    },
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
    intro: {
      lede: {
        heading: "Every Bittensor subnet, and what it actually exposes",
        body: `Bittensor caps the network at ${SUBNET_SLOT_CAP} application subnets plus root (netuid 0), each an independent market where miners compete on one task and validators score them. This page lists all of them with the interfaces they publish and whether those interfaces answered our last probe.`,
      },
      sections: [
        {
          heading: "What a subnet is",
          body: "A subnet is a self-contained incentive mechanism running on the Bittensor chain. Miners produce work, validators score it, and emission is distributed by the resulting consensus. The netuid identifies the slot, not the project: slots are competitive, so the team occupying netuid 38 today may not be the one occupying it next quarter. That is why every record here is dated.",
        },
        {
          heading: "How the health figures are produced",
          body: "Every registered surface is probed on a 15-minute cycle and the outcome is recorded as-is. Uptime, latency and incident history are derived from those probes alone — no operator can set them, and neither can we. A subnet with no public interface is shown as having none rather than being quietly omitted.",
        },
      ],
    },
  },
  "/validators": {
    title: `Bittensor validators — stake & performance${BRAND}`,
    description:
      "Every Bittensor validator ranked by stake across all subnets — take, estimated APY, " +
      "nominators and dominance, computed live from the chain-direct metagraph.",
    intro: {
      lede: {
        heading: "Every Bittensor validator, ranked by stake",
        body: "Validators score miners' work and set the weights that route emission. This directory ranks every hotkey validating on any subnet, with the stake behind it, the commission it takes and the yield that implies — computed live from the chain-direct metagraph.",
      },
      sections: [
        {
          heading: "Stake, take and yield",
          body: "Stake is the validator's own TAO plus everything delegated to it, and it decides how much its votes weigh. Take is the commission kept from delegator rewards. Estimated APY annualises the latest emission-over-stake rate net of take — a description of the recent past, not a forecast, and on alpha stake it is price-exposed, so a positive nominal figure can still lose TAO.",
        },
        {
          heading: "Reading concentration",
          body: "Dominance is a validator's share of total network stake. It is worth reading alongside the subnet count: a large operator concentrates influence over consensus, a smaller one spreads it. This directory describes the on-chain data and deliberately does not rank or recommend any validator.",
        },
      ],
    },
  },
  "/apis": {
    title: `Bittensor subnet APIs — live health & docs${BRAND}`,
    description:
      "Every public interface a Bittensor subnet exposes — APIs, docs, dashboards, repos and " +
      "SDKs — each probed every 15 minutes so you know what actually answers.",
    intro: {
      lede: {
        heading: "Every public interface a Bittensor subnet exposes",
        body: "APIs, OpenAPI documents, dashboards, source repositories, SDKs and data artifacts — catalogued per subnet, each traced to the operator's own source, and each probed every 15 minutes so the status shown is measured rather than claimed.",
      },
      sections: [
        {
          heading: "How a surface gets here",
          body: "A surface is registered only with a public URL plus a second, independent source that proves the subnet actually publishes it — an official repository, the operator's own site, or on-chain identity. Anything registry-observed rather than operator-declared is labelled as such, so first-party facts are never mixed with harvested links.",
        },
        {
          heading: "Calling one",
          body: "Where a subnet publishes a machine-readable schema we serve it alongside the endpoint, so an agent can go from discovery to a typed request without leaving the registry. The same catalogue is available as REST, GraphQL and MCP tools for callers that would rather not scrape a page.",
        },
      ],
    },
  },
  "/apis/providers": {
    title: `Bittensor API providers — endpoints & uptime${BRAND}`,
    description:
      "Every team and infrastructure provider behind a Bittensor subnet surface — the endpoints " +
      "they run and whether those answered our last probe.",
    intro: {
      lede: {
        heading: "The teams and infrastructure behind the surfaces",
        body: "Providers are the operators running what this registry catalogues — subnet teams, RPC and API hosts, documentation registries. Each entry lists the endpoints attributed to it and how those endpoints have behaved under probing.",
      },
      sections: [
        {
          heading: "Why providers are tracked separately",
          body: "One operator often runs surfaces for several subnets, and one subnet often depends on several operators. Modelling them separately is what makes it possible to see that an outage spans four subnets because they share a host, rather than reading it as four unrelated incidents.",
        },
        {
          heading: "Attribution rules",
          body: "A provider is attached to a surface only where the operator declares it or a first-party source shows it. Where ownership is unclear the surface stays unattributed rather than being assigned on a guess, because a wrong attribution is a claim about somebody's business.",
        },
        {
          heading: "Reading an uptime figure",
          body: "Uptime here is the share of our probes that got a usable answer over the window, not an operator's SLA. A provider running one endpoint that has never failed and a provider running forty with one flapping host can show similar percentages, so the endpoint count beside it is part of the reading.",
        },
      ],
    },
  },
  "/apis/endpoints": {
    title: `Bittensor RPC endpoints — health & latency${BRAND}`,
    description:
      "Public Subtensor RPC and WSS endpoints for Bittensor, with live status, measured latency " +
      "and pool eligibility — probe-derived, never self-reported.",
    intro: {
      lede: {
        heading: "Public Bittensor RPC and WSS endpoints",
        body: "The Subtensor endpoints this registry knows about, with live status, measured latency and whether each is currently eligible for the load-balanced pool. Every figure is probe-derived.",
      },
      sections: [
        {
          heading: "How pool eligibility is decided",
          body: "An endpoint enters the pool on sustained health, not on a single successful check, and leaves it on sustained failure. That hysteresis is deliberate: routing traffic to an endpoint that answered once is how a flapping host becomes everyone's outage.",
        },
        {
          heading: "Latency is measured, not advertised",
          body: "Times shown are round trips from our probes, so they describe the endpoint under real conditions rather than an operator's benchmark. Compare them as relative signals; absolute values depend on where the probe runs.",
        },
      ],
    },
  },
  "/apis/schemas": {
    title: `Bittensor API schemas — machine-readable${BRAND}`,
    description:
      "Machine-readable schemas for every catalogued Bittensor subnet API — OpenAPI, contracts, " +
      "the schema index, and drift against the previous snapshot.",
    intro: {
      lede: {
        heading: "Machine-readable schemas for Bittensor subnet APIs",
        body: "OpenAPI documents, the schema index, the published contracts and the drift between the current snapshot and the previous one — everything an agent or a generated client needs to call a subnet without reading prose.",
      },
      sections: [
        {
          heading: "Why drift is published",
          body: "A schema that changes silently breaks every generated client built against it. Each snapshot is diffed against its predecessor and the difference is served as a first-class record, so a consumer can see a breaking change as a fact rather than discovering it as an exception in production.",
        },
        {
          heading: "What a schema here guarantees",
          body: "That the document was fetched from the operator's own source at the timestamp shown, not that it is correct. Where a published schema disagrees with the endpoint's actual behaviour, the disagreement is the finding — and the probe record is what settles it.",
        },
      ],
    },
  },
  "/chain": {
    // "block explorer" is the phrase that competes with taostats, so it leads.
    // "events" over "extrinsics" because the tag had two characters spare and
    // more people search it — extrinsics stays in the description.
    title: `Bittensor block explorer — blocks & events${BRAND}`,
    description:
      "The Bittensor chain at a glance — blocks, extrinsics, events, daily activity, fees and " +
      "call mix, computed live from the chain-direct tiers.",
    intro: {
      lede: {
        heading: "The Bittensor chain at a glance",
        body: "Blocks, extrinsics and events as they are produced, plus the daily rollups underneath: activity, fees, call mix and the accounts moving the most. Computed live from the chain-direct tiers rather than a cached summary.",
      },
      sections: [
        {
          heading: "Blocks, extrinsics and events",
          body: "A block is a batch of state transitions. An extrinsic is a call submitted to the chain — a transfer, a registration, a weight update. Events are what the runtime emitted while executing them, which is where the outcome of a call actually shows up. Most questions about what happened are event questions.",
        },
        {
          heading: "Depth and freshness",
          body: "Recent chain state is served hot; deep history is served from the lakehouse and can answer more slowly for a wide range. Where a query reaches past the warm window the response says so explicitly rather than returning a truncated result that looks complete.",
        },
      ],
    },
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
