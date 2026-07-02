import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "vitest";
import {
  isLikelyProjectDomain,
  registrableHostDomain,
} from "../scripts/lib.mjs";

describe("discover-candidates project-domain matching", () => {
  test("discover-candidates imports shared domain helpers from lib.mjs", async () => {
    const source = await readFile("scripts/discover-candidates.mjs", "utf8");
    assert.match(source, /isLikelyProjectDomain,/);
    assert.doesNotMatch(source, /function isLikelyProjectDomain\(/);
    assert.doesNotMatch(source, /function registrableDomain\(/);
    assert.doesNotMatch(source, /slice\(-2\)\.join\("\."\)/);
  });

  test("registrableHostDomain keeps distinct pages.dev tenants separate", () => {
    assert.equal(
      registrableHostDomain("project-a.pages.dev"),
      "project-a.pages.dev",
    );
    assert.equal(
      registrableHostDomain("project-b.pages.dev"),
      "project-b.pages.dev",
    );
    assert.notEqual(
      registrableHostDomain("project-a.pages.dev"),
      registrableHostDomain("project-b.pages.dev"),
    );
  });

  test("isLikelyProjectDomain matches exact hostname and same registrable host", () => {
    assert.equal(
      isLikelyProjectDomain(
        "https://example.pages.dev/",
        "https://example.pages.dev/about",
      ),
      true,
    );
    assert.equal(
      isLikelyProjectDomain(
        "https://www.example.com/",
        "https://blog.example.com/landing",
      ),
      true,
    );
    assert.equal(
      isLikelyProjectDomain(
        "https://project-a.pages.dev/",
        "https://project-b.pages.dev/about",
      ),
      false,
    );
  });

  test("isLikelyProjectDomain rejects malformed URLs", () => {
    assert.equal(
      isLikelyProjectDomain("not-a-url", "https://example.com/"),
      false,
    );
    assert.equal(
      isLikelyProjectDomain("https://example.com/", "also-bad"),
      false,
    );
  });
});
