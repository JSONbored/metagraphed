import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Bone & Ink guardrails, ported from apps/ui/eslint.config.js (2026-07-23) once
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
    // See apps/ui/eslint.config.js's identical rule for why this is anchored
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
    // apps/ui/eslint.config.js's identical rule for why an unscoped version
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

// The primitives relocated from apps/ui (2026-07-23) authoritatively define
// these patterns (Panel/SectionLabel don't wrap themselves in <Panel>, and
// external-link.tsx/table-state.tsx are known, documented exceptions -- see
// their own inline comments). Same treatment as apps/ui's primitives/
// folder + design.primitives.tsx exclusion.
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
      "no-restricted-syntax": ["warn", ...DESIGN_RULES, ...SSR_SAFETY_RULES],
    },
  },
  {
    files: PRIMITIVE_FILES,
    rules: { "no-restricted-syntax": "off" },
  },
  eslintPluginPrettier,
);
