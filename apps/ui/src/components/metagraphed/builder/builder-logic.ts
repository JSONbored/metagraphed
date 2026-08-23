import type { MarkerRailItem } from "@jsonbored/ui-kit";
import type { Gap } from "@/lib/metagraphed/types";

/**
 * The derivations behind /contribute and /agents (#11626). Pure, so both
 * pages stay thin and every rule below is testable without a browser.
 */

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/* ── /contribute ─────────────────────────────────────────────────────────── */

export interface GapRow {
  key: string;
  netuid: number;
  name: string;
  slug: string;
  missing: string[];
  supported: string[];
  gapCount: number;
  priority: number;
  severity: string | null;
  coverage: string | null;
  curation: string | null;
  /** The registry's own note on why a gap is expected, when it has one. */
  note: string | null;
}

/**
 * One row per SUBNET with at least one missing facet, most impactful first.
 *
 * Takes the NORMALIZED `Gap`, which is what `gapsQuery` returns: its
 * normalizer flattens `gaps.missing_kinds` to `missing_kinds`, renames
 * `gap_severity` to `severity`, and folds the subnet name into `title`. A
 * second normalizer here reading the raw payload's field names would have
 * silently produced zero rows -- which is exactly what it did before this
 * comment existed.
 *
 * `gap_priority` is the registry's own ordering and is used as given: a page
 * that re-ranked gaps by its own weighting would send contributors somewhere
 * the curation lane did not ask them to go. Ties break on the gap count, then
 * the netuid, so the queue is stable between loads.
 *
 * A subnet whose gaps are all EXPECTED -- root has no subnet API by design --
 * keeps its `suggested_action` note so the row says why before someone spends
 * an evening on it.
 */
export function gapRows(raw: readonly Gap[] | null | undefined): GapRow[] {
  return (Array.isArray(raw) ? raw : [])
    .map((row, i) => {
      const missing = Array.isArray(row.missing_kinds) ? row.missing_kinds : [];
      const netuid = num(row.netuid) ?? -1;
      const notes = Array.isArray(row.gap_notes) ? row.gap_notes : [];
      return {
        key: str(row.id) ?? `gap-${i}`,
        netuid,
        // The normalizer folds the subnet name into `title` as
        // "<name> — N missing surfaces"; the name is the half before the dash.
        name: (str(row.title)?.split(" — ")[0] ?? "") || `sn-${netuid}`,
        slug: str(row.id) ?? "",
        missing,
        supported: Array.isArray(row.supported_kinds)
          ? (row.supported_kinds as unknown[]).filter((k): k is string => typeof k === "string")
          : [],
        gapCount: missing.length,
        priority: num(row.gap_priority) ?? 0,
        severity: str(row.severity),
        coverage: str(row.coverage_level) ?? str(row.category),
        curation: str(row.curation_level) ?? str(row.category),
        note: str(row.suggested_action) ?? notes[0] ?? null,
      };
    })
    .filter((row) => row.gapCount > 0)
    .sort((a, b) => b.priority - a.priority || b.gapCount - a.gapCount || a.netuid - b.netuid);
}

/**
 * How many subnets publish each kind of surface, as a share of the set.
 *
 * From /api/v1/coverage's `completeness.dimension_coverage`, a real ratio over
 * the subnet set. NOT `domain_coverage`, which counts how many subnets are IN
 * each domain and is not a completeness reading at all -- an 11-subnet
 * "agents" domain is not 11% covered, it is eleven subnets.
 *
 * This used to exist twice. `coverageColumns` here fed a `StackedColumns` on
 * /contribute and `coverageMarkers` in apis-logic fed a `MarkerRail` on
 * /apis/schemas -- two functions over one field drawing one answer two ways,
 * and the stacked one drew eight KINDS along an axis that thins labels like
 * dates, so six of the eight bars were unlabelled (#11693). One function, one
 * rail, and /contribute is its home because "what share of subnets publish
 * each kind" is the contributor's map of what is missing.
 */
