import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DocumentLoadingSkeleton,
  routeLoadingArchetype,
  type RouteLoadingArchetype,
} from "./route-loading-skeleton";

describe("routeLoadingArchetype", () => {
  it.each<[string, RouteLoadingArchetype]>([
    ["/", "landing"],
    ["/subnets", "directory"],
    ["/validators/", "directory"],
    ["/accounts", "directory"],
    ["/apis", "directory"],
    ["/apis/endpoints", "directory"],
    ["/apis/providers", "directory"],
    ["/apis/schemas", "directory"],
    ["/chain/blocks", "directory"],
    ["/chain/extrinsics", "directory"],
    ["/chain/events", "directory"],
    ["/contribute", "directory"],
    ["/subnets/19", "entity"],
    ["/validators/5Fabc", "entity"],
    ["/accounts/5Fabc", "entity"],
    ["/providers/example", "entity"],
    ["/extrinsics/0xabc", "entity"],
    ["/events/8713384/320?source=block#arguments", "entity"],
    ["/blocks/8942103", "block"],
    ["/chain", "operational"],
    ["/health", "operational"],
    ["/chain/analytics", "operational"],
    ["/compare", "compare"],
    ["/settings", "settings"],
    ["/agents", "settings"],
    ["/graphql/explorer", "settings"],
    ["/about", "reading"],
    ["/privacy", "reading"],
    ["/terms", "reading"],
    ["/docs/getting-started", "reading"],
    ["/news/weekly-42", "reading"],
    ["/design/primitives", "reading"],
  ])("maps %s to the %s pending grammar", (pathname, archetype) => {
    expect(routeLoadingArchetype(pathname)).toBe(archetype);
  });
});

describe("DocumentLoadingSkeleton", () => {
  it.each<[RouteLoadingArchetype, readonly string[], readonly string[]]>([
    ["landing", ["mg-home-command-grid", "mg-home-mcp-install", "mg-home-pulse"], ["mg-dt"]],
    ["directory", ["mg-hero--directory", "mg-directory-section", "mg-dt"], []],
    ["entity", ["mg-hero--entity", "mg-dt"], ["mg-hero--block"]],
    ["operational", ["mg-hero--operational", "mg-section-visual"], ["mg-dt"]],
    ["compare", ["mg-hero--compare", "mg-compare"], ["mg-dt"]],
    ["settings", ["mg-hero--settings", "mg-settings-preferences"], ["mg-dt"]],
    ["reading", ["max-w-4xl", "max-w-[68ch]"], ["mg-hero--entity", "mg-dt"]],
    ["block", ["mg-hero--entity", "mg-hero--block", "mg-dt"], []],
  ])("renders the %s destination shape", (archetype, included, excluded) => {
    const html = renderToStaticMarkup(
      <DocumentLoadingSkeleton label={`Loading ${archetype}`} archetype={archetype} />,
    );

    expect(html).toContain(`aria-label="Loading ${archetype}"`);
    expect((html.match(/role="status"/g) ?? []).length).toBe(1);
    expect(html).toContain('role="status" aria-live="polite" aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
    for (const value of included) expect(html).toContain(value);
    for (const value of excluded) expect(html).not.toContain(value);
  });

  it("keeps the block ledger specific to block extrinsics", () => {
    const html = renderToStaticMarkup(
      <DocumentLoadingSkeleton label="Loading block detail" archetype="block" />,
    );

    expect(html).toContain("Extrinsics in this block");
    expect(html).toContain("Hash");
    expect(html).toContain("Call");
    expect(html).toContain("Signer");
    expect(html).toContain("Result");
    expect((html.match(/class="mg-dt-row mg-dt-skeleton"/g) ?? []).length).toBe(8);
    expect(html).not.toContain("mg-block-event-stream");
  });
});
