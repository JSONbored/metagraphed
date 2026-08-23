import { describe, expect, it } from "vitest";
import type { Gap } from "@/lib/metagraphed/types";
import {
  agentFacts,
  connectSnippets,
  contributeFacts,
  coverageMarkers,
  facet,
  filterTools,
  gapRows,
  toolFamily,
  toolRows,
} from "./builder-logic";

// The NORMALIZED shape `gapsQuery` returns, not the raw payload: its
// normalizer flattens `gaps.missing_kinds`, renames `gap_severity`, and folds
// the subnet name into `title`.
const gaps: Gap[] = [
  {
    id: "root",
    netuid: 0,
    title: "root — 4 missing surfaces",
    gap_priority: 0,
    severity: "medium",
    coverage_level: "probed",
    curation_level: "maintainer-reviewed",
    missing_kinds: ["openapi", "subnet-api", "sse", "data-artifact"],
    supported_kinds: ["docs", "website"],
    suggested_action: "Root/system is not expected to expose subnet-specific SSE.",
  },
  {
    id: "twelve",
    netuid: 12,
    title: "Twelve — 2 missing surfaces",
    gap_priority: 9,
    severity: "high",
    missing_kinds: ["openapi", "sdk"],
  },
  { id: "complete", netuid: 5, title: "Complete — 0 missing surfaces", missing_kinds: [] },
];

describe("gapRows", () => {
  it("ranks by the registry's own gap_priority, highest first", () => {
    // Not by the page's own weighting: re-ranking would send contributors
    // somewhere the curation lane did not ask them to go.
    expect(gapRows(gaps).map((r) => r.netuid)).toEqual([12, 0]);
  });

  it("drops a subnet with no gaps rather than listing it as done", () => {
    expect(gapRows(gaps).some((r) => r.netuid === 5)).toBe(false);
  });

  it("keeps the registry's own note so an expected gap says so", () => {
    expect(gapRows(gaps).find((r) => r.netuid === 0)?.note).toContain("not expected");
  });

  it("is null-noted when the registry offers no reason", () => {
    expect(gapRows(gaps).find((r) => r.netuid === 12)?.note).toBeNull();
  });

  it("counts the gaps from the missing list itself", () => {
    const row = gapRows([{ id: "x", netuid: 3, missing_kinds: ["a", "b", "c"] }])[0];
    expect(row?.gapCount).toBe(3);
  });

  it("reads the subnet name out of the title the normalizer built", () => {
    // The normalizer folds it in as "<name> — N missing surfaces"; taking the
    // whole title would print the count twice on every row.
    expect(gapRows(gaps).find((r) => r.netuid === 0)?.name).toBe("root");
  });

  it("is empty for nothing", () => {
    expect(gapRows(null)).toEqual([]);
  });
});

const fmt = { count: (n: number) => String(n) };

describe("contributeFacts", () => {
  it("sums the missing surfaces across subnets, not just the subnet count", () => {
    const facts = contributeFacts(
      gapRows(gaps),
      { candidate_count: 2221, completeness: { average_score: 81 } },
      fmt,
    );
    expect(facts.find((f) => f.key === "subnets")?.value).toBe("2");
    expect(facts.find((f) => f.key === "facets")?.value).toBe("6");
    expect(facts.find((f) => f.key === "candidates")?.value).toBe("2221");
    expect(facts.find((f) => f.key === "score")?.value).toBe("81%");
  });

  it("is empty when nothing has a gap", () => {
    expect(contributeFacts([], { candidate_count: 5 }, fmt)).toEqual([]);
  });
});

describe("coverageMarkers", () => {
  const dimensions = {
    docs: { pct: 100, present: 129 },
    openapi: { pct: 52, present: 67 },
    community: { pct: 72, present: 93 },
  };

  it("uses the real percentage, largest first, and tags the count", () => {
    expect(coverageMarkers({ docs: { pct: 100, present: 129 } }, fmt)).toEqual([
      { key: "docs", label: "docs", value: 100, tag: "129 subnets" },
    ]);
  });

  // `tag` is the field `MarkerRailItem` declares; `detail` -- what this
  // returned before #11693 -- is not one, so the subnet count was an excess
  // property TypeScript accepted and the rail never drew.
  it("carries the count in a field the rail renders", () => {
    const [first] = coverageMarkers(dimensions, fmt);
    expect(first).toHaveProperty("tag");
    expect(first).not.toHaveProperty("detail");
  });

  it("orders most-covered first", () => {
    expect(coverageMarkers(dimensions, fmt).map((marker) => marker.key)).toEqual([
      "docs",
      "community",
      "openapi",
    ]);
  });

  it("drops a dimension with no percentage rather than plotting it at zero", () => {
    expect(coverageMarkers({ mystery: { present: 4 } }, fmt)).toEqual([]);
  });

  it("is empty for nothing", () => {
    expect(coverageMarkers(null, fmt)).toEqual([]);
    expect(coverageMarkers(undefined, fmt)).toEqual([]);
  });
});

