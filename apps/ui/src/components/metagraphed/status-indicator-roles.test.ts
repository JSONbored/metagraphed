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

// #8249: hero-subnet-chips.tsx (the "chip marquee") was retired along with
// the rest of the home page's auto-scrolling/rail elements -- its role="img"
// health-dot entry goes with it. #11612 retired resource-explorer.tsx with
// the subnet dossier's tab bar, taking the blocked-URL span with it. One site
// remains, and it still exercises the pattern this suite exists to pin.
const SITES: Array<[string, string, string]> = [
  [
    "providers.index (official-provider badge)",
    "../../routes/-providers-index-page.tsx",
    'aria-label="Official provider"',
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

describe("colour-only status indicators expose their label", () => {
  for (const [name, file, label] of SITES) {
    it(`${name} carries role="img" beside its aria-label`, () => {
      const el = elementCarrying(read(file), label);
      expect(el).toContain('role="img"');
      expect(el).toContain(label);
    });
  }

  it("matches ui-kit HealthDot, the established pattern for this visual", () => {
    // HealthDot is the reference the issue cites: role + aria-label (the prose
    // `title` went with #11606 -- identifiers are the only titles now).
    const healthDot = read("../../../../../packages/ui-kit/src/components/metagraphed/chips.tsx");
    expect(healthDot).toContain('role="img"');

    const el = elementCarrying(
      read("../../routes/-providers-index-page.tsx"),
      'aria-label="Official provider"',
    );
    expect(el).toContain('role="img"');
  });
});
