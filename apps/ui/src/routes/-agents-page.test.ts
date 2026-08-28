import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const page = readFileSync(fileURLToPath(new URL("./-agents-page.tsx", import.meta.url)), "utf8");

describe("agents connection surface", () => {
  const connectStart = page.indexOf('id="connect"');
  const connect = page.slice(connectStart, page.indexOf('id="tools"', connectStart));

  it("keeps one clear, copyable setup command", () => {
    expect(connect).toContain('className="mg-agent-connection"');
    expect(connect).toContain("<CopyableCode");
    expect(connect).not.toContain("<RawCode");
  });

  it("identifies the MCP core handoff and its live transport", () => {
    expect(page).toContain('name="MCP"');
    expect(connect).toContain("Bittensor in a box");
    expect(connect).toContain("Recommended core endpoint");
    expect(connect).toContain("Full registry callable");
    expect(page).toContain('mcp?.transport === "streamable-http"');
    expect(page).toContain('"Streamable HTTP"');
  });
});
