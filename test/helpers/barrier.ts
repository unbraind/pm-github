import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export interface BarrierWaitDependencies {
  now?: () => number;
  delayMs?: (ms: number) => Promise<unknown>;
  deadlineMs?: number;
  exists?: (path: string) => boolean;
  logError?: (message: string) => void;
  exit?: (code: number) => void;
}

export async function waitForBarrier(
  barrierPath: string,
  dependencies: BarrierWaitDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const delayMs = dependencies.delayMs ?? delay;
  const deadline = now() + (dependencies.deadlineMs ?? 10_000);
  const exists = dependencies.exists ?? existsSync;
  const logError = dependencies.logError ?? console.error;
  const exit = dependencies.exit ?? process.exit;

  while (!exists(barrierPath)) {
    if (now() > deadline) {
      logError("barrier file never appeared");
      exit(2);
      return;
    }
    await delayMs(5);
  }
}
