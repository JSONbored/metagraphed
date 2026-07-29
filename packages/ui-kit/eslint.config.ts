import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Bone & Ink guardrails, ported from apps/ui/eslint.config.ts (2026-07-23) once
// <Panel>/<SectionLabel>/etc. relocated here — see CONTRIBUTING.md. Kept in
// sync with apps/ui's copy; if one changes, check the other.
const ALLOWED_SPACE = "0|px|0\\.5|1|1\\.5|2|2\\.5|3|4|6|8|10|12|16|20|24";
const SPACE_UTILS =
  "p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y";
const RAW_SPACING_REGEX = new RegExp(
  `\\b(?:${SPACE_UTILS})-(?!(?:${ALLOWED_SPACE})\\b)(?:\\[[^\\]]+\\]|[0-9]+(?:\\.[0-9]+)?)\\b`,
);
const RAW_TEXT_ARBITRARY = /\btext-\[[^\]]+\]/;

const DESIGN_RULES = [
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
    // See apps/ui/eslint.config.ts's identical rule for why this is anchored
    // to a bare hex literal or Tailwind's `[#...]` bracket syntax rather than
    // an unanchored `#[0-9a-f]{3,8}` scan (false-positives on GitHub issue
    // refs in prose strings). wordmark.tsx's fixed brand-mint fill is this
    // package's one legitimate, permanent exception (a logo mark must not
    // shift with the OKLCH theme tokens the way UI colors do).
    selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$|\\[#[0-9a-fA-F]{3,8}\\]/]",
    message:
      "No raw hex colors in className / string literals / SVG fill attributes. Author new colors in OKLCH in packages/ui-kit/src/styles.css.",
  },
  {
    selector: `Literal[value=/${RAW_SPACING_REGEX.source}/]`,
    message:
      "Raw spacing outside the 4pt subset. Use --mg-space-* tokens or the Panel/primitives (see CONTRIBUTING.md).",
  },
  {
    selector: `Literal[value=/${RAW_TEXT_ARBITRARY.source}/]`,
    message:
      "Bare arbitrary text sizes are drift. Use <SectionLabel> or the .mg-type-* utilities.",
  },
  {
    // Scoped to plain <div>/<section> className literals only -- see
    // apps/ui/eslint.config.ts's identical rule for why an unscoped version
    // false-positives on buttons/links/inputs and existing styled components.
    // Excludes mg-card-glow (a distinct soft-elevation variant, not drift).
    selector:
      "JSXOpeningElement[name.name=/^(?:div|section)$/] JSXAttribute[name.name='className'] Literal[value=/\\brounded\\b.*\\bborder\\b.*\\bbg-card\\b|\\bborder\\b.*\\bbg-card\\b.*\\brounded\\b/][value!=/mg-card-glow/]",
    message:
      "Wrap card shells in <Panel> (./panel) instead of re-authoring rounded/border/bg-card by hand.",
  },
  {
    selector:
      "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='target'][value.value='_blank']",
    message:
      "Use <ExternalLink> (./external-link) — it sets rel=noreferrer, the external-icon, and safeExternalUrl filtering automatically.",
  },
  {
    // #7840: the 13 raw shadow-[…] values found across both packages
    // collapsed into a named --mg-shadow-* elevation scale (styles.css).
    // Negative-lookahead excludes the token-referencing form itself
    // (shadow-[var(--mg-shadow-…)]) so the rule doesn't flag the fix.
    selector: "Literal[value=/\\bshadow-\\[(?!var\\(--mg-shadow)/]",
    message:
      "Raw shadow value. Use one of the --mg-shadow-* elevation tokens (see styles.css).",
  },
  {
    // #7841: bare z-* stacking steps collapsed into a named --mg-z-* layer
    // scale (styles.css). Also flags the 6 documented z-[1]/z-[2] sticky-cell
    // micro-stacking exceptions -- intentional, matches the residual-worklist
    // convention the shadow rule above already uses.
    selector: "Literal[value=/\\bz-(\\[[0-9]+\\]|[0-9]+\\b)/]",
    message:
      "Raw z-index step. Use one of the --mg-z-* layer tokens (see styles.css).",
  },
  {
    // #7842: ad-hoc bg-card/NN opacity fractions collapsed into two named
    // surface-translucency tiers (styles.css): .mg-glass (the sticky-header/
    // drawer-shell blur idiom) and .mg-glass-soft (flat 60%, no blur).
    selector: "Literal[value=/\\bbg-card\\/[0-9]+\\b/]",
    message:
      "Raw bg-card opacity. Use .mg-glass or .mg-glass-soft (see styles.css).",
  },
  {
    // #7843: rounded-sm/rounded-lg were eliminated (snapped to rounded /
    // rounded-md) and rounded-3xl was never used -- see
    // apps/ui/CONTRIBUTING.md's radius table for the approved 5-step scale.
    // Message deliberately avoids spelling out the banned classes as
    // contiguous "rounded-X" tokens -- doing so would self-match this same
    // selector inside this config file (a real 2026-07-24 false positive).
    selector: "Literal[value=/\\brounded-(?:sm|lg|3xl)\\b/]",
    message:
      "This radius step was eliminated from the approved scale. Use rounded (base), rounded-md, rounded-xl, or rounded-2xl (hero/mg-card-glow only) -- see apps/ui/CONTRIBUTING.md.",
  },
  {
    // Arbitrary bracketed radius outside the scale. The dense-grid
    // micro-radius sites (heatmap/mosaic/uptime-bar cells at 1-2px) still
    // warn here rather than getting a file exemption -- same
    // residual-worklist convention the z-index rule's compare-drawer sites
    // already use. Message avoids a literal bracket-closed example (same
    // self-match hazard as above).
    selector: "Literal[value=/\\brounded-\\[[^\\]]+\\]/]",
    message:
      "Arbitrary bracketed radius value outside the approved scale. Use rounded-full, rounded, rounded-md, rounded-xl, or rounded-2xl -- see apps/ui/CONTRIBUTING.md.",
  },
  {
    // #8555: ported verbatim from apps/ui/eslint.config.ts so ui-kit components,
    // which render inside apps/ui where these are banned, cannot introduce them
    // with no signal. ui-kit/src currently has zero occurrences -- prospective.
    selector: "Literal[value=/\\btop-14\\b|\\btop-\\[3\\.5rem\\]/]",
    message:
      "Do not hardcode sticky offsets. Use style={{ top: 'var(--mg-sticky-offset)' }} so the header height stays authoritative.",
  },
  {
    // Unlike apps/ui (which scopes DESIGN_RULES to src/**), this package lints its
    // own eslint.config.ts under **/*.{ts,tsx}, so this rule's verbatim selector
    // string -- which literally contains the banned tokens -- self-matches on the
    // line below. Suppress that one self-reference; the rule itself is unchanged
    // and still fires on any real component usage.
    selector:
      // eslint-disable-next-line no-restricted-syntax
      "Literal[value=/\\b(?:animate-marquee|animate-scroll|mg-marquee|mg-ticker-track)\\b/]",
    message:
      "No marquees or auto-scrolling strips (#8255). Give the reader a static list, or a scroll container they control.",
  },
];

