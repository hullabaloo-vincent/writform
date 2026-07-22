// Deliberately minimal: the payload is react-hooks/rules-of-hooks, which
// catches the hooks-after-early-return crash class that already shipped once
// (BoardRoom). Style stays tsc's + reviewers' job, not eslint's.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", "src/bindings/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // tsc already enforces these better (and with type awareness).
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // `{} as CmdError` throws-of-objects are an established pattern here.
      "@typescript-eslint/no-throw-literal": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
