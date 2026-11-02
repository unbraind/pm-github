import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as gate from "../gate.ts";
import { main, PUBLIC_FORM_MUTATIONS, runPublicFormMutationProof, type MutationSpec } from "../scripts/prove-gate-public-forms.ts";

const proofUrl = new URL("../scripts/prove-gate-public-forms.ts", import.meta.url);
const noOp: MutationSpec = {
  name: "no-op", description: "Test the proof harness without altering a rule", replacements: [],
  expectFailingAllowRows: [], expectPassingRefuseRows: [],
};

test("the real proof CLI verifies every recorded mutation", () => {
  const result = spawnSync("node", [proofUrl.pathname], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, PUBLIC_FORM_MUTATIONS.length);
  for (const mutation of PUBLIC_FORM_MUTATIONS) assert.ok(result.stdout.includes(`ok   ${mutation.name}:`));
});

test("the proof refuses unreadable source and invalid baseline corpus behavior", async () => {
  const missing = await runPublicFormMutationProof({ gateSourcePath: new URL("missing-gate.ts", import.meta.url).pathname });
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /could not read/);
  const allowFailure = await runPublicFormMutationProof({ baselineScanner: () => [{ rule: "absolute-host-path", matched: "synthetic", index: 0 }] });
  assert.equal(allowFailure.exitCode, 1);
  assert.match(allowFailure.stderr, /baseline allow row/);
  const refuseFailure = await runPublicFormMutationProof({ baselineScanner: () => [] });
  assert.equal(refuseFailure.exitCode, 1);
  assert.match(refuseFailure.stderr, /baseline refuse row/);
});

test("mutation drift, import failures and unexpected flips fail without leaking diagnostics", async t => {
  const scratch = mkdtempSync(join(tmpdir(), "pm-proof-test-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const run = (mutation: MutationSpec, importModule = async () => gate) =>
    runPublicFormMutationProof({ mutations: [mutation], scratchDirectory: scratch, importModule });
  for (const anchor of ["missing-anchor-for-test", "const "]) {
    const drift = await run({ ...noOp, replacements: [{ find: anchor, replace: "" }] });
    assert.equal(drift.exitCode, 1);
    assert.match(drift.stdout, /anchor occurs/);
  }
  const failure = await run(noOp, async () => { throw new Error("private diagnostic sentinel"); });
  assert.equal(failure.exitCode, 1);
  assert.match(failure.stdout, /mutated module failed/);
  assert.ok(!failure.stdout.includes("private diagnostic sentinel"));
  const allowDrift = await run(noOp, async () => ({ ...gate, scanLineForRuleHits: () => [{ rule: "absolute-host-path", matched: "synthetic", index: 0 }] }));
  assert.equal(allowDrift.exitCode, 1);
  assert.match(allowDrift.stdout, /flipped allow rows drifted/);
  const refuseDrift = await run(noOp, async () => ({ ...gate, scanLineForRuleHits: () => [] }));
  assert.equal(refuseDrift.exitCode, 1);
  assert.match(refuseDrift.stdout, /flipped refuse rows drifted/);
  const success = await run(noOp);
  assert.equal(success.exitCode, 0);
  assert.equal(success.stderr, "");
  assert.deepEqual(readdirSync(scratch), [], "every disposable mutation directory must be removed");
});

test("main forwards a failed proof's stderr and status and skips imports", async t => {
  const previousCode = process.exitCode;
  t.after(() => { process.exitCode = previousCode; });
  const output: string[] = [];
  t.mock.method(console, "error", (line: string) => output.push(line));
  t.mock.method(console, "log", () => assert.fail("an empty stdout must stay empty"));
  await main([process.execPath, proofUrl.pathname], proofUrl.href,
    async () => ({ exitCode: 1, stdout: "", stderr: "synthetic failure" }));
  assert.equal(process.exitCode, 1);
  assert.deepEqual(output, ["synthetic failure"]);
  await main([], proofUrl.href, async () => { assert.fail("import must not run the proof"); });
});