// SSR footguns -- see apps/ui/docs/ssr-safety.md. ui-kit's own components
// only ever render inside apps/ui's TanStack Start SSR tree, so the same
// hydration-mismatch risk applies here even though ui-kit itself has no
// server. Ported alongside DESIGN_RULES 2026-07-24 (missed in the initial
// guardrail port).
const SSR_SAFETY_RULES = [
  {
    selector:
      "CallExpression[callee.name='useState'] > ArrowFunctionExpression Identifier[name='localStorage']",
    message:
      "Reading localStorage in a useState initializer hydration-mismatches. Read inside useEffect and setState from there.",
  },
  {
    selector:
      "CallExpression[callee.name='useState'] > ArrowFunctionExpression Identifier[name='matchMedia']",
    message:
      "Reading matchMedia in a useState initializer hydration-mismatches. Read inside useEffect.",
  },
];

// #8325 label diet, ported verbatim from apps/ui/eslint.config.ts's
// VISUAL_GRAMMAR_RULES (#8557 -- the sweep never reached this package).
// mg-type-micro is 9.5px mono UPPERCASE with 0.18em tracking -- reserved for
// table headers and provenance chips, where a label is structural furniture
// the eye skips. Scoped to the element set the sweep covered, and excludes
// className values containing `rounded-full` (the chip/pill family keeps
// micro legitimately); th/thead/td/tr aren't listed at all, so table headers
// are safe by construction rather than by exception. PRIMITIVE_FILES below
// keep their blanket no-restricted-syntax exemption, matching the ratchet.
const VISUAL_GRAMMAR_RULES = [
  {
    selector:
      "JSXOpeningElement[name.name=/^(?:span|div|button|Link|dt|p|a|label|ExternalLink|CommandShortcut)$/] JSXAttribute[name.name='className'] Literal[value=/\\bmg-type-micro\\b/][value!=/rounded-full/]",
    message:
      "mg-type-micro is for table headers and provenance chips only (#8325). Section labels and eyebrows use mg-type-caption / <SectionLabel> / <SectionHeading>.",
  },
];

