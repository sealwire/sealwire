import globals from "globals";

// Minimal lint pass focused on catching the class of bug that slips past
// `vite build`: free/undefined identifiers (e.g. a stray `session` reference
// that only throws `ReferenceError` at render time). esbuild happily emits
// undefined globals, so `no-undef` is the cheap static guard CI was missing.
//
// We deliberately keep the rule set tiny — this is a correctness tripwire, not
// a style gate. Add more rules only when there's appetite to clean the noise.
export default [
  {
    ignores: [
      "web/**",
      "node_modules/**",
      "target/**",
      "dist*/**",
      "**/*.min.js",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    rules: {
      "no-undef": "error",
    },
  },
];
