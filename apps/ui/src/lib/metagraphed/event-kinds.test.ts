import { describe, expect, it } from "vitest";

import {
  EVENT_KIND_CATEGORIES,
  eventKindCategory,
  eventKindCategoryLabel,
  eventKindLabel,
} from "./event-kinds";

describe("eventKindCategory", () => {
  it("maps known kinds to the same categories as account-events.mjs", () => {
    expect(eventKindCategory("StakeAdded")).toBe("stake");
    expect(eventKindCategory("AxonServed")).toBe("serving");
    expect(eventKindCategory("Transfer")).toBe("transfer");
    expect(Object.keys(EVENT_KIND_CATEGORIES)).toHaveLength(25);
  });

  it("returns other for unknown or missing kinds", () => {
    expect(eventKindCategory(null)).toBe("other");
    expect(eventKindCategory("")).toBe("other");
    expect(eventKindCategory("FutureEventKind")).toBe("other");
  });

  it("treats Object prototype property names as unknown kinds", () => {
    expect(eventKindCategory("__proto__")).toBe("other");
    expect(eventKindCategory("constructor")).toBe("other");
    expect(eventKindCategory("toString")).toBe("other");
  });
});

describe("eventKindLabel", () => {
  it("returns human-readable labels for known kinds", () => {
    expect(eventKindLabel("NeuronRegistered")).toBe("Neuron registered");
    expect(eventKindLabel("StakeTransferred")).toBe("Stake transferred");
    expect(eventKindLabel("PrometheusServed")).toBe("Prometheus served");
  });

  it("falls back to spaced CamelCase for unknown kinds", () => {
    expect(eventKindLabel("CustomSubnetEvent")).toBe("Custom Subnet Event");
  });

  it("falls back for Object prototype property names", () => {
    expect(eventKindLabel("__proto__")).toBe("__proto__");
    expect(eventKindLabel("constructor")).toBe("Constructor");
    expect(eventKindLabel("toString")).toBe("To String");
  });

  it("returns a stable placeholder for missing kinds", () => {
    expect(eventKindLabel(null)).toBe("Unknown event");
  });
});

describe("eventKindCategoryLabel", () => {
  it("returns explorer-facing category names", () => {
    expect(eventKindCategoryLabel("stake")).toBe("Stake");
    expect(eventKindCategoryLabel("other")).toBe("Other");
  });
});
