import { isoTimestamp } from "./freshness";
import { API_ORIGIN, GITHUB_REPO_URL, SITE_ORIGIN, X_PROFILE_URL } from "./identity";

/**
 * Pure schema.org JSON-LD builders (#11204 item 4).
 *
 * Split out of server.ts so a route's `head()` and the server-side <head>
 * injection share ONE tested implementation instead of open-coding ListItem
 * positions and `@type` strings twice. Every function here is pure — no fetch,
 * no globals — which is what makes them testable without standing up a router.
 *
 * The rule these all ship under: **structured data may never claim something
 * the page does not actually show.** A rich result is a promise about the page,
 * and a broken promise costs more than a kept one earns, so each builder drops
 * incomplete input rather than emitting a hollow node.
 */

/**
 * Characters that must not survive into a `<script>` body verbatim.
 *
 * `<` alone stops the classic break-out (`</script>`), which is all server.ts
 * escaped before. `>` and `&` are escaped too so the payload is inert in any
 * parsing context, and U+2028/U+2029 because they are literal line terminators
 * in JavaScript — legal inside a JSON string, fatal inside a script element.
 * Spelled as escapes rather than pasted literally: as raw characters they are
 * invisible in the source, so a later edit could drop one with nothing to see.
 */
const SCRIPT_JSON_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/** Serialize JSON-LD safely for embedding in a `<script type="application/ld+json">`. */
export function stringifyJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => SCRIPT_JSON_ESCAPES[character] ?? character,
  );
}

/**
 * Stable `@id`s for the nodes that exist ONCE across the whole site.
 *
 * These are what turn a page's markup from a pile of disconnected objects into
 * a graph. A page emits two `<script type="application/ld+json">` blocks — the
 * server-injected site graph and, on an entity route, that route's own node —
 * and a consumer merges them by `@id`. So an entity node must REFERENCE
 * `{ "@id": JSONLD_IDS.org }` rather than restating an inline Organization: an
 * inline copy mints a second, unrelated entity every time, which is the exact
 * opposite of what structured data is for.
 *
 * Fragment identifiers on the origins, not invented URLs, so each `@id` is
 * dereferenceable to the thing it names.
 */
export const JSONLD_IDS = {
  org: `${SITE_ORIGIN}/#org`,
  website: `${SITE_ORIGIN}/#website`,
  /** The registry as a whole: the thing every per-subnet Dataset belongs to. */
  catalog: `${SITE_ORIGIN}/#catalog`,
  /** The public REST API. */
  restApi: `${API_ORIGIN}/#api`,
  /** The Model Context Protocol server. */
  mcp: `${API_ORIGIN}/#mcp`,
} as const;

/** A bare `@id` reference to another node in the page's merged graph. */
function ref(id: string) {
  return { "@id": id };
}

/**
 * The nodes every page carries, in the order a reader would want them.
 *
 * Lives here rather than inline in server.ts so the site graph and the entity
 * routes share ONE definition of who we are — server.ts open-coded the
 * Organization and WebSite, and an entity route open-coded a second
 * Organization inside its Dataset, so the same publisher was described twice
 * with different fields and no link between them.
 *
 * The two WebAPI nodes are the point of this for AI answer engines: a crawler
 * reading any page of this site now finds, typed and machine-readable, that the
 * data behind the page is available over a documented REST API and an MCP
 * server, published by a named organization. That claim is honest in a way the
 * per-subnet markup deliberately is not — these are OUR services, so describing
 * them as software we vouch for is exactly what we are entitled to say.
 */
