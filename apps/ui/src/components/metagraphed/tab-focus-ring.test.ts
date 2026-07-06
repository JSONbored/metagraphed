import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ProfileTabs reads URL state via router hooks; stub them so the component
// can be rendered in isolation (no RouterProvider needed for a markup check).
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  useSearch: () => ({}),
}));

import { EndpointKindTabs } from "./endpoint-kind-tabs";
import { ProfileTabs } from "./profile-tabs";

// Guards the accessibility fix (#3451): both tab strips must keep the shared
// `mg-focus-ring` utility so keyboard focus stays visible. A refactor that
// drops the class from either component's classNames() call fails here.
describe("tab focus ring", () => {
  it("EndpointKindTabs button carries mg-focus-ring", () => {
    const html = renderToStaticMarkup(
      createElement(EndpointKindTabs, {
        value: "all",
        counts: { all: 3, api: 2 },
        onChange: () => {},
      }),
    );
    expect(html).toContain("mg-focus-ring");
  });

  it("ProfileTabs button carries mg-focus-ring", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileTabs, {
        tabs: [{ id: "overview", label: "Overview" }],
        defaultTab: "overview",
      }),
    );
    expect(html).toContain("mg-focus-ring");
  });
});
