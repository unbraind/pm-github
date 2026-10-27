/** Canonical comparisons must agree with real SDK writers and packed CLI consumers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { decode } from "@toon-format/toon";
import { certifyCompleteListResult, commitImportedItem, create, get, getItemPath, listAllComplete, parseTags, readSettings, schemaAddType } from "@unbrained/pm-cli/sdk";
import { decodeCompletePmItems, parseImportOptions, runImport, type GhIssue } from "../index.ts";
import { normalizeImportValue, readImportTypeNames, serializeImportTags } from "../import-fidelity.ts";
import { boundedCli } from "./helpers/bounded-cli.ts";
import { jsonResponse, withMockGithub } from "./helpers/mock-github-server.ts";

const packageRoot = join(import.meta.dirname, "..");
const cli = join(packageRoot, "node_modules/.bin/pm");
const labelSets = [["plain", "second"], ["area,api"], ['["json"]', 'quote"tag', "space label"], [" É,ß ", "constructor", "__proto__", "DUP", "dup"]];

/** Read durable item/history bytes while excluding lock, cache and journal receipts. */
function durable(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true }).map(String).filter(file => file.endsWith(".toon") || /^history\/.*\.jsonl$/.test(file))
    .sort().map(file => [file, readFileSync(join(root, file), "utf8")]));
}

/** Initialize a non-git tracker using the actual pinned host. */
function initialize(root: string, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(root, { recursive: true });
  const result = spawnSync(cli, ["--path", root, "init", "fixture"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, env, encoding: "utf8" }).status, 0, "The projection fixture must remain outside git.");
}

/** Stable closed issues expose the mixed create/update lifecycle and history path. */
function issue(number: number, labels: string[]): GhIssue {
  return { number, title: `Issue ${number}`, body: "\n\nPublic body \n", state: "closed", state_reason: "completed", labels: labels.map(name => ({ name })),
    assignee: null, milestone: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", closed_at: "2026-10-02T00:00:00Z",
    html_url: `https://github.com/fixture/project/issues/${number}` };
}

test("tag transport property preserves every token and legacy lossless wire representation", () => {
  const atoms = ["a", "a,b", '"a"', '["a"]', "[]", " é,ß ", "constructor", "__proto__"];
  for (const first of atoms) for (const second of atoms) {
    const tags = [first, second, "gh:fixture/project#1"];
    assert.deepEqual(parseTags(serializeImportTags(tags)), parseTags(JSON.stringify(tags)), JSON.stringify(tags));
    assert.deepEqual(tags.flatMap(tag => parseTags(serializeImportTags([tag]))).sort(),
      tags.flatMap(tag => parseTags(JSON.stringify([tag]))).sort());
  }
  for (const [tags, legacy] of [[[], ""], [["plain", "second"], "plain,second"], [[" X "], " X "]] as const) assert.equal(serializeImportTags(tags), legacy);
});

