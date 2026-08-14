import { describe, expect, it } from "vitest";

import { robotsBody } from "./server";

// #11002. These assert CRAWL BEHAVIOUR, not the text of the file. A substring
// check ("does the body contain Disallow: /accounts/") passes just as happily on
// a rule set whose precedence is backwards, and precedence is the whole
// difference between withholding 8.8M block pages and de-indexing the site.

/**
 * Does one robots.txt rule pattern match `path`?
 *
 * Only the two forms this file emits: a plain prefix, and RFC 9309's `$`
 * end-anchor. No `*` — nothing here uses one, and implementing a wildcard the
 * production file never emits would be testing fiction.
 */
function ruleMatches(pattern: string, path: string): boolean {
  return pattern.endsWith("$") ? path === pattern.slice(0, -1) : path.startsWith(pattern);
}

/**
 * RFC 9309 §2.2.2 evaluation: the most specific (longest) matching rule wins;
 * on a tie, Allow wins; if nothing matches, the path is allowed.
 */
function isCrawlable(body: string, path: string): boolean {
  let best: { length: number; allow: boolean } = { length: -1, allow: true };
  for (const line of body.split("\n")) {
    const match = /^(Allow|Disallow):\s*(\S+)$/.exec(line.trim());
    if (!match) continue;
    const [, kind, pattern] = match;
    if (!ruleMatches(pattern, path)) continue;
    const allow = kind === "Allow";
    if (pattern.length > best.length || (pattern.length === best.length && allow)) {
      best = { length: pattern.length, allow };
    }
  }
  return best.allow;
}

const CANONICAL = robotsBody("metagraph.sh");

describe("apex robots.txt withholds only the unbounded spaces (#11002)", () => {
  it("keeps the registry surfaces crawlable — the posture is still allow-all", () => {
    for (const path of [
      "/",
      "/subnets",
      "/subnets/64",
      "/apis",
      "/apis/endpoints",
      "/docs/economics",
      "/providers/opentensor",
      "/health",
      "/status",
    ]) {
      expect(isCrawlable(CANONICAL, path), path).toBe(true);
    }
  });

  it("withholds per-block, per-extrinsic and per-account detail", () => {
    for (const path of [
      "/blocks/8544380",
      "/blocks/0x093fa22c78426e23dd70e69ab9403f792b125b289402fe67f19f96af9392dd0a",
      "/extrinsics/0x58e19156f8fdadbf60f70aaf664e80aa80c9ebb705dffe6a919048798c5c7af0",
      "/accounts/5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    ]) {
      expect(isCrawlable(CANONICAL, path), path).toBe(false);
    }
  });

  // The regression this pair exists to catch: the hub indexes live one segment
  // away from the withheld detail routes and are the pages actually worth
  // ranking. A `Disallow: /chain/` slip, or dropping the `$` from the accounts
  // re-allow, silently de-indexes them.
  it("leaves the hub indexes and the accounts index itself crawlable", () => {
    for (const path of [
      "/chain",
      "/chain/blocks",
      "/chain/extrinsics",
      "/chain/events",
      "/accounts",
      "/accounts/",
    ]) {
      expect(isCrawlable(CANONICAL, path), path).toBe(true);
    }
  });

  it("advertises its own sitemap", () => {
    expect(CANONICAL).toContain("Sitemap: https://metagraph.sh/sitemap.xml");
  });
});

describe("non-canonical hosts are withheld whole (#11002)", () => {
  // testnet.metagraph.sh is served by this same Worker; #9004 found the
  // account's workers.dev subdomain serving the entire site in parallel too.
  const TESTNET = robotsBody("testnet.metagraph.sh");

  it("blocks every path, including the ones the apex publishes", () => {
    for (const path of ["/", "/subnets", "/chain/blocks", "/accounts", "/docs"]) {
      expect(isCrawlable(TESTNET, path), path).toBe(false);
    }
  });

  it("advertises NO sitemap — a robots.txt may only point at its own host", () => {
    expect(TESTNET).not.toContain("Sitemap:");
  });

  it("treats an unrecognised host as non-canonical, so a new one fails closed", () => {
    // The #9004 class: a hostname nobody added to an allowlist should not become
    // indexable just by existing.
    for (const host of [
      "metagraphed-ui.zeronode.workers.dev",
      "preview.metagraph.sh",
      "metagraph.sh.evil.example",
    ]) {
      expect(isCrawlable(robotsBody(host), "/subnets"), host).toBe(false);
    }
  });

  it("still allows the apex itself — the guard is exact-host, not a prefix", () => {
    expect(isCrawlable(robotsBody("metagraph.sh"), "/subnets")).toBe(true);
  });

  it("the canonical host declares the Content Signals", () => {
    const body = robotsBody("metagraph.sh");
    expect(body).toMatch(/^Content-Signal: search=yes, ai-input=yes, ai-train=yes$/m);
    // And the non-canonical duplicate does not: it disallows everything, and a
    // usage signal on a host nobody may crawl is noise.
    expect(robotsBody("other.example")).not.toContain("Content-Signal");
  });
});
