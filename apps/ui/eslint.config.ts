import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Design-system v2 guardrails (#11605) — see apps/ui/CONTRIBUTING.md and
// packages/ui-kit/src/styles.css. Every rule here is an ERROR in every source
// directory: the v2 contract is one family, six sizes, normal tracking, one
// radius, three rules and no resting shadow, and the token-inventory e2e
// measures the same things in the rendered page. There is no warn tier.
//
// Spacing scale allowed in raw utilities: 4pt subset.
const ALLOWED_SPACE = "0|px|0\\.5|1|1\\.5|2|2\\.5|3|4|6|8|10|12|16|20|24";
const SPACE_UTILS = "p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y";
const RAW_SPACING_REGEX = new RegExp(
  `\\b(?:${SPACE_UTILS})-(?!(?:${ALLOWED_SPACE})\\b)(?:\\[[^\\]]+\\]|[0-9]+(?:\\.[0-9]+)?)\\b`,
);

const COLOR_RULES = [
  {
    selector:
      "Literal[value=/\\b(?:bg|text|border|from|to|via|ring|fill|stroke|decoration|outline|shadow|divide|placeholder|caret|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\\b/]",
    message:
      "Use the semantic tokens (bg-canvas, bg-layer, text-ink-strong, text-ink-muted, text-good, border-rule, …) instead of raw Tailwind palette colors.",
  },
  {
    // Anchored to the whole literal (a bare hex value) or Tailwind's `[#...]`
    // arbitrary-value bracket syntax -- NOT a bare scan, which false-positives
    // on GitHub issue references in prose strings.
    selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$|\\[#[0-9a-fA-F]{3,8}\\]/]",
    message:
      "No raw hex colors in className / string literals. Author new colors as tokens in packages/ui-kit/src/styles.css.",
  },
];

// The type contract: seven sizes (text-10 … text-64), weights 400/500/600,
// no tracking, no uppercase outside <th>.
const TYPE_RULES = [
  {
    selector: "Literal[value=/\\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\\b/]",
    message:
      "Tailwind's size ramp does not exist here. Use text-10 / text-11 / text-13 / text-16 / text-28 / text-40 (text-64 on the landing h1 only).",
  },
  {
    selector: "Literal[value=/\\btext-\\[[^\\]]+\\]/]",
    message: "Arbitrary text sizes are drift. Use one of the seven text-N utilities.",
  },
  {
    selector: "Literal[value=/\\bmg-type-[a-z-]+\\b|\\bmg-label\\b/]",
    message:
      "The mg-type-* / mg-label utilities were removed (#11605). Use text-N + a colour token.",
  },
  {
    selector: "Literal[value=/\\bfont-(?:bold|extrabold|black|thin|extralight|light)\\b/]",
    message: "Weights are 400 / 500 / 600 only. Use font-normal, font-medium or font-semibold.",
  },
  {
    selector: "Literal[value=/\\btracking-/]",
    message:
      "letter-spacing is normal everywhere except <th> (which gets it from CSS). Remove the tracking-* utility.",
  },
  {
    selector:
      "JSXOpeningElement[name.name!=/^(?:th|Th)$/] JSXAttribute[name.name='className'] Literal[value=/\\buppercase\\b/]",
    message: "text-transform: uppercase is reserved for table headers (<th>, styled in CSS).",
  },
];

// One radius. Status dots are the only circles, and they carry `mg-dot`.
const RADIUS_RULES = [
  {
    selector:
      "Literal[value=/\\brounded-(?:xs|sm|md|lg|xl|[2-4]xl|t|b|l|r|tl|tr|bl|br|s|e|ss|se|es|ee)(?:-[a-z0-9]+)?\\b|\\brounded-\\[[^\\]]+\\]/]",
    message: "There is one radius: `rounded` (4px). Corner- and size-specific radii were removed.",
  },
  {
    selector: "Literal[value=/\\brounded-full\\b/][value!=/\\bmg-dot\\b/]",
    message:
      "rounded-full is only for 8×8 status dots, which carry `mg-dot` in the same className. Everything else is `rounded`.",
  },
];

// No resting shadow, no blur, no glass, no glow, no translucent surfaces.
const SURFACE_RULES = [
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
    message: "This decorative class was deleted in #11605 and must not come back.",
  },
  {
    selector: "Literal[value=/\\btop-14\\b|\\btop-\\[3\\.5rem\\]/]",
    message:
      "Do not hardcode sticky offsets. Use style={{ top: 'var(--mg-sticky-offset)' }} so the header height stays authoritative.",
  },
  {
    selector: "Literal[value=/\\bz-(\\[[0-9]+\\]|[0-9]+\\b)/]",
    message: "Raw z-index step. Use one of the --mg-z-* layer tokens (see styles.css).",
  },
];

// No perpetual motion, no transforms on hover.
const MOTION_RULES = [
  {
    selector:
      "Literal[value=/\\b(?:animate-marquee|animate-scroll|mg-marquee|mg-ticker-track|animate-bounce|animate-ping)\\b/]",
    message:
      "No perpetual decorative animation. Loading feedback uses the skeleton shimmer (animate-pulse) or a spinner (animate-spin) only.",
  },
  {
    selector:
      "Literal[value=/\\b(?:hover|group-hover|focus|focus-visible|active):(?:-?translate-[xy]?-|scale-|rotate-)/]",
    message: "Hover never moves or scales an element. Change colour, background or border only.",
  },
];

const SPACING_RULES = [
  {
    selector: `Literal[value=/${RAW_SPACING_REGEX.source}/]`,
    message: "Raw spacing outside the 4pt subset. Use --mg-space-* tokens or the primitives.",
  },
];

// Steer contributors to the extracted primitives instead of hand-rolling the
// same shells.
const PRIMITIVE_STEER_RULES = [
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

const DESIGN_RULES = [
  ...COLOR_RULES,
  ...TYPE_RULES,
  ...RADIUS_RULES,
  ...SURFACE_RULES,
  ...MOTION_RULES,
  ...SPACING_RULES,
  ...PRIMITIVE_STEER_RULES,
  ...SSR_SAFETY_RULES,
];

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
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // The design contract, at error tier, for every source file. The only
    // exemptions are the two files that must carry literal colours because no
    // CSS cascade reaches them.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/health-tokens.ts", "src/lib/og-image.ts", "src/lib/og-image.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...DESIGN_RULES],
    },
  },
  {
    files: [
      // The one agreed `var(--health-*, <fallback-hex>)` CSS-fallback source of
      // truth (#3458) -- inert fallback values for a custom-property reference.
      "src/lib/health-tokens.ts",
      // The OG card is rasterized by satori on the Worker, where CSS custom
      // properties do not exist -- every colour has to ship as a literal.
      "src/lib/og-image.ts",
      "src/lib/og-image.test.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // shadcn/ui primitives co-export their `cva` variants, and our leaf
    // components co-export tightly-coupled helpers/hooks. That co-location is
    // intentional here; this fast-refresh-only rule stays ON for routes.
    files: ["src/components/**/*.{ts,tsx}"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // React context modules: the provider component and its hook both need
    // the same module-private createContext() value (#7850).
    files: [
      "src/lib/metagraphed/api-source-context.tsx",
      "src/lib/metagraphed/subnet-window.tsx",
      "src/lib/metagraphed/value-unit.tsx",
    ],
    rules: { "react-refresh/only-export-components": "off" },
  },
  eslintPluginPrettier,
);
