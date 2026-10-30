/** The sync workflow forwards only enumerated privacy rule names; every copy must match what the gate can emit. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/pm-github-sync.yml", import.meta.url), "utf8");
const gate = readFileSync(new URL("../gate.ts", import.meta.url), "utf8");

test("every rule-name allowlist in the sync workflow equals the rule names the gate emits", () => {
  // Each allowlist is a `|` alternation that starts with the first secret rule; the shell sites differ only in grep flags.
  const lists = [...workflow.matchAll(/github-token-classic(?:\|[a-z0-9-]+)+/g)].map((match) => match[0].split("|").sort());
  const emitted = [...new Set([...gate.matchAll(/rule: "([a-z0-9-]+)"/g)].map((match) => match[1]))].sort();
  assert.equal(lists.length, 3, "failure report, failure_rules step and alert job each filter rule names");
  assert.ok(emitted.length >= 19, `gate.ts rule literals: ${emitted.join(",")}`);
  for (const list of lists) assert.deepEqual(list, emitted);
});
