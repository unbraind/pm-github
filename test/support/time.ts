/** Scale harness latency budgets on slow runners; production deadlines stay unchanged. */
export function testTime(milliseconds: number): number {
  const scale = Number(process.env.PM_TEST_TIME_SCALE ?? 1);
  return milliseconds * (Number.isFinite(scale) && scale >= 1 ? scale : 1);
}
