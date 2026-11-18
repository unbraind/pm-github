/** Resolve the published deferral-aware SDK before loading the fixture or importer. */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.replace(/^@unbrained\/pm-cli(?=\/|$)/, "pm-cli-deferrals"), context);
  },
});