// The primitives relocated from apps/ui (2026-07-23) authoritatively define
// these patterns (Panel/SectionLabel don't wrap themselves in <Panel>, and
// external-link.tsx/table-state.tsx are known, documented exceptions -- see
// their own inline comments). Same treatment as apps/ui's primitives/
// folder + design.primitives.tsx exclusion.
// #7851: one-way lint ratchet. A directory enters this list only once it's
// been verified at 0 Bone & Ink warnings (no-restricted-syntax) -- from that
// point on, new drift in the directory fails CI instead of only annotating
// it. Any PR that brings a directory to 0 warnings MUST add it here in the
// same PR (see apps/ui/CONTRIBUTING.md); removing an entry requires an issue
// explaining why. Initial set (2026-07-24 audit): src/hooks/** and src/lib/**
// were the only ui-kit directories clean end-to-end -- src/components/** was
// not (19 of 109 files warned). #8172 cleaned 16 of those 19; the remaining
// 3 files (see RATCHETED_COMPONENT_EXCEPTIONS below) each keep one genuinely
// missing token, so src/components/** ratchets everywhere except them rather
// than staying un-ratcheted repo-wide over 3 residual sites.
const RATCHETED_DIRS = ["src/hooks/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"];

// Excluded from the src/components/** ratchet below -- each still carries one
// no-restricted-syntax warning with no existing design-system-token
// equivalent (not invented ad hoc per #8172's own guidance):
// - entity-hero.tsx / page-hero.tsx: the "display"-size hero <h1> and its
//   KPI-strip value use text-[2.5rem]/text-[1.75rem] -- the mg-type-* scale
//   tops out at mg-type-caption-lg (13px, see styles.css); no hero/display
//   heading tier is authored yet (--mg-type-h1..h4 are reserved CSS
//   variables, not yet exposed as .mg-type-h* utility classes).
// - section-anchor.tsx: `scroll-mt-32` compensates for the sticky header's
//   pixel height on anchor scroll, not a spacing-scale choice -- the exact
//   same site class #7810 already left unconverted elsewhere (see that
//   commit's own "endpoint-detail-drawer.tsx ... scroll-mt-32" note).
const RATCHETED_COMPONENT_EXCEPTIONS = [
  "src/components/metagraphed/entity-hero.tsx",
  "src/components/metagraphed/page-hero.tsx",
  "src/components/metagraphed/section-anchor.tsx",
];

