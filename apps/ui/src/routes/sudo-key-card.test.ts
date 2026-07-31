import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8818: SudoKeyCard handled `isPending` but not `isError` on sudoKeyQuery, so a
// failed RPC fell through to the same `<span>Unset</span>` branch as a genuinely
// renounced root key -- "Unset" is a specific governance claim (the sudo key has
// been renounced), not a neutral placeholder, and rendering it from a failed query
// is a false factual claim about the chain. Fix phases the query via statPhase()
// and only reaches "Unset" from a resolved response whose hotkey is nullish, with
// a caption explaining what "Unset" means so it doesn't read as a UI placeholder.
//
// `/sudo` composes TanStack Router/Query context a rendered test can't easily stand
// up, so this suite is node-environment source assertions, mirroring
// subnets-total-stake-tile.test.ts's own convention.
const source = readFileSync(
  fileURLToPath(new URL("./-sudo-index-page.tsx", import.meta.url)),
  "utf8",
);

const card = source.slice(
  source.indexOf("export function SudoKeyCard"),
  source.indexOf("export function SudoTable"),
);

describe("/sudo SudoKeyCard (#8818)", () => {
  it("consults statPhase for the sudo key query", () => {
    expect(card).toContain("statPhase(keyResult)");
  });

  it("renders StatUnavailable on error instead of falling through to Unset", () => {
    expect(card).toContain('phase === "error"');
    expect(card).toContain("<StatUnavailable");
  });

  it("Unset is reachable only from the ready branch, and is captioned", () => {
    const readyBranch = card.slice(card.indexOf(") : hotkey ? ("));
    expect(readyBranch).toContain("<span>Unset</span>");
    expect(card).toContain("renounced");
  });

  it("suppresses the queried-at caption when the query is not ready", () => {
    expect(card).toContain('phase === "ready" && queriedAt');
  });
});
