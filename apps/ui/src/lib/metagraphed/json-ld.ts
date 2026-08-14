import { SITE_ORIGIN } from "./identity";

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

export interface SubnetDatasetInput {
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
  const label = input.name ? `${input.name} (Subnet ${input.netuid})` : `Subnet ${input.netuid}`;
  const description =
    input.description?.trim() ||
    `Registry record for Bittensor subnet ${input.netuid}: published interfaces, endpoints, schemas, health and economics.`;
  return {
    "@type": "Dataset",
    name: label,
    description,
    url: input.url,
    // The netuid is the subnet's stable on-chain identifier, and the term a
    // reader is most likely to have searched to arrive here.
    identifier: String(input.netuid),
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: "Metagraphed", url: SITE_ORIGIN },
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
