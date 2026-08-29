import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
const { getMDXComponents } = await import("./mdx");

describe("MDX components", () => {
  it("defers the OpenAPI renderer behind a geometry-preserving fallback", () => {
    const { APIPage } = getMDXComponents();
    const html = renderToStaticMarkup(<APIPage document="metagraph" operations={[]} />);
    expect(html).toContain('aria-label="Loading endpoint reference"');
    expect(html).toContain('aria-busy="true"');
  });
});
