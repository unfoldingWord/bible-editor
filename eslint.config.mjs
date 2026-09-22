// Flat ESLint config, added by issue #842 (steps 1-2, partial 3).
//
// Scope, deliberately narrow — see the issue and this PR's description:
//  - Only web/src (React) and api/src (Cloudflare Worker, no React) are
//    linted. Nothing else in the repo (scripts/, tests/, docs/, root
//    configs) is covered; this mirrors the issue's own "out of scope" list
//    and keeps `npm run lint` fast and predictable.
//  - `react-hooks/rules-of-hooks` is the only error-level rule (the issue's
//    own audit expects 0 findings on this tree; confirmed by measurement).
//  - `react-hooks/exhaustive-deps` is warn-only. The ~400 existing
//    useEffect/useMemo/useCallback call sites have not been triaged against
//    it; that triage is deliberately deferred (issue #842 step 3/4).
//  - eslint-plugin-react-hooks v7 (the plugin's current "v6-successor"
//    compiler-powered rule set: set-state-in-effect, refs, immutability,
//    purity, preserve-manual-memoization, etc.) was measured in step 1 and
//    found too noisy for this plain React 18.3 tree with no React Compiler
//    — see the issue #842 comment for full counts and reasoning. Only the
//    two classic hook rules are enabled here.
//  - No Prettier/formatting/import-order rules, no @typescript-eslint rule
//    sets beyond using its parser for TS/TSX syntax — out of scope per the
//    issue.
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

const tsLanguageOptions = {
  parser: tsParser,
  parserOptions: {
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
};

export default [
  {
    // Only lint the two application source trees. Everything else
    // (scripts/, tests/, docs/, root-level configs, build output) is
    // untouched by this config — no config object below matches them, and
    // they are listed here explicitly so `eslint .` doesn't try (and fail)
    // to parse non-source-tree TypeScript such as playwright.config.ts or
    // tests/concurrency/**.
    ignores: [
      "**/node_modules/**",
      "web/dist/**",
      "api/.wrangler/**",
      "**/*.mjs",
      "scripts/**",
      "tests/**",
      "spikes/**",
      "docs/**",
      "playwright.config.ts",
      "web/vite.config.ts",
    ],
  },
  {
    files: ["api/src/**/*.ts"],
    languageOptions: tsLanguageOptions,
    rules: {},
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: tsLanguageOptions,
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
