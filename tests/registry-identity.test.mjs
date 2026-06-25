import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  normalizeGitHubLogin,
  ownerTokensMatch,
  ownerTokensRelated,
  providerIdentityTokens,
  urlOwnerTokens,
} from "../scripts/registry-identity.mjs";

// Owner-token matching guards the candidate→surface promotion in
// scripts/generated-overlays.mjs: an ownership-sensitive community surface is
// only promoted when its URL owner relates to its declared provider. These are
// the adversarial cases the helpers must hold (carried over from the retired
// submission preflight, which these helpers outlived).
describe("registry-identity owner-token + login helpers", () => {
  test("urlOwnerTokens extracts code-host org, domain label, and tolerates junk", () => {
    assert.deepEqual(
      urlOwnerTokens("https://github.com/safe-scan-ai/cancer-ai"),
      ["safescanai"],
    );
    assert.deepEqual(urlOwnerTokens("https://status.all-ways.io/x"), [
      "allways",
    ]);
    assert.deepEqual(urlOwnerTokens("https://attacker.uc.r.appspot.com/api"), [
      "attacker",
    ]);
    assert.deepEqual(urlOwnerTokens("https://abc.gitlab.io/api"), ["abc"]);
    assert.deepEqual(urlOwnerTokens("not a url"), []);
    assert.deepEqual(urlOwnerTokens(42), []);
    // a sub-4-char org is filtered out
    assert.deepEqual(urlOwnerTokens("https://github.com/ab/repo"), []);
  });

  test("providerIdentityTokens pulls name/id/url tokens, empty for missing provider", () => {
    const tokens = providerIdentityTokens({
      id: "luminar-network",
      name: "Luminar Network",
      website_url: "https://luminar.network/",
    });
    assert.equal(tokens.includes("luminarnetwork"), true);
    assert.equal(tokens.includes("luminar"), true);
    assert.deepEqual(providerIdentityTokens(null), []);
    assert.deepEqual(providerIdentityTokens("nope"), []);
  });

  test("ownerTokensRelated: exact OR >=8-char containment, never short substrings", () => {
    assert.equal(ownerTokensRelated("luminarnetwork", "luminarnetwork"), true); // exact
    assert.equal(ownerTokensRelated("tensorplexlabs", "tensorplex"), true); // 10-char containment
    assert.equal(ownerTokensRelated("sn76mirror", "sn76"), false); // short token, no substring match
    assert.equal(ownerTokensRelated("visiontools", "vision"), false); // 6-char, no substring match
    assert.equal(ownerTokensRelated("", "luminar"), false); // empty guard
    assert.equal(ownerTokensRelated("luminar", ""), false);
  });

  test("ownerTokensMatch: empty set is non-blocking; otherwise any related pair matches", () => {
    assert.equal(ownerTokensMatch([], ["byzantium"]), true);
    assert.equal(ownerTokensMatch(["safescanai"], []), true);
    assert.equal(
      ownerTokensMatch(["luminarnetwork"], ["luminarnetwork", "luminar"]),
      true,
    );
    assert.equal(
      ownerTokensMatch(["safescanai"], ["byzantium", "byzantiumai"]),
      false,
    );
  });

  test("normalizeGitHubLogin strips @, profile URL, trailing slash, and lower-cases", () => {
    assert.equal(normalizeGitHubLogin("@JSONbored"), "jsonbored");
    assert.equal(
      normalizeGitHubLogin("https://github.com/JSONbored/"),
      "jsonbored",
    );
    assert.equal(normalizeGitHubLogin("plainlogin"), "plainlogin");
    assert.equal(normalizeGitHubLogin(""), "");
    assert.equal(normalizeGitHubLogin(null), "");
  });
});
