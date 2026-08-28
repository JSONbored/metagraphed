import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const homepage = readFileSync(fileURLToPath(new URL("./-index-page.tsx", import.meta.url)), "utf8");
const styles = readFileSync(
  fileURLToPath(new URL("../../../../packages/ui-kit/src/styles.css", import.meta.url)),
  "utf8",
);
const homeStyles = styles.slice(
  styles.indexOf("Homepage operational index"),
  styles.indexOf("/* The MCP handoff"),
);

describe("homepage masthead", () => {
  const mastheadStart = homepage.indexOf('<header className="mg-home-hero"');
  const masthead = homepage.slice(
    mastheadStart,
    homepage.indexOf("<AnalyticsSection", mastheadStart),
  );

  it("keeps the concise network proposition", () => {
    expect(masthead).toContain("Bittensor, measured.");
    expect(homepage).toContain("<AppShell>");
  });

  it("makes MCP a quiet, working first-viewport handoff", () => {
    expect(masthead).toContain('className="mg-home-mcp-install"');
    expect(masthead).toContain('src="/favicon-transparent.svg"');
    expect(masthead).not.toContain("\n                        MCP\n");
    expect(masthead).toContain("<CopyableCode");
    expect(masthead).toContain('label="Install"');
    expect(masthead).toContain("value={MCP_INSTALL_COMMAND}");
    expect(masthead).not.toContain("truncate={false}");
    expect(masthead).toContain("Bittensor in a box");
    expect(homepage).toContain(
      '"claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp/core"',
    );
    expect(masthead.indexOf("<SearchBox")).toBeLessThan(
      masthead.indexOf('className="mg-home-mcp-install"'),
    );
  });

  it("makes actual explorer evidence tangible without a redundant status strip", () => {
    expect(masthead).toContain("Network allocation");
    expect(masthead).toContain("Latest daily emission.");
    expect(masthead).not.toContain('className="mg-home-status"');
    expect(masthead).not.toContain("<dt>Updated</dt>");
    expect(masthead).not.toContain("Finney network");
    expect(masthead).toContain("<LiveBlockRail");
    expect(masthead).toContain("<LiveBlockRail\n                  compact");
    expect(masthead.indexOf("<LiveBlockRail")).toBeLessThan(
      masthead.indexOf('className="mg-home-pulse-foot"'),
    );
    expect(homepage).toContain("blocksQuery({ limit: LIVE_BLOCK_LIMIT })");
    expect(homepage).toContain("enabled: heroBlockRailEnabled");
    expect(homepage).toContain("useRefetchInterval(15_000, heroBlockRailEnabled)");
    expect(homepage).toContain(
      'value: typeof headBlock === "number" ? formatNumber(headBlock) : "—"',
    );
    for (const route of ["/validators", "/chain", "/apis"]) {
      expect(masthead).toContain(`to="${route}"`);
    }
  });

  it("uses data colour and structure instead of homepage gradients", () => {
    expect(homeStyles).not.toMatch(/(?:linear|radial)-gradient/);
    expect(homepage).toContain('className="mg-home-dot-field"');
    expect(masthead).toContain("CompositionBreakdown");
    expect(homeStyles).toContain("var(--agent)");
  });
});
