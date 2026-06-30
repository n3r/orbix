import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      // Generated Next.js declaration file — uses triple-slash references by design
      "**/next-env.d.ts",
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
);