const PRIMITIVE_FILES = [
  "src/components/metagraphed/panel.tsx",
  "src/components/metagraphed/panel-header.tsx",
  "src/components/metagraphed/panel-skeleton.tsx",
  "src/components/metagraphed/panel-error.tsx",
  "src/components/metagraphed/section-label.tsx",
  "src/components/metagraphed/chip.tsx",
  "src/components/metagraphed/status-badge.tsx",
  "src/components/metagraphed/indicator.tsx",
  "src/components/metagraphed/empty-state.tsx",
  "src/components/metagraphed/table-skeleton.tsx",
  "src/components/metagraphed/chart-skeleton.tsx",
  "src/components/metagraphed/metric-grid.tsx",
  "src/components/metagraphed/definition-list.tsx",
  "src/components/metagraphed/divider.tsx",
  "src/components/metagraphed/tab-strip.tsx",
  "src/components/metagraphed/sticky-toolbar.tsx",
  "src/components/metagraphed/loading-pill.tsx",
  "src/components/metagraphed/ghost-button.tsx",
  "src/components/metagraphed/pager-footer.tsx",
  "src/components/metagraphed/meta-strip.tsx",
  "src/components/metagraphed/scroll-shadow.tsx",
  "src/components/metagraphed/responsive-table.tsx",
  "src/components/metagraphed/filter-sheet.tsx",
  "src/components/metagraphed/page-actions.tsx",
  "src/components/metagraphed/mobile-collapse.tsx",
  "src/components/metagraphed/readiness-gauge.tsx",
  "src/components/metagraphed/provenance-chip.tsx",
  "src/components/metagraphed/query-bar.tsx",
  "src/components/metagraphed/query-progress.tsx",
  "src/components/metagraphed/filter-chip-row.tsx",
  "src/components/metagraphed/route-pending.tsx",
  "src/components/metagraphed/column-customizer.tsx",
  "src/components/metagraphed/filter-toolbar.tsx",
  "src/components/metagraphed/external-link.tsx",
  "src/components/metagraphed/table-state.tsx",
  "src/components/metagraphed/wordmark.tsx",
];

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": "off",
      // The whole point of packages/ui-kit is that it's a real, standalone,
      // dependency-free library (#4867). These two packages are apps/ui's
      // routing/data-fetching infrastructure -- if a component here needs
      // either, accept the data/navigation as a prop from the caller
      // instead (see packages/ui-kit/README.md).
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@tanstack/react-router",
              message:
                "packages/ui-kit must stay app-agnostic -- accept navigation/URLs as props instead of importing router infrastructure.",
            },
            {
              name: "@tanstack/react-query",
              message:
                "packages/ui-kit must stay app-agnostic -- accept fetched data as props instead of importing query infrastructure.",
            },
          ],
          patterns: [
            {
              group: ["**/apps/ui/**", "**/apps/ui"],
              message:
                "packages/ui-kit must never import from apps/ui -- that's the app-context leak this package exists to prevent. Duplicate the needed pure logic into packages/ui-kit instead (see src/lib/format.ts for the established pattern).",
            },
          ],
        },
      ],
      // "warn", not "error" -- matching apps/ui's own rationale: fix
      // incrementally as files are touched, don't block unrelated PRs.
      "no-restricted-syntax": [
        "warn",
        ...DESIGN_RULES,
        ...SSR_SAFETY_RULES,
        ...VISUAL_GRAMMAR_RULES,
      ],
    },
  },
  {
    // #7851: promotes the ratcheted directories above from warn to error.
    // Layered after the warn-tier block above so it wins for files in both
    // (flat config's last-matching-block-wins semantics); the PRIMITIVE_FILES
    // off-exclusion block below stays last so those files keep their existing
    // exemption unchanged even if a ratcheted glob ever overlapped one.
    files: RATCHETED_DIRS,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...DESIGN_RULES,
        ...SSR_SAFETY_RULES,
        ...VISUAL_GRAMMAR_RULES,
      ],
    },
  },
  {
    // #8172: src/components/** joins the ratchet -- every file is clean
    // except the 3 in RATCHETED_COMPONENT_EXCEPTIONS (documented above),
    // which `ignores` keeps at the warn tier from the block above instead
    // of failing CI on their one pre-existing, genuinely-missing-token site.
    files: ["src/components/**/*.{ts,tsx}"],
    ignores: RATCHETED_COMPONENT_EXCEPTIONS,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...DESIGN_RULES,
        ...SSR_SAFETY_RULES,
        ...VISUAL_GRAMMAR_RULES,
      ],
    },
  },
  {
    files: PRIMITIVE_FILES,
    rules: { "no-restricted-syntax": "off" },
  },
  eslintPluginPrettier,
);