test("mixed closed imports are byte-stable for SDK type aliases and adversarial label tokens", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-projection-"));
  try {
    initialize(root);
    await schemaAddType("Investigation", { folder: "investigations", alias: ["probe"] }, { pmRoot: root, noExtensions: true });
    const types = await readImportTypeNames(root);
    for (const unknown of ["constructor", "__proto__", "missing"]) assert.equal(normalizeImportValue("type", unknown, types), unknown);
    assert.equal(normalizeImportValue("type", null, types), null);
    let current: GhIssue[] = [];
    await withMockGithub((request, response) => jsonResponse(response, 200, request.url === "/graphql"
      ? { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }
      : request.url!.includes("/issues?") ? current : []), async () => {
      let number = 1;
      for (const type of ["issue", " ISSUE ", "task", " PROBE "]) for (const labels of labelSets) {
        const native = (await create({ title: "Native linked item", type, tags: `gh:fixture/project#${number + 1}` }, { pmRoot: root, noExtensions: true })).item;
        current = [issue(number, labels), issue(number + 1, labels)];
        const options = parseImportOptions({ atomic: true, type });
        const first = await runImport("fixture/project", root, options);
        assert.equal("imported" in first && first.imported, 1);
        assert.equal("updated" in first && first.updated, 1);
        const items = decodeCompletePmItems(certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: root, noExtensions: true })));
        for (const source of current) {
          const actual = items.find(item => item.tags?.includes(`gh:fixture/project#${source.number}`))!;
          assert.equal(actual.type, native.type, `SDK type ${type}`);
          assert.deepEqual(actual.tags, parseTags(JSON.stringify([...labels, `gh:fixture/project#${source.number}`])));
        }
        const before = durable(root);
        const repeat = await runImport("fixture/project", root, options);
        assert.ok(durable(root) === before, "Equivalent source input must preserve all items and histories.");
        assert.equal("unchanged" in repeat && repeat.unchanged, true, `${type}: ${JSON.stringify(labels)}`);
        current = current.map(source => ({ ...source, labels: [...source.labels].reverse().concat(source.labels.slice(0, 1)) }));
        const equivalent = await runImport("fixture/project", root, parseImportOptions({ atomic: true, type: native.type }));
        assert.equal("unchanged" in equivalent && equivalent.unchanged, true, "Canonical type names and reordered labels are equivalent inputs.");
        assert.ok(durable(root) === before, "Canonical spellings and reordered labels must preserve durable bytes.");
        assert.equal((await get(native.id, {}, { pmRoot: root, noExtensions: true })).item.status, "closed");
        number += 2;
      }
      for (const [alias, canonical] of types) for (const spelling of [alias, alias.toUpperCase(), ` ${alias} `]) assert.equal(normalizeImportValue("type", spelling, types), canonical);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const atomic of [false, true]) test(`additive provider links preserve literal tags (${atomic})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-projection-owner-"));
  try {
    initialize(root);
    const original = ["gh:fixture/project#1", "area,api", '["json"]'];
    const local = (await create({ title: "Provider owner", type: "Task", tags: JSON.stringify(original), body: "Provider context" }, { pmRoot: root, noExtensions: true })).item;
    await commitImportedItem({ pmRoot: root, id: local.id, itemPath: getItemPath(root, "Task", local.id), settings: await readSettings(root),
      document: { metadata: { ...local, github_link_only: true }, body: "Provider context" }, author: "fixture", message: "Seed existing provider link", conflictWarningPrefix: "fixture" });
    const labels = ["source,extra", '["array"]'];
    await withMockGithub((request, response) => jsonResponse(response, 200, request.url === "/graphql"
      ? { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }
      : request.url!.includes("/issues?") ? [issue(1, labels)] : []), async () => {
      const options = parseImportOptions({ atomic, type: "issue" });
      await runImport("fixture/project", root, options);
      const written = (await get(local.id, {}, { pmRoot: root, noExtensions: true })).item;
      assert.deepEqual(written.tags, parseTags(JSON.stringify([...original, ...labels])));
      assert.equal(written.type, "Task");
      assert.equal(written.body, "Provider context");
      const before = durable(root);
      const repeated = await runImport("fixture/project", root, options);
      if (atomic) {
        assert.equal("unchanged" in repeated && repeated.unchanged, true);
        assert.ok(durable(root) === before, "An identical atomic provider link must preserve durable bytes.");
      }
      assert.deepEqual((await get(local.id, {}, { pmRoot: root, noExtensions: true })).item.tags, written.tags);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("packed npm and native Bun consumers preserve mixed-import bytes in JSON and TOON", { timeout: 600_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "pm-packed-projection-"));
  const root = join(base, "consumer");
  const pmRoot = join(root, ".agents/pm");
  mkdirSync(root);
  mkdirSync(join(base, "home"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(base, "home"), NPM_CONFIG_USERCONFIG: devNull, PM_AUTHOR: "fixture", PM_PATH: pmRoot,
    PATH: join(root, "node_modules/.bin") + delimiter + process.env.PATH, GITHUB_TOKEN: "fixture" };
  delete env.NODE_TEST_CONTEXT;
  /** Keep the HTTP fixture responsive while a real package manager or CLI child runs. */
  const run = async (bin: string, args: string[], cwd = root, extra = env): Promise<string> => {
    const result = await boundedCli(bin, args, cwd, extra);
    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  try {
    initialize(pmRoot, env);
    writeFileSync(join(root, "package.json"), "{}\n");
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(root, "node_modules/@unbrained"), { recursive: true });
    symlinkSync(cli, join(root, "node_modules/.bin/pm"));
    symlinkSync(join(packageRoot, "node_modules/@unbrained/pm-cli"), join(root, "node_modules/@unbrained/pm-cli"));
    const packed = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--foreground-scripts=false", "--json", "--pack-destination", base], packageRoot,
      { ...env, PM_PATH: join(packageRoot, ".agents/pm") })) as [{ filename: string }];
    await run(cli, ["--path", pmRoot, "package", "install", join(base, packed[0].filename), "--project"]);
    await run(cli, ["--path", pmRoot, "create", "--title", "Native", "--type", "issue", "--tags", "gh:fixture/project#2"]);
    let payload = [issue(1, labelSets.flat()), issue(2, labelSets.flat())];
    await withMockGithub((request, response) => jsonResponse(response, 200, request.url === "/graphql"
      ? { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }
      : request.url!.includes("/issues?") ? payload : []), async server => {
      const args = ["--path", pmRoot, "github", "import", "fixture/project", "--atomic", "--type", "issue"];
      const environment = { ...env, PM_GITHUB_API_BASE: server.baseUrl };
      const first = JSON.parse(await run("npm", ["exec", "--offline", "--", "pm", ...args, "--json"], root, environment)) as { imported: number };
      assert.equal(first.imported, 1);
      const before = durable(pmRoot);
      for (const bin of ["npm", "bun"]) for (const json of [true, false]) {
        const format = json ? ["--json"] : [];
        const output = await run(bin, bin === "npm" ? ["exec", "--offline", "--", "pm", ...args, ...format]
          : ["--bun", cli, ...args, ...format], root, environment);
        const receipt = (json ? JSON.parse(output) : decode(output)) as { unchanged: boolean; imported: number; updated: number };
        assert.equal(receipt.unchanged, true, `${bin}/${json ? "JSON" : "TOON"}`);
        assert.equal(receipt.imported, 0);
        assert.equal(receipt.updated, 0);
        assert.ok(durable(pmRoot) === before, "Packed repeat must preserve item and history bytes.");
        const listArgs = ["--path", pmRoot, "--output-include", "full", "list", "--all", ...format];
        const view = await run(bin, bin === "npm" ? ["exec", "--offline", "--", "pm", ...listArgs] : ["--bun", cli, ...listArgs], root, environment);
        const listed = (json ? JSON.parse(view) : decode(view)) as { items: Array<{ type: string; tags: string[] }> };
        for (const item of listed.items) { assert.equal(item.type, "Issue"); assert.ok(item.tags.includes("area,api")); }
      }
      await run(cli, ["--path", pmRoot, "create", "--title", "Plain native", "--type", "issue", "--tags", "gh:fixture/project#4"], root, environment);
      payload = [issue(3, labelSets.flat()), issue(4, labelSets.flat())];
      const plainArgs = ["--path", pmRoot, "github", "import", "fixture/project", "--type", "issue"];
      const plain = JSON.parse(await run("npm", ["exec", "--offline", "--", "pm", ...plainArgs, "--json"], root, environment)) as { imported: number; updated: number };
      assert.equal(plain.imported, 1);
      assert.equal(plain.updated, 1);
      const plainRepeat = decode(await run("bun", ["--bun", cli, ...plainArgs], root, environment)) as { imported: number; updated: number };
      assert.equal(plainRepeat.imported, 0);
      assert.equal(plainRepeat.updated, 2, "Plain import retains its documented apply-each-time accounting.");
      const actual = JSON.parse(await run(cli, ["--path", pmRoot, "--output-include", "full", "list", "--all", "--json"], root, environment)) as { items: Array<{ tags: string[]; type: string }> };
      for (const item of actual.items) { assert.equal(item.type, "Issue"); assert.ok(item.tags.includes("area,api")); }
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});
