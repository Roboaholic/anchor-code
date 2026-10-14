// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Flat config: typescript-eslint recommended (type-aware for
 * no-floating-promises), react-hooks for the renderer.
 *
 * Noisy-but-not-dangerous rules are warnings so CI gates on errors only;
 * tighten them to "error" as the warning count is burned down.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-electron/**",
      "release/**",
      "node_modules/**",
      "mobile/**",
      "relay/**",
      "scripts/**",
      "build/**",
      "public/**",
      "skills/**",
      "**/*.d.ts",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "electron/**/*.ts", "contracts/**/*.ts", "*.config.ts"],
    languageOptions: {
      parserOptions: {
        // Renderer and main/contracts use different tsconfigs (DOM vs node).
        project: ["./tsconfig.json", "./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Correctness: unhandled promises silently drop IPC/git failures.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true, ignoreIIFE: false }],
      // tsc already enforces noUnusedLocals/Parameters.
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "**/*.smoke.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
