import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isSubnetWindow, SubnetWindowProvider, useSubnetWindow } from "./subnet-window";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => searchState.search,
}));

const searchState: { search: Record<string, unknown> } = {
  search: {},
};

afterEach(() => {
  navigate.mockReset();
  searchState.search = {};
});

function Probe({ onValue }: { onValue: (value: ReturnType<typeof useSubnetWindow>) => void }) {
  onValue(useSubnetWindow());
  return null;
}

describe("isSubnetWindow", () => {
  it("accepts the documented window values", () => {
    expect(isSubnetWindow("7d")).toBe(true);
    expect(isSubnetWindow("30d")).toBe(true);
    expect(isSubnetWindow("90d")).toBe(true);
  });

  it("rejects invalid inputs", () => {
    expect(isSubnetWindow("1d")).toBe(false);
    expect(isSubnetWindow("")).toBe(false);
    expect(isSubnetWindow(30)).toBe(false);
    expect(isSubnetWindow(null)).toBe(false);
    expect(isSubnetWindow(undefined)).toBe(false);
  });
});

describe("useSubnetWindow", () => {
  it("falls back to 30d with a no-op setter outside a provider", () => {
    let captured: ReturnType<typeof useSubnetWindow> | undefined;
    renderToStaticMarkup(
      <Probe
        onValue={(v) => {
          captured = v;
        }}
      />,
    );
    expect(captured?.window).toBe("30d");
    expect(() => captured?.setWindow("7d")).not.toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("reads a valid ?window= value from the provider", () => {
    searchState.search = { window: "7d" };
    let captured: ReturnType<typeof useSubnetWindow> | undefined;
    renderToStaticMarkup(
      <SubnetWindowProvider>
        <Probe
          onValue={(v) => {
            captured = v;
          }}
        />
      </SubnetWindowProvider>,
    );
    expect(captured?.window).toBe("7d");
  });

  it("uses defaultWindow when search.window is invalid", () => {
    searchState.search = { window: "1d" };
    let captured: ReturnType<typeof useSubnetWindow> | undefined;
    renderToStaticMarkup(
      <SubnetWindowProvider defaultWindow="90d">
        <Probe
          onValue={(v) => {
            captured = v;
          }}
        />
      </SubnetWindowProvider>,
    );
    expect(captured?.window).toBe("90d");
  });
});