export function coverageMarkers(
  dimensions: Record<string, { pct?: number; present?: number }> | null | undefined,
  fmt: { count: (n: number) => string },
): MarkerRailItem[] {
  if (!dimensions) return [];
  return Object.entries(dimensions)
    .filter(([, value]) => typeof value?.pct === "number")
    .map(([key, value]) => ({
      key,
      label: key,
      value: value.pct as number,
      // `tag`, not `detail`. `MarkerRailItem` has no `detail` field, so the
      // subnet count this carried was an excess property TypeScript accepted
      // and the rail never drew. `tag` is the chip the primitive does render.
      tag: typeof value.present === "number" ? `${fmt.count(value.present)} subnets` : undefined,
    }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

export interface Fact {
  key: string;
  label: string;
  value: string;
}

/** The /contribute hero. */
export function contributeFacts(
  rows: readonly GapRow[],
  coverage:
    { completeness?: { average_score?: number }; candidate_count?: number } | null | undefined,
  fmt: { count: (n: number) => string },
): Fact[] {
  if (rows.length === 0) return [];
  const facets = rows.reduce((sum, row) => sum + row.missing.length, 0);
  const facts: Fact[] = [
    { key: "subnets", label: "subnets with gaps", value: fmt.count(rows.length) },
    { key: "facets", label: "missing surfaces", value: fmt.count(facets) },
  ];
  const candidates = num(coverage?.candidate_count);
  if (candidates != null) {
    facts.push({
      key: "candidates",
      label: "candidates awaiting review",
      value: fmt.count(candidates),
    });
  }
  const score = num(coverage?.completeness?.average_score);
  if (score != null)
    facts.push({ key: "score", label: "average completeness", value: `${score}%` });
  return facts;
}

/* ── /agents ─────────────────────────────────────────────────────────────── */

export interface ToolRow {
  key: string;
  name: string;
  title: string;
  family: string;
}

/**
 * The MCP tool list, with a family derived from the tool's own name.
 *
 * The served list carries `name` and `title` and nothing else — no family, no
 * description, and no core/full flag. The family is the first noun after the
 * verb (`get_subnet_detail` -> `subnet`, `list_chain_events` -> `chain`),
 * which is a real grouping the naming convention already encodes rather than a
 * taxonomy invented here. A name with no verb prefix keeps its whole first
 * token.
 */
export function toolRows(raw: readonly Record<string, unknown>[] | null | undefined): ToolRow[] {
  return (Array.isArray(raw) ? raw : [])
    .map((tool, i) => {
      const name = str(tool.name) ?? `tool-${i}`;
      return {
        key: name,
        name,
        title: str(tool.title) ?? name,
        family: toolFamily(name),
      };
    })
    .sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
}

const VERBS = new Set([
  "get",
  "list",
  "find",
  "search",
  "compare",
  "call",
  "write",
  "store",
  "delete",
  "run",
  "verify",
  "query",
  "decode",
  "how",
  "registry",
  "semantic",
]);

/** The first noun token of a tool name, or its first token. */
export function toolFamily(name: string): string {
  const parts = name.split("_").filter(Boolean);
  if (parts.length === 0) return "other";
  const head = parts[0]!;
  if (!VERBS.has(head) || parts.length === 1) return head;
  return parts[1]!;
}

/** The distinct values of one field, sorted, for a filter select. */
export function facet<Row>(
  rows: readonly Row[],
  of: (row: Row) => string | null | undefined,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = of(row)?.trim();
    if (value) seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Rows whose name, title or family contains `q`. */
export function filterTools(rows: readonly ToolRow[], q: string, family: string): ToolRow[] {
  const needle = q.trim().toLowerCase();
  return rows.filter((row) => {
    if (family && row.family !== family) return false;
    if (!needle) return true;
    return [row.name, row.title, row.family].some((field) => field.toLowerCase().includes(needle));
  });
}

export interface Snippet {
  value: string;
  label: string;
  code: string;
  /** What the reader does with it, one line under the block. */
  hint: string;
}

/**
 * One line per harness, all pointing at the same endpoint.
 *
 * `/mcp/core` and not `/mcp`: the core listing is 23 of the 243 tools at a
 * ninth of the token cost and still CALLS all 243, so it is the endpoint an
 * agent should be given. The full endpoint is a `Raw` row for the caller who
 * wants every tool listed up front.
 */
export function connectSnippets(
  mcp: { install?: string; core_endpoint?: string; endpoint?: string } | null | undefined,
): Snippet[] {
  const core = str(mcp?.core_endpoint) ?? str(mcp?.endpoint) ?? "https://api.metagraph.sh/mcp/core";
  return [
    {
      value: "claude",
      label: "Claude Code",
      code: str(mcp?.install) ?? `claude mcp add --transport http metagraphed ${core}`,
      hint: "Run it once; the tools appear in every session.",
    },
    {
      value: "cursor",
      label: "Cursor",
      code: JSON.stringify(
        { mcpServers: { metagraphed: { url: core, transport: "http" } } },
        null,
        2,
      ),
      hint: "Add to .cursor/mcp.json in the project, or the global one.",
    },
    {
      value: "curl",
      label: "curl",
      code: `curl -sS -X POST ${core} \\\n  -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      hint: "No client needed — the server speaks plain JSON-RPC over HTTP.",
    },
  ];
}

/** The /agents hero. */
export function agentFacts(
  summary: { callable_service_count?: number; subnet_count?: number } | null | undefined,
  tools: number,
  fmt: { count: (n: number) => string },
): Fact[] {
  const facts: Fact[] = [];
  if (tools > 0) facts.push({ key: "tools", label: "MCP tools", value: fmt.count(tools) });
  const subnets = num(summary?.subnet_count);
  if (subnets != null)
    facts.push({ key: "subnets", label: "subnets covered", value: fmt.count(subnets) });
  const services = num(summary?.callable_service_count);
  if (services != null) {
    facts.push({ key: "services", label: "callable services", value: fmt.count(services) });
  }
  return facts;
}