describe("toolFamily", () => {
  it("takes the first noun after the verb", () => {
    expect(toolFamily("get_subnet_detail")).toBe("subnet");
    expect(toolFamily("list_chain_events")).toBe("chain");
    expect(toolFamily("compare_validators")).toBe("validators");
  });

  it("keeps the whole first token when there is no verb prefix", () => {
    expect(toolFamily("ask")).toBe("ask");
    expect(toolFamily("semantic_search")).toBe("search");
  });

  it("never returns an empty family", () => {
    expect(toolFamily("")).toBe("other");
    expect(toolFamily("___")).toBe("other");
  });
});

const tools = [
  { name: "get_subnet_detail", title: "Subnet detail" },
  { name: "list_subnets", title: "List subnets" },
  { name: "get_chain_fees", title: "Chain fees" },
  { name: "ask", title: "Grounded answer" },
];

describe("toolRows", () => {
  it("groups by family, then name", () => {
    expect(toolRows(tools).map((r) => r.family)).toEqual(["ask", "chain", "subnet", "subnets"]);
  });

  it("falls back to the name when a tool has no title", () => {
    expect(toolRows([{ name: "x_y" }])[0]!.title).toBe("x_y");
  });

  it("is empty for nothing", () => {
    expect(toolRows(undefined)).toEqual([]);
  });
});

describe("filterTools", () => {
  const rows = toolRows(tools);

  it("searches name, title and family together", () => {
    expect(filterTools(rows, "FEES", "").map((r) => r.name)).toEqual(["get_chain_fees"]);
    expect(filterTools(rows, "grounded", "").map((r) => r.name)).toEqual(["ask"]);
  });

  it("narrows to one family", () => {
    expect(filterTools(rows, "", "subnet").map((r) => r.name)).toEqual(["get_subnet_detail"]);
  });

  it("returns everything with no filter", () => {
    expect(filterTools(rows, "", "")).toHaveLength(4);
  });
});

describe("connectSnippets", () => {
  it("points every harness at the CORE endpoint", () => {
    // 23 of 243 tools listed at a ninth of the token cost, and it still CALLS
    // all 243 — so it is the endpoint an agent should be given.
    const snippets = connectSnippets({
      core_endpoint: "https://api.metagraph.sh/mcp/core",
      endpoint: "https://api.metagraph.sh/mcp",
      install: "claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp/core",
    });
    expect(snippets).toHaveLength(3);
    for (const snippet of snippets) {
      expect(snippet.code, `${snippet.value} does not name the core endpoint`).toContain(
        "/mcp/core",
      );
      expect(snippet.code).not.toMatch(/mcp['"\s]*$/);
    }
  });

  it("uses the server's own install line for Claude rather than reconstructing it", () => {
    expect(connectSnippets({ install: "custom install line", core_endpoint: "x" })[0]!.code).toBe(
      "custom install line",
    );
  });

  it("still produces a usable snippet when the server publishes nothing", () => {
    const snippets = connectSnippets(null);
    expect(snippets).toHaveLength(3);
    expect(snippets[0]!.code).toContain("https://api.metagraph.sh/mcp/core");
  });

  it("gives every snippet a hint saying what to do with it", () => {
    expect(connectSnippets(null).every((s) => s.hint.length > 0)).toBe(true);
  });
});

describe("agentFacts", () => {
  it("reports the tool count from the SERVED list, not from a constant", () => {
    const facts = agentFacts({ callable_service_count: 2149, subnet_count: 128 }, 243, fmt);
    expect(facts.map((f) => [f.key, f.value])).toEqual([
      ["tools", "243"],
      ["subnets", "128"],
      ["services", "2149"],
    ]);
  });

  it("omits the tool count rather than claiming zero tools", () => {
    expect(agentFacts({ subnet_count: 1 }, 0, fmt).some((f) => f.key === "tools")).toBe(false);
  });

  it("is empty when nothing is known", () => {
    expect(agentFacts(null, 0, fmt)).toEqual([]);
  });
});

describe("facet", () => {
  it("is the sorted distinct set", () => {
    expect(facet(toolRows(tools), (r) => r.family)).toEqual(["ask", "chain", "subnet", "subnets"]);
  });
});
