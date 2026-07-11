import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

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
    },
  },
  eslintPluginPrettier,
);
