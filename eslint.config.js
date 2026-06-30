import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      // Build-time Node scripts (e.g. model download) — run by Docker/Node, not app source
      "**/scripts/**",
    ],
  },
  // JS recommended base
  js.configs.recommended,
  // TypeScript recommended (non-type-checked, for speed)
  ...tseslint.configs.recommended,
  {
    rules: {
      // Downgrade to warn: too noisy for a first-pass gate without type info
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow unused vars that start with _ (common pattern for ignored params)
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-unused-vars": "off", // handled by @typescript-eslint/no-unused-vars
    },
  },
  // React hook rules for the web app (rules-of-hooks is an error; missing-dep
  // warnings are surfaced but don't fail the gate).
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
