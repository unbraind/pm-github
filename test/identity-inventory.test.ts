/** Syntax-derived documentation anchors stay reproducible when implementation lines move. */
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderIdentityInventory } from "../scripts/identity-inventory.ts";

const root = join(import.meta.dirname, ".."), path = "docs/identity-ownership-inventory.md";

test("ownership inventory matches every current syntax and auxiliary anchor", () => {
  const current = readFileSync(join(root, path), "utf8");
  assert.equal(renderIdentityInventory(root, current), current);
  const legacyRule = "A leading native GitHub issue or GH issue/PR declaration retains legacy ownership without a link-only marker or whole-description match; direct provenance still protects against copied provider markers.";
  assert.ok(current.includes(legacyRule));
  const staleRule = current.replace(legacyRule, "A dedicated legacy github_link_only marker retains its complete native declaration.");
  assert.notEqual(staleRule, current);
  assert.equal(renderIdentityInventory(root, staleRule), current);
  for (const name of ["buildProjectPullPlan", "buildProjectImportPlan"]) {
    const row = current.split("\n").find(line => line.startsWith(`| \`projects.ts\` / \`${name}\` |`))!;
    assert.match(row, /indexSelectedByIssue\(\)/);
  }
});

test("ownership inventory refuses stale anchors rather than copying their line numbers", () => {
  const current = readFileSync(join(root, path), "utf8"), stale = current.replace(/`projects\.ts:\d+`/g, "`projects.ts:1`");
  assert.notEqual(stale, current);
  assert.equal(renderIdentityInventory(root, stale), current);
});

test("ownership inventory re-derives all project anchors after a source-line shift", () => {
  const scratch = mkdtempSync(join(tmpdir(), "github-inventory-"));
  try {
    for (const file of readdirSync(root).filter(file => file.endsWith(".ts"))) cpSync(join(root, file), join(scratch, file));
    for (const folder of ["scripts", ".github/workflows"]) cpSync(join(root, folder), join(scratch, folder), { recursive: true });
    const current = readFileSync(join(root, path), "utf8");
    mkdirSync(join(scratch, "docs")); writeFileSync(join(scratch, path), current);
    writeFileSync(join(scratch, "projects.ts"), "// Fixture source-line shift.\n" + readFileSync(join(root, "projects.ts"), "utf8"));
    const expected = current.replace(/`projects\.ts:(\d+)`/g, (_match, line: string) => `\`projects.ts:${Number(line) + 1}\``);
    assert.equal(renderIdentityInventory(scratch, current), expected);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
