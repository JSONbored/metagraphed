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
    selector: "Literal[value=/#[0-9a-fA-F]{3,8}\\b/][value!=/^#$/]",
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
    selector:
      "Literal[value=/\\brounded\\b.*\\bborder\\b.*\\bbg-card\\b|\\bborder\\b.*\\bbg-card\\b.*\\brounded\\b/]",
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
      "@typescript-eslint/no-unused-vars": "off",
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
      "no-restricted-syntax": [
        "warn",
        ...BASE_DESIGN_RULES,
        ...SPACING_TYPE_RULES,
        ...PRIMITIVE_STEER_RULES,
        ...SSR_SAFETY_RULES,
      ],
    },
  },
  {
    files: [
      "src/routes/design.primitives.tsx",
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
  eslintPluginPrettier,
);
