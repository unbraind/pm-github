/** Execute the documentation gate with each native validation failing in turn. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseDocument } from 'yaml';

test('documentation gate retains input-sensitive checks and propagates every failure', () => {
  const document = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8'), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const step = document.toJS().jobs.test.steps.find((step: { name: string }) => step.name === 'Check documentation and tracker changes');
  const checks: string[] = step.run.split('\n').filter((line: string) => /^(npm|node) /.test(line));
  for (const required of ['pack:dry-run', 'verify:release-publish-attestation', 'changelog:check']) assert.ok(step.run.includes(required), required);
  for (let failure = 1; failure <= checks.length; failure++) {
    const stub = `count=0
node() { check; }
npm() { check; }
check() { count=$((count+1)); if [ "$count" -eq "$FAIL_AT" ]; then return 17; fi; }
`;
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stub + step.run], { encoding: 'utf8', env: { ...process.env, FAIL_AT: String(failure) } });
    assert.equal(result.status, 17, result.stderr);
  }
});
