/** Ensure the repo configuration enforces the requested source syntax policy. */
import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";
import config from "../eslint.config.js";

test("canonical ESLint configuration rejects any, inline imports, and non-erasable syntax", async () => {
  assert.ok(config.length > 0);
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
  for (const source of ["type Unsafe = any;", "const dependency = await import('./dependency.ts');",
    "type Inline = import('./dependency.ts').Result;", "enum Color { Red, Blue }"]) {
    const [result] = await eslint.lintText(source, { filePath: "policy-fixture.ts" });
    assert.ok(result!.messages.some(message => message.ruleId === "no-restricted-syntax"), source);
  }
  const [valid] = await eslint.lintText("export const source: string = 'checked';", { filePath: "policy-fixture.ts" });
  assert.equal(valid!.errorCount, 0);
});
