import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8818: SudoKeyCard must not claim "Unset" when sudoKeyQuery failed.
const source = readFileSync(
  fileURLToPath(new URL("./-sudo-index-page.tsx", import.meta.url)),
  "utf8",
);

const card = source.slice(
  source.indexOf("export function SudoKeyCard"),
  source.indexOf("export function SudoIndexPage") === -1
    ? source.length
    : source.indexOf("export function SudoIndexPage"),
);

describe("sudo SudoKeyCard (#8818)", () => {
  it("phases the key through statPhase and renders StatUnavailable on error", () => {
    expect(card).toContain("statPhase(keyResult)");
    expect(card).toContain("StatUnavailable");
    expect(card).toContain('phase === "error"');
  });

  it("only reaches Unset on a ready response with a nullish hotkey", () => {
    expect(card).toMatch(/phase === "error"[\s\S]*Unset/);
    expect(card).toContain("root key renounced");
  });
});
