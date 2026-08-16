// Resolve hook so a test can import a REAL application module that uses
// bundler-style extensionless specifiers (`from "./dcsSources"`).
//
// The api sources are compiled by Wrangler/esbuild, which resolves those
// happily; Node's ESM loader does not, so any test that wants to drive real
// application code — rather than re-implementing it — needs this. The pure-module
// tests in this directory sidestep it by importing only `./x.ts` specifiers.
//
// Usage:
//   node --experimental-strip-types --import ./src/tsResolveHook.mjs src/<file>.test.mjs
//
// Deliberately narrow: only RELATIVE specifiers that have no extension and
// resolve to an existing `.ts` file are rewritten. Everything else falls through
// untouched, so this cannot mask a genuinely missing module.

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(specifier) && context.parentURL) {
      const target = fileURLToPath(new URL(specifier, context.parentURL));
      for (const ext of [".ts", ".mjs", ".js"]) {
        if (existsSync(target + ext)) {
          return { url: pathToFileURL(target + ext).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
