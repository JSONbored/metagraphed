import { describe, expect, it } from "vitest";
import { hasValidatorIdentity } from "./validator-identity";
import type { ColdkeyIdentity } from "./types";

const base: ColdkeyIdentity = {
  has_identity: false,
  name: null,
  url: null,
  github: null,
  image: null,
  discord: null,
  description: null,
  additional: null,
  captured_at: null,
};

describe("hasValidatorIdentity", () => {
  it("is true when the coldkey declares an identity with a name", () => {
    expect(hasValidatorIdentity({ ...base, has_identity: true, name: "Foundry" })).toBe(true);
  });

  it("is false when there is no declared identity", () => {
    expect(hasValidatorIdentity({ ...base, has_identity: false, name: "Foundry" })).toBe(false);
  });

  it("is false when the identity is declared but has no usable name", () => {
    expect(hasValidatorIdentity({ ...base, has_identity: true, name: null })).toBe(false);
    expect(hasValidatorIdentity({ ...base, has_identity: true, name: "" })).toBe(false);
    expect(hasValidatorIdentity({ ...base, has_identity: true, name: "   " })).toBe(false);
  });

  it("is false for null/undefined identity", () => {
    expect(hasValidatorIdentity(null)).toBe(false);
    expect(hasValidatorIdentity(undefined)).toBe(false);
  });
});