export function siteGraphNodes(): unknown[] {
  return [
    {
      "@type": "Organization",
      "@id": JSONLD_IDS.org,
      name: "Metagraphed",
      url: SITE_ORIGIN,
      description:
        "The Bittensor subnet integration registry — what each subnet exposes (APIs, docs, schemas), whether it is healthy, and how to call it.",
      // #11204: the profiles that let a search engine resolve "Metagraphed" to
      // one entity rather than treating each surface as an unrelated site.
      // Only accounts this project actually controls are listed — a sameAs is
      // an identity claim, and a wrong one merges us with someone else.
      sameAs: [GITHUB_REPO_URL, X_PROFILE_URL],
    },
    {
      "@type": "WebSite",
      "@id": JSONLD_IDS.website,
      url: SITE_ORIGIN,
      name: "Metagraphed",
      publisher: ref(JSONLD_IDS.org),
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${SITE_ORIGIN}/subnets?q={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      },
    },
    {
      // The registry itself. Each subnet page's Dataset says
      // `includedInDataCatalog` back to this, which is what makes 129 isolated
      // Datasets read as one catalog rather than 129 unrelated files — the
      // relationship dataset indexes and answer engines actually traverse.
      "@type": "DataCatalog",
      "@id": JSONLD_IDS.catalog,
      name: "Metagraphed — the Bittensor subnet integration registry",
      description:
        "Per-subnet records of what each Bittensor subnet publishes: APIs, documentation, schemas, endpoints, probe-derived health and economics.",
      url: `${SITE_ORIGIN}/subnets`,
      publisher: ref(JSONLD_IDS.org),
      isAccessibleForFree: true,
      potentialAction: {
        // Natural-language search over the registry, which is the entry point
        // an agent wants and the one a keyword SearchAction cannot express.
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${API_ORIGIN}/api/v1/search/semantic?q={search_term_string}`,
          contentType: "application/json",
        },
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@type": "WebAPI",
      "@id": JSONLD_IDS.restApi,
      name: "Metagraphed REST API",
      description:
        "Public, read-only JSON over every registry record: subnets, surfaces, endpoints, providers, health and economics.",
      url: `${API_ORIGIN}/api/v1`,
      documentation: `${SITE_ORIGIN}/docs/api-reference`,
      provider: ref(JSONLD_IDS.org),
      termsOfService: `${SITE_ORIGIN}/docs/limits`,
      isAccessibleForFree: true,
    },
    {
      "@type": "WebAPI",
      "@id": JSONLD_IDS.mcp,
      name: "Metagraphed MCP server",
      description:
        "Model Context Protocol endpoint: an AI agent queries the Bittensor subnet registry as tools — discover subnets by capability, read live health, and fetch the schema needed to call a subnet's API.",
      url: `${API_ORIGIN}/mcp`,
      documentation: `${SITE_ORIGIN}/docs/mcp`,
      provider: ref(JSONLD_IDS.org),
      isAccessibleForFree: true,
      // The transport an agent needs to know before it can connect. `sameAs`
      // points at the machine-readable descriptor rather than restating the
      // tool list, which changes with every release.
      sameAs: [`${API_ORIGIN}/.well-known/mcp/server-card.json`],
    },
  ];
}

/**
 * Routes whose page has a single machine-readable record behind it.
 *
 * Every path and collection here was verified to answer 200 on the live API
 * before being listed -- a `rel="alternate"` pointing at a 404 is worse than no
 * alternate at all, because it advertises a machine format that does not exist.
 */
const API_RECORD_COLLECTIONS = [
  "subnets",
  "validators",
  "accounts",
  "providers",
  "blocks",
  "extrinsics",
] as const;

/**
 * The JSON record for a page, or null when the page is not one record.
 *
 * This is what backs the `<link rel="alternate" type="application/json">` the
 * server injects: the oldest and most widely understood way to say "there is a
 * machine-readable copy of this page, here". The site already advertised its
 * RSS and Atom feeds this way and never advertised its own data.
 *
 * Kept pure and pathname-only so it can be tested without a router, and so the
 * ONE injection point in server.ts covers every entity family at once rather
 * than six route files each remembering to do it.
 */
export function apiRecordUrl(pathname: string): string | null {
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  for (const collection of API_RECORD_COLLECTIONS) {
    if (trimmed === `/${collection}`) return `${API_ORIGIN}/api/v1/${collection}`;
    const detail = new RegExp(`^/${collection}/([^/]+)$`).exec(trimmed);
    // Already URL-encoded as part of the pathname; re-encoding would double it.
    if (detail?.[1]) return `${API_ORIGIN}/api/v1/${collection}/${detail[1]}`;
  }
  // The providers hub lives at /apis/providers, and the directory it links.
  if (trimmed === "/apis/providers") return `${API_ORIGIN}/api/v1/providers`;
  return null;
}

export interface BreadcrumbCrumb {
  name: string;
  /** Absolute URL — a crawler cannot resolve a relative `item`. */
  item: string;
}

/** schema.org BreadcrumbList; positions are 1-based, in trail order. */
export function breadcrumbListJsonLd(crumbs: BreadcrumbCrumb[]) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: crumb.item,
    })),
  };
}

export interface TechArticleInput {
  /** The page's own title. */
  headline: string;
  description?: string | null;
  /** Canonical URL for this page. */
  url: string;
  /**
   * ISO 8601, from the docs collection's git-derived `lastModified`.
   *
   * Only ever a date the PAGE ALSO SHOWS — it renders as "Last updated" in the
   * footer of every docs page — so the markup states nothing a reader cannot
   * check. Omitted when absent rather than defaulted to now.
   */
  dateModified?: string | null;
  /** Absolute URL of the page's representative image (its OG card). */
  image?: string | null;
  /**
   * ISO 8601 interval the page's content covers, e.g. `2026-07-20/2026-07-26`.
   *
   * A statement about the PERIOD, never about publication time. The weekly
   * digests know their week exactly (it is what selects their items) and know
   * no honest publication timestamp, so this is the field that fits.
   */
  temporalCoverage?: string | null;
  /**
   * `TechArticle` for reference documentation, `Article` for editorial prose.
   *
   * A weekly digest is a report about a subnet, not documentation of an
   * interface, and typing it as the latter would be the same over-claim the
   * rest of this module avoids.
   */
  type?: "TechArticle" | "Article";
}

/**
 * schema.org TechArticle for one documentation page.
 *
 * Docs are the pages an answer engine quotes — "how do I call a Bittensor
 * subnet's API", "what does readiness mean here" — and they carried no node at
 * all, so the ~49 most quotable pages on the site were untyped prose under a
 * generic site graph.
 *
 * `about` pointing at the catalog is the part that does work beyond the type
 * name: it states that this prose documents THAT data, which is what lets a
 * consumer follow a quoted sentence back to the machine-readable record behind
 * it — and, from the catalog, on to the REST and MCP endpoints.
 *
 * `dateModified` comes from the docs collection's git-derived `lastModified`
 * and is the date the page itself prints as "Last updated" — never a
 * fabricated one, and omitted entirely when the collection has none. (An
 * earlier revision of this comment claimed the loader carried no timestamp;
 * source.config.ts sets `docs.lastModified: true`, so it does.)
 *
 * Deliberately not FAQPage — these are reference pages, not question/answer
 * pairs, and marking them up as FAQ to chase a rich result is the kind of
 * over-claim that costs more than it earns.
 */
export function techArticleJsonLd(input: TechArticleInput) {
  const description = input.description?.trim();
  return {
    "@type": input.type ?? "TechArticle",
    headline: input.headline,
    ...(description ? { description } : {}),
    url: input.url,
    mainEntityOfPage: input.url,
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.temporalCoverage ? { temporalCoverage: input.temporalCoverage } : {}),
    inLanguage: "en",
    author: ref(JSONLD_IDS.org),
    publisher: ref(JSONLD_IDS.org),
    isPartOf: ref(JSONLD_IDS.website),
    about: ref(JSONLD_IDS.catalog),
  };
}

export interface SubnetDatasetInput {
  /** When this record was last rebuilt. Omitted from the node when absent. */
  dateModified?: string | null;
  netuid: number;
  /** Registry / on-chain name, when we have one. */
  name?: string | null;
  description?: string | null;
  /** Canonical page URL for this subnet. */
  url: string;
  /** Public API route serving this subnet's record. */
  apiUrl: string;
  /** Generated artifact for this subnet. */
  artifactUrl: string;
  /** The subnet's own site, when the registry has a verified one. */
  sameAs?: string | null;
}

/**
 * schema.org Dataset for one subnet's registry record.
 *
 * Dataset is the honest type, and a deliberate choice over
 * SoftwareApplication/WebAPI: what this page publishes is OUR measured record
 * of a subnet — its surfaces, endpoints, schemas, health and economics — not
 * the subnet's software itself. Describing another team's API as an application
 * we vouch for would be an over-claim, and not making that kind of claim is the
 * registry's whole value.
 *
 * `distribution` is the part that earns the markup: it points at the two
 * machine-readable representations the page already links, which is exactly
 * what a dataset consumer wants and what Google's dataset index reads.
 */
export function subnetDatasetJsonLd(input: SubnetDatasetInput) {
  return registryDatasetJsonLd({
    ...input,
    name: input.name ? `${input.name} (Subnet ${input.netuid})` : `Subnet ${input.netuid}`,
    // The netuid is the subnet's stable on-chain identifier, and the term a
    // reader is most likely to have searched to arrive here.
    identifier: String(input.netuid),
    description:
      input.description?.trim() ||
      `Registry record for Bittensor subnet ${input.netuid}: published interfaces, endpoints, schemas, health and economics.`,
  });
}

export interface ProviderDatasetInput {
  /** When this record was last rebuilt. Omitted from the node when absent. */
  dateModified?: string | null;
  /** Registry slug — the provider's stable key and its URL segment. */
  slug: string;
  name?: string | null;
  description?: string | null;
  url: string;
  apiUrl: string;
  artifactUrl: string;
  /** The provider's own site, when the registry holds one. */
  sameAs?: string | null;
}

/**
 * schema.org Dataset for one provider's registry record.
 *
 * Dataset, and NOT an `Organization` node for the provider itself — the same
 * restraint the subnet records ship under. This page publishes OUR measured
 * record of a third party: the endpoints they operate, the surfaces we found,
 * the health we probed. Emitting an `Organization` would be asserting an
 * identity for a company on their behalf, which is exactly the over-claim the
 * registry exists not to make.
 */
export function providerDatasetJsonLd(input: ProviderDatasetInput) {
  const name = input.name?.trim() || input.slug;
  return registryDatasetJsonLd({
    ...input,
    name: `${name} — provider record`,
    identifier: input.slug,
    description:
      input.description?.trim() ||
      `Registry record for ${name}: the public endpoints and operational surfaces this provider runs for Bittensor subnets, with probe-derived health.`,
  });
}

export interface RegistryFacetDatasetInput {
  name: string;
  identifier: string;
  description: string;
  /** Site-relative path of the page this dataset describes. */
  path: string;
  /** API-relative route the same selection can be computed from. */
  apiUrl: string;
}

/**
 * schema.org Dataset for a FACETED view of the registry (#11316).
 *
 * A filtered projection is still a dataset, and typing it as one is what ties
 * `/subnets/with-api` to the same `DataCatalog` node every subnet record already
 * points at -- otherwise the page is a table Google has no reason to connect to
 * the 129 records it selects from.
 *
 * Deliberately reuses `registryDatasetJsonLd`: the creator/publisher/catalog
 * wiring is the part that must not be re-typed per page, which is exactly how
 * the inline copy this replaced minted a second unrelated publisher on all 129
 * subnet pages.
 */
export function registryFacetDatasetJsonLd(input: RegistryFacetDatasetInput) {
  return registryDatasetJsonLd({
    name: input.name,
    identifier: input.identifier,
    description: input.description,
    url: `${SITE_ORIGIN}${input.path}`,
    apiUrl: `${API_ORIGIN}${input.apiUrl}`,
    // A facet has no single generated artifact of its own; the API route IS
    // the machine-readable form, so it is named once rather than duplicated
    // into a second DataDownload that would point at the same bytes.
    artifactUrl: `${API_ORIGIN}${input.apiUrl}`,
  });
}

export interface ValidatorDatasetInput {
  /** The hotkey ss58 — the validator's stable on-chain identifier. */
  hotkey: string;
  /** Operator's self-declared coldkey identity, when the chain carries one. */
  name?: string | null;
  /** Subnets this hotkey validates on, when known. */
  subnetCount?: number | null;
  dateModified?: string | null;
}

/**
 * schema.org Dataset for one validator's registry record (#11313).
 *
 * These are **1,023 URLs — 53% of the sitemap** — and every one of them carried
 * a BreadcrumbList and nothing else: no node saying what the page is about, no
 * link to the machine-readable form, no place in the catalog. The biggest
 * structured-data gap on the site, and the one nobody had measured because the
 * audit that found it (#11230) sampled subnets and providers.
 *
 * Dataset for the same reason the subnet records are: what this page publishes
 * is OUR measured record of a hotkey's participation — stake, take, the subnets
 * it validates on — not the validator's software, and not an endorsement of it.
 */
export function validatorDatasetJsonLd(input: ValidatorDatasetInput) {
  const label = input.name?.trim();
  return registryDatasetJsonLd({
    name: label ? `${label} — Bittensor validator` : "Bittensor validator record",
    identifier: input.hotkey,
    description: label
      ? `Registry record for ${label}: the subnets this Bittensor validator operates on, its stake, take and probe-derived participation.`
      : "Registry record for a Bittensor validator hotkey: the subnets it operates on, its stake, take and probe-derived participation.",
    url: `${SITE_ORIGIN}/validators/${encodeURIComponent(input.hotkey)}`,
    apiUrl: `${API_ORIGIN}/api/v1/validators/${encodeURIComponent(input.hotkey)}`,
    // No per-validator generated artifact exists; the API route is the
    // machine-readable form, named once rather than duplicated into a second
    // DataDownload pointing at the same bytes.
    artifactUrl: `${API_ORIGIN}/api/v1/validators/${encodeURIComponent(input.hotkey)}`,
    dateModified: input.dateModified ?? null,
  });
}

interface RegistryDatasetInput {
  name: string;
  identifier: string;
  description: string;
  url: string;
  apiUrl: string;
  artifactUrl: string;
  sameAs?: string | null;
  /**
   * When the record was last rebuilt (#11314).
   *
   * Emitted only when we actually have it -- see `recordModifiedAt`, which
   * takes the PUBLISH timestamp rather than the probe observation for the same
   * reason `sitemapLastmod` refuses to synthesise one.
   */
  dateModified?: string | null;
}

/**
 * The shape every registry record shares: a named, freely accessible dataset
 * inside our catalog, distributed as the two JSON representations the page
 * already links.
 *
 * One builder rather than one per entity kind, because the parts that differ
 * are only the label, the identifier and the fallback sentence -- and a second
 * copy is how the `creator`/`publisher`/`includedInDataCatalog` wiring ends up
 * on subnets and missing on providers.
 */
function registryDatasetJsonLd(input: RegistryDatasetInput) {
  return {
    "@type": "Dataset",
    name: input.name,
    ...(isoTimestamp(input.dateModified) ? { dateModified: isoTimestamp(input.dateModified) } : {}),
    description: input.description,
    url: input.url,
    identifier: input.identifier,
    isAccessibleForFree: true,
    // References, not a restated Organization. The inline copy this replaces
    // minted a second, unrelated publisher on every one of the 129 subnet
    // pages, so nothing tied the record to the site that publishes it.
    creator: ref(JSONLD_IDS.org),
    publisher: ref(JSONLD_IDS.org),
    // What makes 129 Datasets one catalog rather than 129 loose files.
    includedInDataCatalog: ref(JSONLD_IDS.catalog),
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: input.apiUrl,
        name: "REST API",
      },
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: input.artifactUrl,
        name: "Generated artifact",
      },
    ],
    // Only assert an external identity we actually hold: an empty sameAs is
    // worse than none, and a wrong one attaches this record to another project.
    ...(input.sameAs ? { sameAs: [input.sameAs] } : {}),
  };
}
