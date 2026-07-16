import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Stubs fumadocs-openapi's real (heavy, shiki-backed) component with
// something that just echoes its props into the markup -- this test is
// about mdx.tsx's own wiring (does APIPage read context and forward
// `preloaded` correctly), not fumadocs-openapi's internals.
vi.mock("fumadocs-openapi/ui/base", () => ({
  createOpenAPIPageBase: () => (props: Record<string, unknown>) => (
    <div data-testid="raw-api-page" data-props={JSON.stringify(props)} />
  ),
}));

const { OpenAPIPreloadProvider } = await import("@/lib/openapi-preload-context");
const { getMDXComponents } = await import("./mdx");

describe("APIPage", () => {
  it("renders nothing when no preload is available (no provider)", () => {
    const { APIPage } = getMDXComponents();
    const html = renderToStaticMarkup(<APIPage document="metagraph" operations={[]} />);
    expect(html).toBe("");
  });

  it("forwards the generated page's own props plus the context-resolved preloaded schema", () => {
    const { APIPage } = getMDXComponents();
    const preloaded = { docs: { metagraph: { openapi: "3.1.0" } } };
    const operations = [{ path: "/api/v1/accounts/{ss58}/axon-removals", method: "get" as const }];

    const html = renderToStaticMarkup(
      <OpenAPIPreloadProvider value={preloaded}>
        <APIPage document="metagraph" operations={operations} />
      </OpenAPIPreloadProvider>,
    );

    expect(html).toContain('data-testid="raw-api-page"');
    const match = html.match(/data-props="([^"]+)"/);
    const props = JSON.parse(match![1].replace(/&quot;/g, '"'));
    expect(props.document).toBe("metagraph");
    expect(props.operations).toEqual(operations);
    expect(props.preloaded).toEqual(preloaded);
  });
});
