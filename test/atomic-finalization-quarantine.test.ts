/** Keep the two SDK finalization waivers bounded to the verified broken pins. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

// This is the waiver allowlist, not a claim that every other SDK has the API.
// Unverified versions must execute the compensation assertions again.
const versions = [
  ["2026.10.17", false], ["2026.10.25", false], ["2026.10.26", false],
  ["2026.10.31", false], ["2026.11.1", false], ["2026.11.3", false],
  ["2026.11.4", true], ["2026.11.5", true], ["2026.11.6", true],
  ["2026.11.7", false], ["2026.12.1", false],
  ["2027.1.1", false], ["2026.11.4-next.1", false], ["unknown", false],
] as const;

for (const [file, testName, recoveryOnly] of [
  ["import-fidelity.test.ts", "real SDK atomic compensation restores an imported source lifecycle and removes new items after finalization", false],
  ["refresh.test.ts", "terminal failures remove replay plans after real SDK compensation (${recover})", true],
] as const) {
  test(`${file} quarantine re-enables compensation checks outside the verified SDK pins`, () => {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    // Execute the actual declaration and actual test option without importing
    // either module (which would register its expensive tracker tests).
    const predicates = [...source.matchAll(/^const needsOwnedFinalization = (.+);$/gm)];
    assert.equal(predicates.length, 1, "one explicit SDK quarantine predicate");
    const start = source.indexOf(testName);
    assert.ok(start >= 0, "the intended compensation test still exists");
    const option = source.slice(start + testName.length).match(/^["`], \{\s+skip: ([^\n]+),\s*\},/);
    assert.ok(option, "evaluate the intended test's actual skip option");
    for (const [version, quarantined] of versions) {
      const needsOwnedFinalization: unknown = runInNewContext(predicates[0]![1]!, {
        readFileSync: () => JSON.stringify({ version }), join,
        root: ".", packageRoot: ".",
      });
      assert.equal(needsOwnedFinalization, quarantined, `${file}: predicate for ${version}`);
      for (const recover of [false, true]) {
        const skip: unknown = runInNewContext(option[1]!, { needsOwnedFinalization, recover });
        const expected = quarantined && (!recoveryOnly || recover);
        assert.equal(Boolean(skip), expected, `${file}: skip for ${version}, recover=${recover}`);
        if (expected) {
          assert.equal(typeof skip, "string", "quarantine must explain the upstream blocker");
          assert.match(String(skip), /pm-cli#1656/);
        }
      }
    }
  });
}
