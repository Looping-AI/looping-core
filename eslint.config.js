import tseslint from "typescript-eslint";
import da from "./eslint-rules/index.js";

const LINTED_FILES = ["src/**/*.ts", "test/**/*.ts"];

export default tseslint.config(
  {
    extends: [...tseslint.configs.recommended],
    files: LINTED_FILES,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-unused-expressions": "off",
      // The Agents SDK's `this.sql`…`` statements are tagged templates run for
      // their side effect (CREATE TABLE / INSERT); keep the rule for everything
      // else.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    // Type-aware pass — enables @deprecated detection without switching the
    // whole config to recommendedTypeChecked and its stricter rule set.
    files: LINTED_FILES,
    plugins: { "@typescript-eslint": tseslint.plugin, da },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
      // Covers the object-literal keys `no-deprecated` structurally cannot see —
      // i.e. every `generateText({ system: … })`-style options bag. See the rule.
      "da/no-deprecated-object-properties": "error"
    }
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      ".wrangler/",
      "worker-configuration.d.ts"
    ]
  }
);
