import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6423: three colour-only status indicators carried their meaning in an
// aria-label on a plain <span>. A span is role="generic", and AT is not required
// to expose a generic element's aria-label as its accessible name — so the
// health/official/blocked states could announce as nothing at all. ui-kit's
// HealthDot already does this correctly (role="img" + aria-label + title) for
// the identical visual.
//
// Source assertions rather than a render: these spans sit deep inside components
// that need a router and live data, and this suite is node-environment. The
// repo already tests this way (see ui-kit's list-shell.test.ts).
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const SITES: Array<[string, string, string]> = [
  [
    "hero-subnet-chips (subnet health dot)",
    "./hero-subnet-chips.tsx",
    "aria-label={`health ${health}`}",
  ],
  [
    "providers.index (official-provider badge)",
    "../../routes/providers.index.tsx",
    'aria-label="Official provider"',
  ],
  [
    "resource-explorer (blocked unsafe URL)",
    "./resource-explorer.tsx",
    'aria-label="Blocked unsafe endpoint URL"',
  ],
];

/** The element opening tag containing `label`, so role/aria stay paired. */
function elementCarrying(source: string, label: string) {
  const at = source.indexOf(label);
  expect(at, `fixture drift: ${label} not found`).toBeGreaterThan(-1);
  const open = source.lastIndexOf("<span", at);
  const close = source.indexOf(">", at);
  return source.slice(open, close);
}

describe("colour-only status indicators expose their label (#6423)", () => {
  for (const [name, file, label] of SITES) {
    it(`${name} carries role="img" beside its aria-label`, () => {
      const el = elementCarrying(read(file), label);
      expect(el).toContain('role="img"');
      expect(el).toContain(label);
    });
  }

  it("matches ui-kit HealthDot, the established pattern for this visual", () => {
    // HealthDot is the reference the issue cites: role + label + title together.
    const healthDot = read("../../../../../packages/ui-kit/src/components/metagraphed/chips.tsx");
    expect(healthDot).toContain('role="img"');

    const el = elementCarrying(read("./hero-subnet-chips.tsx"), "aria-label={`health ${health}`}");
    expect(el).toContain("title=");
  });

  it("the blocked-URL state has no other AT-reachable carrier, so the role matters", () => {
    // Both other "Blocked unsafe URL" strings are TooltipContent (hover/focus
    // only) and this span is deliberately not focusable, unlike its safeUrl <a>
    // sibling — so the aria-label is the only thing a screen reader can reach.
    const source = read("./resource-explorer.tsx");
    expect(source).toContain('{safeUrl ? "Open in new tab" : "Blocked unsafe URL"}');
    const el = elementCarrying(source, 'aria-label="Blocked unsafe endpoint URL"');
    expect(el).not.toContain("tabIndex");
    expect(el).toContain('role="img"');
  });
});
