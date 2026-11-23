/** Resolve the published progressive-only SDK from the disposable consumer. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PM_GITHUB_TEST_LEGACY_SDK_ROOT;
assert.ok(root, "The admission fixture must install its own SDK");
const parentURL = pathToFileURL(join(root, "package.json")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, /^@unbrained\/pm-cli(?=\/|$)/.test(specifier) ? { ...context, parentURL } : context);
  },
});
