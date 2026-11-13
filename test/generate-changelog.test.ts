import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { create, close } from "@unbrained/pm-cli/sdk";
import { fileURLToPath } from "node:url";
import { generateChangelog, generateChangelogIfMain } from "../scripts/generate-changelog.ts";

test("changelog main entry fails closed when the tracker cannot be read", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-changelog-main-"));
  const previous = process.exitCode;
  try {
    const moduleUrl = new URL("../scripts/generate-changelog.ts", import.meta.url).href;
    await generateChangelogIfMain(["node", fileURLToPath(moduleUrl)], moduleUrl, root, []);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previous ?? 0;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical changelog includes tagged pending work without closing it or admitting other claims", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-changelog-"));
  try {
    assert.equal(spawnSync("git", ["init", "-b", "main", root]).status, 0);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.10.5" }));
    const pmRoot = path.join(root, ".agents/pm");
    const cli = path.resolve("node_modules/.bin/pm");
    assert.equal(spawnSync(cli, ["--pm-path", pmRoot, "init", "--defaults", "--agent-guidance", "skip"], { cwd: root }).status, 0);
    const client = { cwd: root, pmRoot, noExtensions: true };
    const pending = await create({ title: "Pending privacy gate", status: "in_progress", tags: "changelog-unreleased" }, client);
    await create({ title: "Unrelated open claim", status: "in_progress" }, client);
    const shipped = await create({ title: "Shipped behavior" }, client);
    await close(shipped.item.id, "Fixture completion", {}, client);
    assert.equal(await generateChangelog(root, []), 0);
    const text = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    assert.ok(text.includes("Pending privacy gate"));
    assert.ok(text.includes("Shipped behavior"));
    assert.ok(!text.includes("Unrelated open claim"));
    assert.equal(await generateChangelog(root, ["--check"]), 0);
    fs.appendFileSync(path.join(root, "CHANGELOG.md"), "\nDrift\n");
    assert.equal(await generateChangelog(root, ["--check", "--no-check-diff"]), 1);
    const previousPath = process.env.PATH;
    const emptyBin = path.join(root, "empty-bin");
    fs.mkdirSync(emptyBin);
    process.env.PATH = emptyBin;
    const previousError = console.error;
    const diagnostics: string[] = [];
    console.error = (...values: unknown[]) => { diagnostics.push(values.join(" ")); };
    try {
      assert.equal(await generateChangelog(root, []), 1);
      process.env.PATH = previousPath;
      assert.equal(await generateChangelog(root, [], () => ({ status: null, signal: null, error: new Error("synthetic spawn failure"), pid: 0, output: [], stdout: "", stderr: "" })), 1);
      assert.ok(diagnostics.some(line => line.includes("could not spawn")));
      assert.equal(await generateChangelog(root, [], () => ({ status: null, signal: "SIGTERM", pid: 0, output: [], stdout: "", stderr: "" })), 1);
      assert.ok(diagnostics.some(line => line.includes("SIGTERM")));
    } finally {
      console.error = previousError;
      process.env.PATH = previousPath;
    }
    const itemFile = path.join(pmRoot, "tasks", `${pending.item.id}.toon`);
    assert.match(fs.readFileSync(itemFile, "utf8"), /status: in_progress/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical changelog fails closed when the tracker read fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-changelog-error-"));
  try {
    fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents/pm"), "invalid tracker directory");
    assert.equal(await generateChangelog(root, []), 1);
    assert.ok(!fs.existsSync(path.join(root, "CHANGELOG.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical changelog keeps released dependency notes beside pending PM work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-released-changelog-"));
  try {
    assert.equal(spawnSync("git", ["init", "-b", "main", root]).status, 0);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.11.12" }));
    const released = "## 2026.11.12 - 2026-11-12\n\n### Dependencies\n\n- Bump fixture dependency ([#1](https://github.com/unbraind/pm-github/pull/1))\n";
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n" + released);
    assert.equal(spawnSync("git", ["add", "package.json", "CHANGELOG.md"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-m", "chore(deps-dev): bump fixture dependency (#1)"], { cwd: root }).status, 0);
    const pmRoot = path.join(root, ".agents/pm"), cli = path.resolve("node_modules/.bin/pm");
    assert.equal(spawnSync(cli, ["--pm-path", pmRoot, "init", "--defaults", "--agent-guidance", "skip"], { cwd: root }).status, 0);
    await create({ title: "Pending whole-value ownership", status: "in_progress", tags: "changelog-unreleased" }, { cwd: root, pmRoot, noExtensions: true });
    assert.equal(await generateChangelog(root, []), 0);
    const output = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    assert.ok(output.includes(released.split("### Dependencies")[1]!), "Released dependency notes survive when a PM item joins the window");
    assert.match(output, /## 2026\.11\.12 - 2026-11-12[\s\S]*Pending whole-value ownership/);
    assert.equal(await generateChangelog(root, ["--check"]), 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
