/** Verify that the current detector cannot silently narrow the authored scope. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDuplicationGate, runDuplicationGateIfMain } from "../scripts/duplication-gate.ts";
import type { CoverageRunner } from "../scripts/coverage-gate.ts";

/** Create source with enough tokens for both completeness and duplication passes. */
function duplicationFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-github-duplication-"));
  writeFileSync(join(root, "source.ts"), 'export function classify(values: readonly string[]): string { const seen = new Set<string>(); const output: string[] = []; for (const entry of values) { const trimmed = entry.trim(); if (trimmed.length === 0) continue; if (seen.has(trimmed)) throw new Error("repeated"); seen.add(trimmed); output.push(trimmed.toUpperCase()); } return output.join(","); }'.replaceAll("; ", ";\n"));
  return root;
}

/** Detector receipt boundary used to force missing or malformed source counts. */
function detectorReceipt(root: string, sources: number, lines: number, duplicatedLines: number): CoverageRunner {
  return (_bin, args) => {
    const output = args.find(arg => arg.startsWith("--output="))!.slice("--output=".length);
    writeFileSync(join(output, "jscpd-report.json"), JSON.stringify({ statistics: { total: { sources, lines, duplicatedLines } } }));
    assert.ok(args.includes(join(root, "source.ts")), "the scanner receives explicit source filenames");
    assert.ok(!args.some(arg => arg.startsWith("--pattern")), "unsupported flags cannot narrow the denominator");
    return { status: 0 };
  };
}

test("duplication gate main entry runs against the supplied root", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-github-duplication-main-"));
  const previous = process.exitCode;
  try {
    const moduleUrl = new URL("../scripts/duplication-gate.ts", import.meta.url).href;
    runDuplicationGateIfMain(["node", fileURLToPath(moduleUrl)], moduleUrl, root);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previous ?? 0;
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplication fails closed on subprocess failures, missing reports, omitted source, and invalid counters", () => {
  const root = duplicationFixture();
  try {
    for (const result of [{ status: null }, { status: 1 }, { status: 0, error: new Error("unavailable") }, { status: 0 }]) {
      assert.equal(runDuplicationGate(root, () => result), 1);
    }
    for (const [sources, lines, duplicates] of [[0, 10, 0], [1.5, 10, 0], [1, 0, 0], [1, 10, -1], [1, 10, 1]]) {
      assert.equal(runDuplicationGate(root, detectorReceipt(root, sources!, lines!, duplicates!)), 1);
    }
    assert.equal(runDuplicationGate(root, detectorReceipt(root, 1, 10, 0)), 0);
    rmSync(join(root, "source.ts"));
    assert.equal(runDuplicationGate(root), 1, "empty source cannot pass");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real jscpd covers all source files and rejects cloned code", () => {
  const root = duplicationFixture();
  try {
    assert.equal(runDuplicationGate(root), 0);
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "copy.ts"), readFileSync(join(root, "source.ts"), "utf8").replace("classify", "copied"));
    assert.equal(runDuplicationGate(root), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
