import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "vitest";
import { registrableHostDomain } from "../scripts/lib.mjs";

describe("discover-candidates project-domain matching", () => {
  test("discover-candidates uses registrableHostDomain instead of slice(-2)", async () => {
    const source = await readFile("scripts/discover-candidates.mjs", "utf8");
    assert.match(source, /registrableHostDomain\(/);
    assert.doesNotMatch(source, /function registrableDomain\(/);
    assert.doesNotMatch(source, /slice\(-2\)\.join\("\."\)/);
  });

  test("isLikelyProjectDomain treats distinct pages.dev tenants as different sites", () => {
    const rootHost = registrableHostDomain("example.pages.dev");
    const sameTenant = registrableHostDomain("example.pages.dev");
    const otherTenant = registrableHostDomain("other.pages.dev");
    assert.equal(rootHost, sameTenant);
    assert.notEqual(rootHost, otherTenant);
  });
});
