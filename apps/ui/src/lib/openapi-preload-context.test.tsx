import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpenAPIPreloadProvider, useOpenAPIPreload } from "./openapi-preload-context";

// renderToStaticMarkup (SSR, no DOM) is enough to exercise a context/hook
// pair -- useContext doesn't touch browser APIs. Matches this suite's
// "plain node environment" scope; no jsdom/testing-library needed.
function Probe({ onValue }: { onValue: (value: ReturnType<typeof useOpenAPIPreload>) => void }) {
  onValue(useOpenAPIPreload());
  return null;
}

describe("useOpenAPIPreload", () => {
  it("returns undefined outside a provider", () => {
    let captured: unknown = "not-called";
    renderToStaticMarkup(
      <Probe
        onValue={(v) => {
          captured = v;
        }}
      />,
    );
    expect(captured).toBeUndefined();
  });

  it("returns the value supplied by OpenAPIPreloadProvider", () => {
    const value = { docs: { metagraph: { openapi: "3.1.0" } }, proxyUrl: "/api/v1/proxy" };
    let captured: unknown;
    renderToStaticMarkup(
      <OpenAPIPreloadProvider value={value}>
        <Probe
          onValue={(v) => {
            captured = v;
          }}
        />
      </OpenAPIPreloadProvider>,
    );
    expect(captured).toBe(value);
  });
});
