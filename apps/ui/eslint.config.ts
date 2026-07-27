import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Bone & Ink guardrails — see CONTRIBUTING.md.
// Spacing scale allowed in raw utilities: 4pt subset.
const ALLOWED_SPACE = "0|px|0\\.5|1|1\\.5|2|2\\.5|3|4|6|8|10|12|16|20|24";
const SPACE_UTILS = "p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y";
const RAW_SPACING_REGEX = new RegExp(
  `\\b(?:${SPACE_UTILS})-(?!(?:${ALLOWED_SPACE})\\b)(?:\\[[^\\]]+\\]|[0-9]+(?:\\.[0-9]+)?)\\b`,
);
const RAW_TEXT_ARBITRARY = /\btext-\[[^\]]+\]/;

const BASE_DESIGN_RULES = [
  {
    selector:
      "Literal[value=/\\b(?:bg|text|border|from|to|via|ring|fill|stroke|decoration|outline|shadow|divide|placeholder|caret|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\\b/]",
    message:
      "Use semantic Bone & Ink tokens (bg-paper, text-ink-strong, bg-health-ok, text-accent-text, …) instead of raw Tailwind palette colors. See CONTRIBUTING.md.",
  },
  {
    selector: "Literal[value=/\\bfont-(?:bold|extrabold|black)\\b/]",
    message:
      "Bone & Ink caps font-weight at 600. Use font-medium or font-semibold — never bold/extrabold/black.",
  },
  {
    // Anchored to the whole literal (a bare hex value, e.g. a theme-color meta
    // string) or Tailwind's `[#...]` arbitrary-value bracket syntax -- NOT a
    // bare `\b#[0-9a-f]{3,8}\b` scan, which false-positives on GitHub issue
    // references embedded in prose strings (test descriptions, tooltip copy,
    // JSDoc-in-string), e.g. "...(#6424)..." reads as a 4-digit hex color to
    // an unanchored regex. A 2026-07-23 audit found 26 of 27 "hits" were this
    // exact false positive; only the real one (an unavoidable meta theme-color
    // literal, __root.tsx) survives this tightened match.
    selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$|\\[#[0-9a-fA-F]{3,8}\\]/]",
    message:
      "No raw hex colors in className / string literals. Author new colors in OKLCH in packages/ui-kit/src/styles.css.",
  },
  {
    selector: "Literal[value=/\\btop-14\\b|\\btop-\\[3\\.5rem\\]/]",
    message:
      "Do not hardcode sticky offsets. Use style={{ top: 'var(--mg-sticky-offset)' }} so the header height stays authoritative.",
  },
];

// Steer contributors to the extracted primitives instead of hand-rolling the
// same shells. These rules only fire outside the primitives folder + design
// showcase.
const PRIMITIVE_STEER_RULES = [
  {
    // Scoped to plain `<div>`/`<section>` className literals only -- an
    // unscoped `Literal[value=/regex/]` (the original form of this rule)
    // matched the same rounded/border/bg-card substrings on buttons, `<a>`/
    // `<Link>` nav pills, `<input>` fields, and existing styled components
    // (e.g. `<StatTile className="rounded-2xl border-border/80 bg-card/95 ...">`,
    // which already owns its own card rendering) -- none of those are the
    // hand-rolled content-shell divs this rule exists to catch. Also excludes
    // `mg-card-glow`/`mg-card-glow-accent` (packages/ui-kit/src/styles.css)
    // matches -- that's a real, already-documented soft-elevation variant for
    // detail-page panels (#6398), not drift; <Panel> has no glow variant to
    // migrate it to. A 2026-07-23 audit found the unscoped selector's false
    // positives outnumbered genuine hits roughly 3-to-1.
    selector:
      "JSXOpeningElement[name.name=/^(?:div|section)$/] JSXAttribute[name.name='className'] Literal[value=/\\brounded\\b.*\\bborder\\b.*\\bbg-card\\b|\\bborder\\b.*\\bbg-card\\b.*\\brounded\\b/][value!=/mg-card-glow/]",
    message:
      "Wrap card shells in <Panel> from '@/components/metagraphed/primitives' instead of re-authoring rounded/border/bg-card by hand.",
  },
  {
    selector:
      "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='target'][value.value='_blank']",
    message:
      "Use <ExternalLink> from '@jsonbored/ui-kit' — it sets rel=noreferrer, the external-icon, and safeExternalUrl filtering automatically.",
  },
];

// SSR footguns — see docs/ssr-safety.md.
const SSR_SAFETY_RULES = [
  {
    selector:
      "CallExpression[callee.name='useState'] > ArrowFunctionExpression Identifier[name='localStorage']",
    message:
      "Reading localStorage in a useState initializer hydration-mismatches. Read inside useEffect and setState from there. See docs/ssr-safety.md.",
  },
  {
    selector:
      "CallExpression[callee.name='useState'] > ArrowFunctionExpression Identifier[name='matchMedia']",
    message:
      "Reading matchMedia in a useState initializer hydration-mismatches. Read inside useEffect. See docs/ssr-safety.md.",
  },
];

const SPACING_TYPE_RULES = [
  {
    selector: `Literal[value=/${RAW_SPACING_REGEX.source}/]`,
    message:
      "Raw spacing outside the 4pt subset. Use --mg-space-* tokens or the Panel/primitives (see CONTRIBUTING.md).",
  },
  {
    selector: `Literal[value=/${RAW_TEXT_ARBITRARY.source}/]`,
    message:
      "Bare arbitrary text sizes are drift. Use <SectionLabel>, <Chip>, or the .mg-type-* utilities.",
  },
];

// #7840: the 13 raw shadow-[…] values found across both packages collapsed
// into a named --mg-shadow-* elevation scale (packages/ui-kit/src/styles.css).
// Negative-lookahead excludes the token-referencing form itself
// (shadow-[var(--mg-shadow-…)]) so the rule doesn't flag the fix.
const ELEVATION_RULES = [
  {
    selector: "Literal[value=/\\bshadow-\\[(?!var\\(--mg-shadow)/]",
    message: "Raw shadow value. Use one of the --mg-shadow-* elevation tokens (see styles.css).",
  },
];

// #7841: bare z-* stacking steps collapsed into a named --mg-z-* layer scale
// (packages/ui-kit/src/styles.css). Also flags the 6 documented z-[1]/z-[2]
// sticky-cell micro-stacking exceptions in the two compare drawers -- that's
// intentional (matches the residual-worklist convention other guardrails use).
const Z_INDEX_RULES = [
  {
    selector: "Literal[value=/\\bz-(\\[[0-9]+\\]|[0-9]+\\b)/]",
    message: "Raw z-index step. Use one of the --mg-z-* layer tokens (see styles.css).",
  },
];

// #7842: ad-hoc bg-card/NN opacity fractions collapsed into two named
// surface-translucency tiers (styles.css): .mg-glass (the sticky-header/
// drawer-shell blur idiom) and .mg-glass-soft (flat 60%, no blur). A small,
// documented set of sites couldn't cleanly snap to either tier and were left
// as bare fractions with an inline comment -- those will still warn here,
// same residual-worklist convention the other token rules already use.
const GLASS_SURFACE_RULES = [
  {
    selector: "Literal[value=/\\bbg-card\\/[0-9]+\\b/]",
    message: "Raw bg-card opacity. Use .mg-glass or .mg-glass-soft (see styles.css).",
  },
];

// #7843: `rounded-sm`/`rounded-lg` were eliminated (snapped to `rounded` /
// `rounded-md`) and `rounded-3xl` was never used -- the approved 5-step scale
// is rounded-full / rounded (base) / rounded-md / rounded-xl / rounded-2xl
// (the last confined to the homepage hero family and the documented
// .mg-card-glow detail-page panel pattern, #6398 -- see CONTRIBUTING.md's
// radius table). Arbitrary `rounded-[…]` is flagged too, except the
// documented dense-grid micro-radius residual (heatmap/mosaic/uptime-bar
// cells at 1-2px, far below any named step) -- those still warn here rather
// than getting a file exemption, same residual-worklist convention as the
// z-index rule's compare-drawer sites.
const RADIUS_RULES = [
  {
    // Message deliberately avoids spelling out the banned classes as
    // contiguous "rounded-X" tokens -- doing so would self-match this same
    // selector inside this config file (a real 2026-07-24 false positive).
    selector: "Literal[value=/\\brounded-(?:sm|lg|3xl)\\b/]",
    message:
      "This radius step was eliminated from the approved scale. Use rounded (base), rounded-md, rounded-xl, or rounded-2xl (hero/mg-card-glow only) -- see CONTRIBUTING.md.",
  },
  {
    // Same self-match hazard as above -- the message avoids a literal
    // bracket-closed "rounded-[...]" example.
    selector: "Literal[value=/\\brounded-\\[[^\\]]+\\]/]",
    message:
      "Arbitrary bracketed radius value outside the approved scale. Use rounded-full, rounded, rounded-md, rounded-xl, or rounded-2xl -- see CONTRIBUTING.md.",
  },
];

// #8255 visual grammar. Unlike the token rules above -- which encode "which
// value" -- this encodes "how much": how loud a page is allowed to be.
//
// It joins FULL_DESIGN_RULES and inherits that severity: warn in src/**, error
// in RATCHETED_DIRS. `no-restricted-syntax` carries one severity for all its
// selectors, so there is no way to run this at error while the token worklist
// stays at warn -- visual-grammar-guardrails.test.ts does that job instead,
// failing CI outright on any occurrence anywhere in either package.
//
// The companion accent-budget rule is deliberately NOT here. Telling a
// legitimate accent data mark (a bar sized `width: ${pct}%`, a sparkline
// stroke, an 8px legend swatch) from a full-bleed region fill needs the
// element's className, which a `style` -> Property -> Literal selector can't
// reach -- a first attempt flagged all three of those as violations. The test
// file makes that distinction with line context instead.
const VISUAL_GRAMMAR_RULES = [
  {
    // #8325 label diet. mg-type-micro is 9.5px mono UPPERCASE with 0.18em
    // tracking -- reserved for table headers and provenance chips, where a
    // label is structural furniture the eye skips. Used on a section heading
    // or an eyebrow it turns every heading into a shout, which is what made
    // pages read as loud even though the tokens themselves are calm.
    //
    // Scoped to the element set the sweep covered, and excludes className
    // values containing `rounded-full`: that's the chip/pill family, which
    // keeps micro legitimately (34 sites). th/thead/td/tr aren't listed at
    // all, so table headers are safe by construction rather than by
    // exception.
    selector:
      "JSXOpeningElement[name.name=/^(?:span|div|button|Link|dt|p|a|label|ExternalLink|CommandShortcut)$/] JSXAttribute[name.name='className'] Literal[value=/\\bmg-type-micro\\b/][value!=/rounded-full/]",
    message:
      "mg-type-micro is for table headers and provenance chips only (#8325). Section labels and eyebrows use mg-type-caption / <SectionLabel> / <SectionHeading>.",
  },
  {
    // Auto-scrolling text is unreadable, unpausable, and steals attention from
    // whatever the reader actually came for. No markup referenced the marquee
    // any more -- .mg-ticker-track had zero consumers and .mg-ticker is a
    // plain user-scrollable row -- so what survived was dead CSS keeping the
    // pattern one className away. This change deletes it and this rule keeps
    // it deleted.
    selector:
      "Literal[value=/\\b(?:animate-marquee|animate-scroll|mg-marquee|mg-ticker-track)\\b/]",
    message:
      "No marquees or auto-scrolling strips (#8255). Give the reader a static list, or a scroll container they control.",
  },
];

// The full Bone & Ink rule set applied to src/**/*.{ts,tsx} (the "warn" block
// below) -- named so the #7851 ratchet block can apply the identical set at
// "error" without duplicating the array.
const FULL_DESIGN_RULES = [
  ...BASE_DESIGN_RULES,
  ...SPACING_TYPE_RULES,
  ...PRIMITIVE_STEER_RULES,
  ...SSR_SAFETY_RULES,
  ...ELEVATION_RULES,
  ...Z_INDEX_RULES,
  ...GLASS_SURFACE_RULES,
  ...RADIUS_RULES,
  ...VISUAL_GRAMMAR_RULES,
];

// #7851: one-way lint ratchet. A directory enters this list only once it's
// been verified at 0 Bone & Ink warnings (no-restricted-syntax) -- from that
// point on, new drift in the directory fails CI instead of only annotating
// it. Any PR that brings a directory to 0 warnings MUST add it here in the
// same PR (see CONTRIBUTING.md); removing an entry requires an issue
// explaining why. Initial set (2026-07-24 audit): src/hooks/** was the only
// apps/ui directory clean end-to-end -- src/lib/** came close (2 residual
// hits: one real text-[11px] and one false-positive string-literal match on
// unrelated test fixture data) and is left for a follow-up PR rather than
// bundled here.
const RATCHETED_DIRS = ["src/hooks/**/*.{ts,tsx}"];

export default tseslint.config(
  // .source is fumadocs-mdx's generated content collection output (see
  // source.config.ts) -- codegen, not authored code, same treatment as dist.
  { ignores: ["dist", ".output", ".vinxi", ".source"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // ON, matching the root config. It was "off" purely because the Vite/
      // Lovable scaffold shipped it that way when the UI came into the
      // monorepo (#3190) -- combined with tsconfig's noUnusedLocals:false that
      // left this package with NO unused-code detection at all, so an
      // imported-but-never-rendered component was invisible to build, lint and
      // review. Enabling it surfaced a subnet-detail share affordance and a
      // homepage chart that had been silently orphaned (#8294).
      // argsIgnorePattern keeps deliberate signature placeholders legal.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Bone & Ink design-system guardrails. See CONTRIBUTING.md.
      // "warn", not "error": a full-codebase audit (2026-07-23) found 2177
      // pre-existing violations across 201 files -- tightening to "error" now
      // would block every unrelated PR. Fix incrementally as each file is
      // touched (the Lovable-sync route-sweep batches do this naturally);
      // revisit "error" once a file/directory is verified clean.
      "no-restricted-syntax": ["warn", ...BASE_DESIGN_RULES],
    },
  },
  {
    // Full guardrail set — layered on top of the base rules for every source
    // file. The primitives folder, design showcase, vendor-adjacent snapshot,
    // and the two files below authoritatively define or unavoidably need raw
    // values are excluded. Contributors adding new drift must reach for
    // --mg-space-* or the primitives instead. See CONTRIBUTING.md.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/components/metagraphed/primitives/**",
      "src/routes/design.primitives.tsx",
      // -design-primitives-page.tsx (#7850): the showcase page's actual
      // content, moved out of design.primitives.tsx so that file exports
      // only Route (fast-refresh compliance) -- same authoritative-raw-
      // values exemption as its route file above.
      "src/routes/-design-primitives-page.tsx",
      // The one agreed `var(--health-*, <fallback-hex>)` CSS-fallback source of
      // truth (#3458) -- these are inert fallback values for a custom-property
      // reference, not classNames, and must stay literal hex by construction.
      "src/lib/health-tokens.ts",
      // Server-rendered OG image HTML string (satori/workers-og) -- no CSS
      // cascade or custom properties reach this renderer, so literal colors
      // are unavoidable here.
      "src/lib/og-image.ts",
    ],
    rules: {
      // "warn" for the same reason as the base block above -- see its comment.
      "no-restricted-syntax": ["warn", ...FULL_DESIGN_RULES],
    },
  },
  {
    // #7851: promotes the ratcheted directories above from warn to error.
    // Layered after the warn-tier block so it wins for files in both (flat
    // config's last-matching-block-wins semantics); the off-exclusion blocks
    // below stay last so primitives/showcase/health-tokens/og-image keep
    // their existing exemption unchanged even if a ratcheted glob ever
    // overlapped one of them.
    files: RATCHETED_DIRS,
    rules: {
      "no-restricted-syntax": ["error", ...FULL_DESIGN_RULES],
    },
  },
  {
    files: [
      "src/routes/design.primitives.tsx",
      "src/routes/-design-primitives-page.tsx",
      "src/components/metagraphed/primitives/**",
      "src/lib/health-tokens.ts",
      "src/lib/og-image.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // shadcn/ui primitives co-export their `cva` variants, and our leaf
    // components co-export tightly-coupled helpers/hooks (prefetchBrandIcon,
    // safeExternalUrl, useActiveTab). That co-location is intentional here; this
    // fast-refresh-only rule stays ON for routes, where a file should export just
    // its route.
    files: ["src/components/**/*.{ts,tsx}"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // These three lib/ files are React context modules: the provider
    // component and its useXCtx/useX hook both need direct access to the
    // same module-private createContext() value, so the hook can't move to
    // a sibling file without exporting the context object itself (#7850).
    files: [
      "src/lib/metagraphed/api-source-context.tsx",
      "src/lib/metagraphed/subnet-window.tsx",
      "src/lib/metagraphed/value-unit.tsx",
    ],
    rules: { "react-refresh/only-export-components": "off" },
  },
  eslintPluginPrettier,
);
