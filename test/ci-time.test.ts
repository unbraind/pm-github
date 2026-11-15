/** Harness controls fail before dispatch and accept fractional scales. */
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { boundedCli } from './helpers/bounded-cli.ts';
import { testTime } from './support/time.ts';

test('harness scale rounds milliseconds and refuses invalid settings before spawning', t => {
  const previous = process.env.PM_TEST_TIME_SCALE;
  t.after(() => { if (previous === undefined) delete process.env.PM_TEST_TIME_SCALE; else process.env.PM_TEST_TIME_SCALE = previous; });
  process.env.PM_TEST_TIME_SCALE = '1.1'; assert.equal(testTime(101), 112);
  process.env.PM_TEST_TIME_SCALE = '0.5'; assert.equal(testTime(101), 101);
  let spawned = false;
  const original = cp.spawn;
  cp.spawn = (() => { spawned = true; throw new Error('Unexpected spawn'); }) as typeof cp.spawn;
  syncBuiltinESMExports();
  try {
    for (const scale of ['', '0', '-1', 'NaN', 'Infinity', '100000000']) {
      process.env.PM_TEST_TIME_SCALE = scale;
      assert.throws(() => testTime(45000), /PM_TEST_TIME_SCALE/);
      assert.throws(() => boundedCli('unused', [], '.', {}, 100, 100, 'ready'), /PM_TEST_TIME_SCALE/);
    }
    assert.equal(spawned, false);
  } finally { cp.spawn = original; syncBuiltinESMExports(); }
});
