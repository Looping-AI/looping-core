import { noDeprecatedObjectProperties } from "./no-deprecated-object-properties.js";

/**
 * `@dynamicagents/core/eslint` — the lint rules this stack needs that no upstream
 * plugin provides.
 *
 * Consume as a flat-config plugin:
 *
 * ```js
 * import da from "@dynamicagents/core/eslint";
 *
 * export default [
 *   {
 *     files: ["src/**\/*.ts"],
 *     plugins: { da },
 *     languageOptions: {
 *       parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
 *     },
 *     rules: { "da/no-deprecated-object-properties": "error" }
 *   }
 * ];
 * ```
 *
 * `no-deprecated-object-properties` is type-aware, so the consuming config must
 * enable `projectService` (or `project`) for it to see anything.
 */
export const rules = {
  "no-deprecated-object-properties": noDeprecatedObjectProperties
};

export default { rules };
