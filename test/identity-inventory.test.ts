/** Syntax-derived documentation anchors stay reproducible when implementation lines move. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
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

/** Exercise the actual source scanner and CLI against disposable source and ledger files. */
function inventoryCopy(run: (scratch: string, current: string) => void) {
  const scratch = mkdtempSync(join(tmpdir(), "github-inventory-"));
  try {
    for (const file of readdirSync(root).filter(file => file.endsWith(".ts"))) cpSync(join(root, file), join(scratch, file));
    for (const folder of ["scripts", ".github/workflows"]) cpSync(join(root, folder), join(scratch, folder), { recursive: true });
    const current = readFileSync(join(root, path), "utf8");
    mkdirSync(join(scratch, "docs")); writeFileSync(join(scratch, path), current);
    run(scratch, current);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test("ownership inventory re-derives all project anchors after a source-line shift", () => inventoryCopy((scratch, current) => {
  writeFileSync(join(scratch, "projects.ts"), "// Fixture source-line shift.\n" + readFileSync(join(root, "projects.ts"), "utf8"));
  const expected = current.replace(/`projects\.ts:(\d+)`/g, (_match, line: string) => `\`projects.ts:${Number(line) + 1}\``);
  assert.equal(renderIdentityInventory(scratch, current), expected);
}));

test("inventory CLI writes exact anchors and refuses stale ledgers", () => inventoryCopy((scratch, current) => {
  const script = join(root, "scripts/identity-inventory.ts");
  writeFileSync(join(scratch, path), current.replace(/`projects\.ts:\d+`/g, "`projects.ts:1`"));
  const stale = spawnSync(process.execPath, [script, "--check"], { cwd: scratch, encoding: "utf8" });
  assert.equal(stale.status, 1); assert.match(stale.stderr, /inventory is stale/);
  const write = spawnSync(process.execPath, [script, "--write"], { cwd: scratch, encoding: "utf8" });
  assert.equal(write.status, 0, write.stderr); assert.equal(readFileSync(join(scratch, path), "utf8"), current);
  assert.equal(renderIdentityInventory(scratch), current);
  const check = spawnSync(process.execPath, [script, "--check"], { cwd: scratch, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr); assert.match(check.stdout, /all syntax-derived and auxiliary anchors verified/);
}));

test("inventory refuses incomplete templates and unclassified source or auxiliary identity paths", () => inventoryCopy((scratch, current) => {
  assert.throws(() => renderIdentityInventory(scratch, "invalid template"), /template or source corpus is incomplete/);
  assert.throws(() => renderIdentityInventory(scratch, current.slice(0, current.indexOf("## Scripts and workflow audit"))), /template or source corpus is incomplete/);
  mkdirSync(join(scratch, "empty"));
  assert.throws(() => renderIdentityInventory(join(scratch, "empty"), current), /template or source corpus is incomplete/);
  writeFileSync(join(scratch, "unclassified.ts"), "export function newOwner(item: { external_ref: string }) { return item.external_ref; }\n");
  assert.throws(() => renderIdentityInventory(scratch, current), /Classify ownership groups: unclassified.ts\/newOwner/);
  rmSync(join(scratch, "unclassified.ts"));
  const first = current.split("\n").find(row => row.startsWith("| `closeout.ts` /"))!;
  const cells = first.split(" | "); cells[cells.length - 1] = " |";
  assert.throws(() => renderIdentityInventory(scratch, current.replace(first, cells.join(" | "))), /Classify new ownership group/);
  writeFileSync(join(scratch, "scripts/new-owner.ts"), "const field = 'github_url';\n");
  assert.throws(() => renderIdentityInventory(scratch, current), /Classify new auxiliary identity use in scripts\/new-owner.ts/);
}));
