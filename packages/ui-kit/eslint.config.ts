import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Design-system v2 guardrails (#11605), kept in sync with
// apps/ui/eslint.config.ts -- if one changes, change the other. Every rule is
// an error everywhere: the contract is one family, six sizes, normal tracking,
// one radius, three rules and no resting shadow.
const ALLOWED_SPACE = "0|px|0\\.5|1|1\\.5|2|2\\.5|3|4|6|8|10|12|16|20|24";
const SPACE_UTILS =
  "p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y";
const RAW_SPACING_REGEX = new RegExp(
  `\\b(?:${SPACE_UTILS})-(?!(?:${ALLOWED_SPACE})\\b)(?:\\[[^\\]]+\\]|[0-9]+(?:\\.[0-9]+)?)\\b`,
);

const DESIGN_RULES = [
  {
    selector:
      "Literal[value=/\\b(?:bg|text|border|from|to|via|ring|fill|stroke|decoration|outline|shadow|divide|placeholder|caret|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\\b/]",
    message:
      "Use the semantic tokens (bg-canvas, bg-layer, text-ink-strong, text-ink-muted, text-good, border-rule, …) instead of raw Tailwind palette colors.",
  },
  {
    // wordmark.tsx's fixed brand-mint fill is this package's one legitimate,
    // permanent exception (a logo mark must not shift with the theme tokens).
    selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$|\\[#[0-9a-fA-F]{3,8}\\]/]",
    message:
      "No raw hex colors in className / string literals / SVG fill attributes. Author new colors as tokens in src/styles.css.",
  },
  {
    selector: "Literal[value=/\\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\\b/]",
    message:
      "Tailwind's size ramp does not exist here. Use text-10 / text-11 / text-13 / text-16 / text-28 / text-40.",
  },
  {
    selector: "Literal[value=/\\btext-\\[[^\\]]+\\]/]",
    message:
      "Arbitrary text sizes are drift. Use one of the seven text-N utilities.",
  },
  {
    selector: "Literal[value=/\\bmg-type-[a-z-]+\\b|\\bmg-label\\b/]",
    message:
      "The mg-type-* / mg-label utilities were removed (#11605). Use text-N + a colour token.",
  },
  {
    selector:
      "Literal[value=/\\bfont-(?:bold|extrabold|black|thin|extralight|light)\\b/]",
    message:
      "Weights are 400 / 500 / 600 only. Use font-normal, font-medium or font-semibold.",
  },
  {
    selector: "Literal[value=/\\btracking-/]",
    message:
      "letter-spacing is normal everywhere except <th> (which gets it from CSS). Remove the tracking-* utility.",
  },
  {
    selector:
      "JSXOpeningElement[name.name!=/^(?:th|Th)$/] JSXAttribute[name.name='className'] Literal[value=/\\buppercase\\b/]",
    message:
      "text-transform: uppercase is reserved for table headers (<th>, styled in CSS).",
  },
  {
    selector:
      "Literal[value=/\\brounded-(?:xs|sm|md|lg|xl|[2-4]xl|t|b|l|r|tl|tr|bl|br|s|e|ss|se|es|ee)(?:-[a-z0-9]+)?\\b|\\brounded-\\[[^\\]]+\\]/]",
    message:
      "There is one radius: `rounded` (4px). Corner- and size-specific radii were removed.",
  },
  {
    selector: "Literal[value=/\\brounded-full\\b/][value!=/\\bmg-dot\\b/]",
    message:
      "rounded-full is only for 8×8 status dots, which carry `mg-dot` in the same className. Everything else is `rounded`.",
  },
  {
    selector:
      "Literal[value=/(?<![\\w-])(?:drop-)?shadow-(?!\\[var\\(--mg-shadow-tooltip\\)\\])[a-z0-9\\[\\(\\)\\.\\-]+/]",
    message:
      "No resting shadows. The only shadow is the floating tooltip's --mg-shadow-tooltip (applied by the tooltip primitive).",
  },
  {
    selector:
      "Literal[value=/\\bbackdrop-blur|\\bsupports-\\[backdrop-filter\\]|\\bmg-glass|\\bmg-card-glow/]",
    message:
      "Glass, blur and glow surfaces were removed (#11605). Use bg-canvas / bg-layer / bg-raised.",
  },
  {
    selector:
      "Literal[value=/\\bbg-(?:card|paper|surface|canvas|layer|raised|popover)\\/[0-9]+\\b/]",
    message:
      "Surfaces are opaque. Use bg-canvas / bg-layer / bg-raised without an opacity fraction.",
  },
  {
    selector:
      "Literal[value=/\\b(?:mg-quick-tile|mg-reveal|mg-scanline|mg-eyebrow-rot|mg-metric-tile|mg-dot-grid|mg-leaderboard|mg-lb-|mg-chip-rail|mg-glyph-rule|mg-section-rule|mg-display-tight|mg-fade-in|mg-route-enter|mg-row-flash|mg-flash-|mg-ticker|mg-mega-|mg-pulse(?![\\w-]))/]",
    message:
      "This decorative class was deleted in #11605 and must not come back.",
  },
  {
    selector:
      "Literal[value=/\\b(?:animate-marquee|animate-scroll|mg-marquee|mg-ticker-track|animate-bounce|animate-ping)\\b/]",
    message:
      "No perpetual decorative animation. Loading feedback uses the skeleton shimmer (animate-pulse) or a spinner (animate-spin) only.",
  },
  {
    selector:
      "Literal[value=/\\b(?:hover|group-hover|focus|focus-visible|active):(?:-?translate-[xy]?-|scale-|rotate-)/]",
    message:
      "Hover never moves or scales an element. Change colour, background or border only.",
  },
  {
    selector: `Literal[value=/${RAW_SPACING_REGEX.source}/]`,
    message:
      "Raw spacing outside the 4pt subset. Use --mg-space-* tokens or the primitives.",
  },
  {
    selector:
      "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='target'][value.value='_blank']",
    message:
      "Use <ExternalLink> (./external-link) — it sets rel=noreferrer, the external-icon, and safeExternalUrl filtering automatically.",
  },
  {
    selector: "Literal[value=/\\bz-(\\[[0-9]+\\]|[0-9]+\\b)/]",
    message:
      "Raw z-index step. Use one of the --mg-z-* layer tokens (see styles.css).",
  },
  {
    selector: "Literal[value=/\\btop-14\\b|\\btop-\\[3\\.5rem\\]/]",
    message:
      "Do not hardcode sticky offsets. Use style={{ top: 'var(--mg-sticky-offset)' }} so the header height stays authoritative.",
  },
];

// SSR footguns -- see apps/ui/docs/ssr-safety.md. ui-kit's own components
// only ever render inside apps/ui's TanStack Start SSR tree.
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
      // either, accept the data/navigation as a prop from the caller instead.
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
                "packages/ui-kit must never import from apps/ui -- that's the app-context leak this package exists to prevent.",
            },
          ],
        },
      ],
    },
  },
  {
    // The design contract, at error tier, for every source file in this
    // package. This file lints itself too: the selector strings below contain
    // the banned tokens by necessity, so the config is excluded.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...DESIGN_RULES, ...SSR_SAFETY_RULES],
    },
  },
  {
    // external-link.tsx implements the <ExternalLink> pattern the steer rule
    // points at; wordmark.tsx carries the one fixed brand fill (a logo mark
    // must not shift with the theme tokens).
    files: [
      "src/components/metagraphed/external-link.tsx",
      "src/components/metagraphed/wordmark.tsx",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  eslintPluginPrettier,
);
