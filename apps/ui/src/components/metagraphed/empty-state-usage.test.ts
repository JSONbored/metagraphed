import { describe, expect, it } from "vitest";
import { EMPTY_STATE_COMPONENT_RULES, emptyStateComponentFor } from "./empty-state-usage";

describe("empty-state-usage", () => {
  it("documents all three components", () => {
    expect(Object.keys(EMPTY_STATE_COMPONENT_RULES).sort()).toEqual([
      "EmptyState",
      "RegistryEmpty",
      "TableState",
    ]);
  });

  it("maps UI contexts to the correct component", () => {
    expect(emptyStateComponentFor("inline-section")).toBe("EmptyState");
    expect(emptyStateComponentFor("data-table")).toBe("TableState");
    expect(emptyStateComponentFor("registry-catalog")).toBe("RegistryEmpty");
  });
});
