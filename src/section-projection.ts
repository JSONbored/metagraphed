// `?sections=` on a composite document (#10600).
//
// Two routes -- `/api/v1/subnets/{netuid}` (272,825 B) and its `/profile`
// (202,948 B) -- had no lever at all. The ordinary one does not fit: a query
// collection pages ONE `data_key`, and their bulk is four parallel arrays over
// the same subject (`endpoints`, `surfaces`, `verified_surfaces`,
// `candidate_surfaces` -- 76/76/76/16 on subnet 64), so paging one would narrow
// a quarter of the payload and leave the rest fat.
//
// WHY NOT `fields`. It exists on 5 routes and everywhere it means the same
// thing: pick columns out of the rows of a list. This picks whole cards out of
// one document. `fieldsSchema`'s published description says "row field names",
// so extending the name meant either weakening that description for every route
// that carries it, or publishing one name with two meanings and no error when a
// caller applied the wrong one. #9884's partial-object rule was written for the
// row-projection meaning too. A second name is the honest cost of a second unit
// of selection.
//
// THE ENVELOPE IS NOT A SECTION. schema_version/contract_version/generated_at/
// operational_observed_at/health_source survive every projection: they say what
// the caller is holding and when it was built, and a document that cannot say
// that is not smaller, it is anonymous. A caller asking for `economics` wants a
// smaller answer, not an unattributable one.

/** Envelope keys every projection keeps, whatever was asked for. */
export const ALWAYS_KEPT_SECTIONS: readonly string[] = [
  "schema_version",
  "contract_version",
  "generated_at",
  "operational_observed_at",
  "health_source",
];

export interface SectionProjection {
  /** The requested section names, in the order given, deduplicated. */
  sections: string[];
  /** Names the route cannot serve. Non-empty means the caller gets a 400. */
  unknown: string[];
}

/**
 * Parse a raw `sections=` value against a route's vocabulary.
 *
 * Rejects rather than ignores an unknown name: dropping it would answer
 * `?sections=eeconomics` with a document missing the one section that was asked
 * for, and a 200 omitting the request is worse than a 400 explaining it.
 *
 * Whitespace is NOT tolerated, matching `sectionsSchema`'s published regex. The
 * looser `fields` parser exists because production already accepted `"a, b"`
 * before the pattern was written; nothing accepts `sections` yet, so the parser
 * and the pattern agree from the start instead of being reconciled later.
 */
export function parseSectionsParam(
  raw: string | null | undefined,
  allowed: readonly string[],
): SectionProjection | null {
  if (raw == null || raw === "") return null;
  const seen = new Set<string>();
  const sections: string[] = [];
  const unknown: string[] = [];
  for (const part of raw.split(",")) {
    if (seen.has(part)) continue;
    seen.add(part);
    // An empty segment (`a,,b`) is not a section name, so it lands in `unknown`
    // and is reported as such rather than being silently skipped -- the caller
    // wrote something they believed selected a section.
    if (allowed.includes(part)) sections.push(part);
    else unknown.push(part);
  }
  return { sections, unknown };
}

/**
 * Keep the requested sections plus the envelope; drop the rest.
 *
 * Key ORDER follows the document, not the request: a caller writing
 * `?sections=notes,subnet` gets the same byte layout as `?sections=subnet,notes`,
 * so a response cannot differ by how the question was phrased. A requested
 * section the document does not carry is simply absent -- the schema already
 * marks these optional, and inventing a null would claim the section exists and
 * is empty.
 */
export function projectSections(
  data: Record<string, unknown>,
  sections: readonly string[],
): Record<string, unknown> {
  const keep = new Set([...ALWAYS_KEPT_SECTIONS, ...sections]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (keep.has(key)) out[key] = value;
  }
  return out;
}

/**
 * The same projection for an MCP tool, which receives typed JSON rather than a
 * query string (#10600).
 *
 * The tools do NOT reach the REST serving seam -- each composes its own
 * response from `loadArtifactData` plus its overlays -- so the projection has
 * to happen in the handler. Sharing this function is what keeps the two
 * surfaces from disagreeing about what `sections=economics` returns.
 *
 * An unknown name cannot arrive: the tool's input schema carries the same
 * closed pattern the route publishes, and the dispatch validates against it.
 * A non-string (an agent sending `sections: ["a","b"]`) is treated as absent
 * rather than coerced -- on a typed surface an array is the type error it
 * looks like, and guessing would serve a projection the caller did not ask for.
 */
export function projectToolSections<T>(
  data: T,
  args: unknown,
  allowed: readonly string[],
): T {
  const raw = (args as Record<string, unknown> | null | undefined)?.sections;
  if (typeof raw !== "string") return data;
  const requested = parseSectionsParam(raw, allowed);
  if (
    !requested ||
    requested.unknown.length > 0 ||
    !data ||
    typeof data !== "object"
  ) {
    return data;
  }
  return projectSections(
    data as Record<string, unknown>,
    requested.sections,
  ) as T;
}
