import { noDeprecatedObjectProperties } from "./no-deprecated-object-properties.js";

/**
 * `@loopingai/core/eslint` — the lint rules this stack needs that no upstream
 * plugin provides.
 *
 * Consume as a flat-config plugin:
 *
 * ```js
 * import looping from "@loopingai/core/eslint";
 *
 * export default [
 *   {
 *     files: ["src/**\/*.ts"],
 *     plugins: { looping },
 *     languageOptions: {
 *       parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
 *     },
 *     rules: { "looping/no-deprecated-object-properties": "error" }
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
