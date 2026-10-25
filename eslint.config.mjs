// ESLint flat config. Type-checked rules over the TypeScript sources that
// tsconfig.json covers (src/); the build script and bundles stay out -- the
// bundle is generated, and esbuild.js is exercised by every compile anyway.
// Run via `npm run lint`.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "out/**",
      "node_modules/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
      "**/*.d.ts",
      ".vscode-test/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/test/**/*.ts"],
    rules: {
      // The node:test suites spawn servers, timers and fake daemons on
      // purpose; awaiting every teardown promise there would blur what is
      // actually under test, and fake HTTP handlers stay async-shaped for
      // uniformity with the ones that do await.
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
);
