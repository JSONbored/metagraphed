import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("fumadocs-openapi/ui/base", () => ({
  createOpenAPIPageBase: () => (props: Record<string, unknown>) => (
    <div data-testid="raw-api-page" data-props={JSON.stringify(props)} />
  ),
}));

const { OpenAPIPreloadProvider } = await import("@/lib/openapi-preload-context");
const { OpenAPIPage } = await import("./openapi-page");

describe("OpenAPIPage", () => {
  it("renders nothing when no preload is available", () => {
    expect(renderToStaticMarkup(<OpenAPIPage document="metagraph" operations={[]} />)).toBe("");
  });

  it("forwards operation props and the context-resolved schema", () => {
    const preloaded = { docs: { metagraph: { openapi: "3.1.0" } } };
    const operations = [{ path: "/api/v1/accounts/{ss58}/axon-removals", method: "get" as const }];
    const html = renderToStaticMarkup(
      <OpenAPIPreloadProvider value={preloaded}>
        <OpenAPIPage document="metagraph" operations={operations} />
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
