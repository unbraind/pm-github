/** Scale harness deadlines only and validate before starting child processes. */
export function testTime(milliseconds: number): number {
  const scale = Number(process.env.PM_TEST_TIME_SCALE ?? '1');
  const result = Math.ceil(milliseconds * Math.max(1, scale));
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) {
    throw new Error('Invalid PM_TEST_TIME_SCALE');
  }
  return result;
}
