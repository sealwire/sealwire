import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

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
      ".claude/**",
      "node_modules/**",
      "target/**",
      "src-tauri/target/**",
      // `dist*/**` only matches at the repo root; bundled output also shows up
      // nested (e.g. design/beautiful-ui/dist), and a minified React bundle
      // trips `no-undef` on things like __REACT_DEVTOOLS_GLOBAL_HOOK__.
      "dist*/**",
      "**/dist/**",
      // Gitignored maintainer scratch, like `markdown/`. CI checks out a tree
      // without it, so linting it locally only produces noise CI never sees —
      // and noise in a tripwire is how a real `no-undef` gets scrolled past.
      "design/**",
      "**/*.min.js",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    // `rules-of-hooks` earns its place by the same standard as `no-undef`: it catches a
    // correctness bug that `vite build` emits happily and that fails quietly at runtime.
    // It found a real one — an early return sitting above the hooks in ThreadGroupList,
    // so React saw zero hooks on an empty sidebar and two once sessions loaded. React
    // does not throw on that; it logs "Expected static flag was missing" and carries on
    // with corrupted hook bookkeeping, which is exactly the kind of silent fault this
    // pass exists to make loud.
    //
    // The plugin's other rules stay OFF, and that is a measurement, not an oversight:
    // `exhaustive-deps` reports 20 and the v7 `recommended-latest` set (which carries
    // the React Compiler rules) 87. As errors they would trade a green CI for a red one;
    // as warnings they would bury `no-undef` under advice. Correctness tripwire, not
    // style gate — see the header note.
    //
    // Because `exhaustive-deps` is off, an `eslint-disable` naming it is itself reported
    // as an unused directive. Explain such a dependency array in prose instead.
    plugins: { "react-hooks": reactHooks },
    rules: {
      "no-undef": "error",
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
