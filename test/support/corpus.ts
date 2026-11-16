/** Preserve complete workflow corpora by default and deterministic quick prefixes. */
import type nodeTest from "node:test";
import { testDepth } from "./depth.ts";

/** Collect original registrations without wrapping their fixtures or assertions. */
export function workflowCorpus(test: typeof nodeTest, label: string): { test: typeof nodeTest; register: () => void } {
  const pending: unknown[][] = [];
  return {
    test: ((...args: unknown[]) => { pending.push(args); }) as typeof nodeTest,
    register() {
      const selected = pending.slice(0, testDepth(pending.length));
      console.info(`${label} scenarios: ${selected.length}/${pending.length}; deterministic prefix`);
      for (const args of selected) Reflect.apply(test, undefined, args);
    },
  };
}
