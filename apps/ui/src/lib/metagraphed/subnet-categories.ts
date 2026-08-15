/**
 * The category pages: "which Bittensor subnets do X" (#11342).
 *
 * The registry computes `derived_categories` on every subnet and surfaced them
 * nowhere — `/subnets` linked zero categories. We published 129 pages for
 * *"what is subnet 64"* and nothing for the query shape sitting directly above
 * it, which is the one a person types before they know a netuid.
 *
 * **Why these URLs and not the 129 per-subnet analysis pages (#11317).** The
 * rule is not count. It is whether a URL answers a query nothing else of ours
 * already answers:
 *
 *   /blocks/{hash} x1,557   nobody types a block hash          -> collapsed
 *   /subnets/{n}/analysis   a SECOND page for a query          -> cannibalization
 *                           /subnets/{n} already ranks 4-8 for
 *   /subnets/category/{x}   a query we answer with nothing     -> this
 *
 * The copy below is written per category rather than templated. A family of
 * pages that differ only by a substituted noun is thin by nature however many
 * words it counts, which is the property that put 5,797 URLs in "Crawled –
 * currently not indexed".
 */

/**
 * A category needs this many subnets to get a page.
 *
 * Below it, the page is a near-duplicate of the one subnet it lists — and
 * `storage` currently has exactly one. Enforced against live data at render
 * time, so a category that grows past the bar starts appearing and one that
 * falls below it stops, with no code change.
 */
export const MIN_CATEGORY_SUBNETS = 3;

export interface CategoryCopy {
  /** Human label, as a heading and in the title. */
  readonly label: string;
  /** What the category means, in the page's own words. */
  readonly summary: string;
  /** Why someone browsing this category is here, and what to compare on. */
  readonly guidance: string;
}

/**
 * Copy for every category the registry derives.
 *
 * Keyed by the `derived_categories` value. A category present in the data but
 * missing here still renders — with a generic summary — rather than 404ing:
 * the registry deriving a new category is not a reason to break a URL, and the
 * gap shows up as flat copy that someone will notice and fill.
 */
export const CATEGORY_COPY: Record<string, CategoryCopy> = {
  inference: {
    label: "Inference",
    summary:
      "Subnets whose miners serve model output on demand — text, embeddings, classification or scoring — and whose validators grade that output rather than the hardware behind it.",
    guidance:
      "The thing to compare here is not raw capacity but what the validator actually rewards: a subnet scoring answer quality and one scoring latency produce very different miner behaviour, and the API you end up calling reflects whichever it is. Check whether a specification exists before you plan an integration around it.",
  },
  agents: {
    label: "Agents",
    summary:
      "Subnets where the unit of work is a task completed rather than a response returned — code written, a trajectory planned, a workflow executed — usually with a longer feedback loop than an inference call.",
    guidance:
      "Agent subnets tend to publish fewer synchronous endpoints and more artifacts, so the useful signal is often the source repository and the evaluation method rather than an uptime figure. Read what the validator scores; it tells you more about what the subnet produces than any description does.",
  },
  compute: {
    label: "Compute",
    summary:
      "Subnets renting or brokering machine time — GPUs, containers, verifiable execution — where the product is capacity rather than a model's output.",
    guidance:
      "These are the subnets where an endpoint being reachable matters most, because you are buying availability. Probe history is the honest signal: a broker that answers consistently is worth more than one advertising a larger fleet it cannot keep online.",
  },
  finance: {
    label: "Finance",
    summary:
      "Subnets producing financial signal — market data, liquidity provision, trading strategy, portfolio analytics — priced and scored on chain.",
    guidance:
      "Treat everything here as a data source and not as advice, including the scores. What is worth comparing is provenance: whether the subnet publishes how a number was derived, and whether that derivation is something you can re-run rather than take on faith.",
  },
  prediction: {
    label: "Prediction",
    summary:
      "Subnets forecasting a future value — prices, weather, events — where miners are scored against outcomes that eventually resolve.",
    guidance:
      "The resolution rule is the whole product. Two prediction subnets with identical accuracy claims can be scoring against different horizons or different oracles, so the interesting comparison is what counts as being right and who decides.",
  },
  data: {
    label: "Data",
    summary:
      "Subnets collecting, cleaning or labelling data — scraped corpora, street imagery, structured claims — where the output is a dataset rather than a live answer.",
    guidance:
      "Data subnets are the ones most likely to publish an artifact you can download rather than an endpoint you call, so check the distribution format before assuming an API. Freshness matters more than uptime here: a dataset that stopped updating is still reachable.",
  },
  science: {
    label: "Science",
    summary:
      "Subnets applying the network to research problems — drug discovery, climate modelling, protein work — where the reward function encodes a scientific objective.",
    guidance:
      "These have the longest feedback loops on the network and the most domain-specific outputs, so a generic health check tells you least. The source repository and the published methodology are usually the only way to tell what a result means.",
  },
  media: {
    label: "Media",
    summary:
      "Subnets generating or processing images, video, audio and 3D — where miners produce media assets and validators score them for fidelity or usefulness.",
    guidance:
      "Output format and licensing are the practical questions, and they are rarely in the health data. Where a subnet publishes a specification, it will usually tell you the resolution, the modality and the constraints faster than its documentation does.",
  },
  robotics: {
    label: "Robotics",
    summary:
      "Subnets working on embodied intelligence — control policies, simulation, swarm coordination — where the eventual consumer is hardware rather than software.",
    guidance:
      "The smallest and newest category on the network, so expect fewer published interfaces and more source repositories. Read the repo activity rather than the endpoint count.",
  },
  security: {
    label: "Security",
    summary:
      "Subnets doing adversarial work — vulnerability discovery, red-teaming, integrity checking — where the miner's job is to break something and the validator's is to confirm it stayed broken.",
    guidance:
      "Security subnets publish less about their method than others do, deliberately. Judge them on what is verifiable: whether the scoring is reproducible, and whether the surfaces they do publish answer when probed.",
  },
  search: {
    label: "Search",
    summary: "Subnets retrieving and ranking information across the open web and on-chain sources.",
    guidance:
      "Compare on what corpus is actually searched and how recently it was refreshed — retrieval quality is mostly a function of index freshness.",
  },
  privacy: {
    label: "Privacy",
    summary:
      "Subnets running computation under confidentiality guarantees — trusted execution, private inference, encrypted data handling.",
    guidance:
      "The guarantee is the product, so the thing to check is what is actually attested and by whom, rather than what the description claims.",
  },
  storage: {
    label: "Storage",
    summary: "Subnets providing decentralised storage and retrieval.",
    guidance:
      "Durability claims are only as good as the retrieval path, so probe history matters more than advertised capacity.",
  },
};

/** URL segment for a category. The derived value is already slug-shaped. */
export function categoryPath(slug: string): string {
  return `/subnets/category/${slug}`;
}

/** Copy for a category, generic rather than absent when the registry adds one. */
export function categoryCopy(slug: string): CategoryCopy {
  return (
    CATEGORY_COPY[slug] ?? {
      label: slug.charAt(0).toUpperCase() + slug.slice(1),
      summary: `Bittensor subnets the registry classifies under ${slug}, with the interfaces each publishes and whether those answered our last probe.`,
      guidance:
        "Compare on what each subnet actually publishes: a machine-readable specification, a reachable endpoint, and a probe history you can check rather than a claim you have to take.",
    }
  );
}
