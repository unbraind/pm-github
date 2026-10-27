/** Exact label plans use real non-git SDK state, complete counts and no saved mutations. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { encode, decode } from "@toon-format/toon";
import { init, create, update, get, getItemPath, serializeItemDocument, toImportTags, schemaAddStatus, focus, listAllComplete, certifyCompleteListResult, commitImportedItem, readSettings, encodePmTableRows } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { planGithubLabelMigration, readGithubLabelCatalog, validateGithubLabelMigrationReport,
  applyLabelMap, buildExportPlan, applyExportPlan, compileIssueForm,
  type GithubLabelMigrationInput, type GithubLabelCatalog, type GithubLabelMigrationReport, type ExportPlanEntry } from "../index.ts";
import { readLabelMigrationJson } from "../labels.ts";
import { withEnv, startMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

const source = { id: "LA_source", name: "bug" };
const target = { id: "LA_target", name: "kind/bug" };
const catalog: GithubLabelCatalog = { complete: true, labels: [source, target, { id: "LA_other", name: "Bug " }] };
/** Every policy selection is explicit, including the absence of saved filters and mappings. */
function request(overrides: Partial<GithubLabelMigrationInput> = {}): GithubLabelMigrationInput {
  return { repo: "fixture/repo", sources: [source], change: { kind: "rename", name: "defect" },
    filters: [{ id: "nightly", labels: ["bug", "keep"] }], mappings: [{ id: "export", from: "local-bug", to: "bug" }],
    choices: { tags: "review", filters: "keep", mappings: "replace" }, ...overrides };
}
/** Explicit offline catalog reader exercises the same boundary as the live provider reader. */
async function readCatalog() { return structuredClone(catalog); }
/** Match typed refusals and require their remediation text. */
function code(expected: string) { return (error: unknown) => { assert.equal((error as { code: string }).code, expected); assert.ok(String(error).length > expected.length); return true; }; }
/** Snapshot every durable byte, including foreign records, without git. */
function snapshot(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(join(entry.parentPath, entry.name).slice(root.length)).update(readFileSync(join(entry.parentPath, entry.name)));
  }
  return hash.digest("hex");
}
/** Plain tracker with git absent from PATH and an explicit ceiling. */
async function tracker(run: (root: string, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "pm-label-plan-"));
  const root = join(directory, "tracker");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  try {
    await withEnv({ PATH: bin, PM_AUTHOR: "fixture", PM_PATH: root, GIT_CEILING_DIRECTORIES: dirname(directory) }, async () => {
      await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { cwd: directory, pmRoot: root, noExtensions: true });
      await run(root, directory);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Seed all fixture items with explicit relationships, preventing ambient focus inheritance. */
async function item(root: string, title: string, tags: string[], id?: string) {
  return (await create({ id, title, type: "Task", tags: tags.join(","), parent: "none", unset: ["sprint", "release", "goal", "objective"], clearDeps: true }, { pmRoot: root })).item;
}

test("same display intent stays distinct; every affected identity and choice is explicit", async () => tracker(async root => {
  const a = await item(root, "Provider occurrence", ["bug", "gh:fixture/repo#1", "other"]);
  const b = await item(root, "Local occurrence", ["bug", "linear:foreign"]);
  await item(root, "Similar display intent", ["Bug"]);
  const before = snapshot(root);
  const report = await planGithubLabelMigration(root, request(), { readCatalog });
  assert.deepEqual(report.counts, { scanned: 3, items: 3, tags: 3, filters: 1, mappings: 1, review: 3, total: 5 });
  assert.equal(report.rows.find(row => row.id === a.id)!.identities[0], "gh:fixture/repo#1");
  assert.equal(report.rows.find(row => row.id === b.id)!.evidence, "unverified_name");
  assert.equal(report.rows.find(row => row.kind === "mappings")!.choice, "replace");
  assert.deepEqual(report.sources, [source]);
  assert.equal(report.destination.id, source.id);
  assert.equal(report.checked, false);
  assert.deepEqual(validateGithubLabelMigrationReport(JSON.parse(JSON.stringify(report))), report);
  assert.deepEqual(validateGithubLabelMigrationReport(decode(encode(report))), report);
  assert.equal(snapshot(root), before);
  const page = await planGithubLabelMigration(root, request(), { readCatalog, page: { limit: 1 } });
  assert.equal(page.approval, report.approval);
  assert.equal(page.next, 1);
  assert.deepEqual(page.counts, report.counts);
  const explicit = await planGithubLabelMigration(root, request({ sources: [source, catalog.labels[2]!], change: { kind: "consolidate", target } }), { readCatalog });
  assert.equal(explicit.sources.length, 2);
  assert.equal(explicit.counts.tags, 6, "same native tag retains two explicit source identities");
  assert.equal(explicit.destination.id, target.id);
  await assert.rejects(planGithubLabelMigration(root, request({ change: { kind: "rename", name: "KIND/BUG" } }), { readCatalog }), code("invalid_input"));
  await assert.rejects(planGithubLabelMigration(root, request({ sources: [source, target] }), { readCatalog }), code("invalid_input"));
  await assert.rejects(planGithubLabelMigration(root, request({ change: { kind: "consolidate", target: source } }), { readCatalog }), code("invalid_input"));
}));

test("importer CSV tag semantics cover preview, approval, destination expansion and CLI reports", async () => tracker(async (root, directory) => {
  await item(root, "CSV import", [" One, TWO ,one "]);
  const csvSource = { id: "CSV", name: "one,two" };
  const readCatalog = async () => ({ complete: true, labels: [csvSource] });
  const input = request({ sources: [csvSource], filters: [], mappings: [], change: { kind: "rename", name: " alpha, BETA " } });
  const report = await planGithubLabelMigration(root, input, { readCatalog });
  assert.deepEqual(report.counts, { scanned: 1, items: 1, tags: 2, filters: 0, mappings: 0, review: 2, total: 2 });
  assert.deepEqual(report.rows.map(row => row.before), ["one", "two"]);
  assert.ok(report.rows.every(row => row.after === " alpha, BETA "));
  assert.deepEqual(report.rows.map(row => row.after_tags), [["alpha", "beta"], ["alpha", "beta"]]);
  const { next: _omitted, ...compact } = report;
  assert.equal(_omitted, null);
  assert.deepEqual(validateGithubLabelMigrationReport(compact), report, "host TOON may omit a completed continuation");
  const unfinished = await planGithubLabelMigration(root, input, { readCatalog, page: { limit: 1 } });
  const { next: _required, ...truncated } = unfinished;
  assert.equal(_required, 1);
  assert.throws(() => validateGithubLabelMigrationReport(truncated), code("invalid_output"));
  const { local_tag: _identity, ...missingTag } = report.rows[0]!;
  assert.equal(_identity, "one");
  assert.throws(() => validateGithubLabelMigrationReport({ ...report, rows: [missingTag, report.rows[1]] }), code("invalid_output"));
  const policies = await planGithubLabelMigration(root, { ...input, filters: [{ id: "filter", labels: ["ONE,TWO"] }],
    mappings: [{ id: "map", from: "native", to: "one,TWO" }] }, { readCatalog });
  const compactPolicies = { ...policies, next: undefined, rows: policies.rows.map(row => row.kind === "tags" ? row :
    row.kind === "filters" ? { ...row, local_tag: undefined, after_tags: undefined } : { ...row, after_tags: undefined }) };
  assert.deepEqual(validateGithubLabelMigrationReport(compactPolicies), policies);
  for (const invalid of [null, undefined]) {
    assert.throws(() => validateGithubLabelMigrationReport({ ...policies, rows: policies.rows.map(row => row.kind === "mappings" ? { ...row, local_tag: invalid } : row) }), code("invalid_output"));
  }
  await assert.rejects(planGithubLabelMigration(root, input, { readCatalog, approval: report.approval, page: { limit: 1 } }), code("unresolved_choices"));
  const keep = { ...input, choices: { ...input.choices, tags: "keep" as const } };
  const reviewed = await planGithubLabelMigration(root, keep, { readCatalog });
  assert.equal((await planGithubLabelMigration(root, keep, { readCatalog, approval: reviewed.approval })).checked, true);
  const empty = await planGithubLabelMigration(root, { ...input, change: { kind: "rename", name: ",,," } }, { readCatalog });
  assert.ok(empty.rows.every(row => row.after_tags?.length === 0), "a zero-tag destination stays explicit");
  const emptySource = { id: "EMPTY", name: ",,," };
  const emptyInput = { ...input, sources: [emptySource] };
  const emptyCatalog = async () => ({ complete: true, labels: [emptySource] });
  const noTags = await planGithubLabelMigration(root, emptyInput, { readCatalog: emptyCatalog });
  assert.equal(noTags.counts.tags, 0);
  assert.deepEqual(validateGithubLabelMigrationReport({ ...noTags, rows: undefined, next: undefined }), noTags,
    "host compaction may omit empty rows on a completed page");
  assert.throws(() => validateGithubLabelMigrationReport({ ...report, rows: undefined }), code("invalid_output"));
  const terminal = await planGithubLabelMigration(root, input, { readCatalog, page: { offset: report.counts.total } });
  assert.deepEqual(validateGithubLabelMigrationReport({ ...terminal, rows: undefined, next: undefined }), terminal);
  assert.equal((await planGithubLabelMigration(root, emptyInput, { readCatalog: emptyCatalog, approval: noTags.approval })).checked, true);
  for (const invalid of [null, new Array(1), [Infinity], ["x".repeat(601)], [" "]]) {
    assert.throws(() => validateGithubLabelMigrationReport({ ...report, rows: [{ ...report.rows[0], after_tags: invalid } ] }), code("invalid_output"));
  }
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "hooks", "preflight", "search", "importers"] });
  const file = join(directory, "csv-policy.json");
  const catalogFile = join(directory, "csv-catalog.json");
  writeFileSync(file, JSON.stringify(input));
  writeFileSync(catalogFile, JSON.stringify(await readCatalog()));
  for (const json of [false, true]) {
    const cli = (await harness.runCommand({ command: "github labels plan", pmRoot: root, args: [], options: { input: file, catalog: catalogFile }, global: { json } })).result;
    assert.deepEqual(validateGithubLabelMigrationReport(json ? JSON.parse(JSON.stringify(cli)) : decode(encode(cli))), report);
  }
  const legacy = await item(root, "Earlier SDK array producer", []);
  await commitImportedItem({ pmRoot: root, id: legacy.id, itemPath: getItemPath(root, "Task", legacy.id),
    document: { metadata: { ...legacy, tags: [" ONE,TWO ", "one"] }, body: "" }, settings: await readSettings(root),
    author: "fixture", message: "Earlier SDK array representation", conflictWarningPrefix: "fixture" });
  const raw = (await get(legacy.id, {}, { pmRoot: root })).item;
  assert.ok(raw.tags!.includes("one,two"), "the SDK reads earlier array-producer data without CSV splitting it");
  const legacyReport = await planGithubLabelMigration(root, input, { readCatalog });
  assert.deepEqual(legacyReport.rows.filter(row => row.id === legacy.id).map(row => row.before), ["one"],
    "only the existing native atom matches; the literal comma tag is not split into invented identities");
  for (const json of [false, true]) {
    const cli = (await harness.runCommand({ command: "github labels plan", pmRoot: root, args: [], options: { input: file, catalog: catalogFile }, global: { json } })).result;
    assert.deepEqual(validateGithubLabelMigrationReport(json ? JSON.parse(JSON.stringify(cli)) : decode(encode(cli))), legacyReport);
  }
  const unicode = { id: "UNICODE", name: "İ".repeat(200) };
  await item(root, "Expanded native tag", [unicode.name]);
  const expanded = await planGithubLabelMigration(root, { ...input, sources: [unicode] }, { readCatalog: async () => ({ complete: true, labels: [unicode] }) });
  assert.equal(expanded.rows[0]!.before.length, 400, "SDK Unicode expansion stays within the emitted tag bound");
}));

test("provider name semantics cover policy comparisons, hidden review rows and exact node identities", async () => tracker(async (root, directory) => {
  await item(root, "Case policy", ["bug"]);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "hooks", "preflight", "search", "importers"] });
  const file = join(directory, "case-policy.json");
  const catalogFile = join(directory, "case-catalog.json");
  writeFileSync(catalogFile, JSON.stringify(catalog));
  for (const spelling of ["bug", "BUG", "Bug", "bUg", "buG", "BUg", "bUG", "BuG"]) {
    for (const change of [{ kind: "rename", name: "defect" }, { kind: "consolidate", target }] as const) {
      const input = request({ change, filters: [{ id: "filter", labels: [spelling, "bUG", "not-bug"] }],
        mappings: [{ id: "map", from: "LOCAL", to: spelling }], choices: { tags: "keep", filters: "review", mappings: "review" } });
      const report = await planGithubLabelMigration(root, input, { readCatalog, page: { limit: 1 } });
      assert.deepEqual(report.counts, { scanned: 1, items: 1, tags: 1, filters: 1, mappings: 1, review: 2, total: 3 });
      assert.equal(report.rows.length, 1, "review choices beyond the page must still block approval");
      await assert.rejects(planGithubLabelMigration(root, input, { readCatalog, approval: report.approval }), code("unresolved_choices"));
      writeFileSync(file, JSON.stringify(input));
      for (const json of [false, true]) {
        const cli = (await harness.runCommand({ command: "github labels plan", pmRoot: root, args: [],
          options: { input: file, catalog: catalogFile, offset: "1" }, global: { json } })).result as GithubLabelMigrationReport;
        const decoded = json ? JSON.parse(JSON.stringify(cli)) as unknown : decode(encode(cli));
        assert.deepEqual(validateGithubLabelMigrationReport(decoded).counts, report.counts);
        assert.deepEqual(cli.rows.map(row => row.before), [spelling, spelling], "configured spelling remains reviewable");
        assert.equal(cli.rows[1]!.local_tag, "LOCAL", "local mapping keys are not provider names");
      }
    }
  }
  const safe = request({ filters: [{ id: "filter", labels: ["BUG"] }], mappings: [{ id: "map", from: "LOCAL", to: "BUG" }],
    choices: { tags: "keep", filters: "replace", mappings: "replace" } });
  const approved = await planGithubLabelMigration(root, safe, { readCatalog });
  assert.equal((await planGithubLabelMigration(root, safe, { readCatalog, approval: approved.approval })).checked, true);
  await assert.rejects(planGithubLabelMigration(root, { ...safe, filters: [{ id: "filter", labels: ["Bug"] }] }, { readCatalog, approval: approved.approval }), code("stale_plan"));
  await assert.rejects(planGithubLabelMigration(root, { ...safe, sources: [{ ...source, id: source.id.toLowerCase() }] }, { readCatalog }), code("stale_labels"));
  await assert.rejects(planGithubLabelMigration(root, { ...safe, sources: [{ ...source, name: "BUG" }] }, { readCatalog }), code("stale_labels"));
  const other = { id: "LA_OTHER_CASE", name: "BUG" };
  const separate = await planGithubLabelMigration(root, { ...safe, sources: [source, other], change: { kind: "consolidate", target } },
    { readCatalog: async () => ({ complete: true, labels: [source, other, target] }) });
  assert.equal(separate.sources.length, 2);
  assert.equal(separate.counts.filters, 2, "case-insensitive name matching must not collapse distinct selected IDs");
}));

test("500 provider name permutations cover mapped, unmapped, form and wire export paths", async () => {
  let seed = 0xca5e123;
  const variants = new Set<string>();
  /** Generate ASCII case variants without changing any provider-name characters. */
  function variant(name: string): string {
    return [...name].map(character => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24 & 1 ? character.toUpperCase() : character; }).join("");
  }
  for (let sequence = 0; sequence < 500; sequence++) {
    const first = variant("kind/bug");
    const alias = variant("kind/bug");
    variants.add(first);
    variants.add(alias);
    const names = [first, alias, "kind/bug ", "other", "OTHER"];
    const expected = [first, "kind/bug ", "other"];
    for (const map of [undefined, new Map<string, string>()]) assert.deepEqual(applyLabelMap(names, map), expected);
    const mapped = applyLabelMap(["LOCAL", "other-local", "local"], new Map([["LOCAL", first], ["other-local", alias]]));
    assert.deepEqual(mapped, [first, "local"], "mapping keys retain local exact semantics");
    const plan = buildExportPlan([{ id: "fixture-case", title: "Case", tags: names }], "fixture/repo");
    assert.deepEqual(plan[0]!.payload.labels, expected);
    const contract = compileIssueForm({ repo: "fixture/repo", ref: "main", path: ".github/ISSUE_TEMPLATE/case.yml",
      yaml: JSON.stringify({ name: "Case", description: "Case", labels: names, body: [{ type: "input", id: "summary", attributes: { label: "Summary" } }] }) });
    assert.deepEqual(contract.labels, expected);
    if (sequence < 4) {
      const entries: ExportPlanEntry[] = ["create", "update"].map(action => ({ action: action as "create" | "update", number: 1,
        payload: { title: "Case", body: "", state: "open", labels: names } }));
      const result = await applyExportPlan(entries, "fixture/repo", undefined, async (_method, _url, _token, body) => {
        assert.deepEqual((JSON.parse(body!) as { labels: string[] }).labels, expected);
        return {};
      });
      assert.equal(result.created + result.updated, 2);
      assert.deepEqual(entries[0]!.payload.labels, names, "wire normalization does not mutate caller plans");
    }
  }
  assert.ok(variants.size > 100, "the seeded sample exercises a broad set of case permutations");
});

test("form and export label composition share provider name semantics in JSON and TOON", async () => tracker(async root => {
  const native = await item(root, "Composition", ["bug", "local"]);
  const definition = { name: "Case", description: "Case", labels: ["BUG", "bUg", "triage", "TRIAGE"],
    body: [{ type: "input", id: "summary", attributes: { label: "Summary" } }] };
  const server = await startMockGithub((_req, res) => jsonResponse(res, 200, { type: "file", path: ".github/ISSUE_TEMPLATE/case.yml",
    encoding: "base64", content: Buffer.from(JSON.stringify(definition)).toString("base64") }));
  try {
    await withEnv({ PM_GITHUB_API_BASE: server.baseUrl, GITHUB_TOKEN: "fixture" }, async () => {
      const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "hooks", "preflight", "search", "importers"] });
      for (const json of [false, true]) {
        const result = (await harness.runExporter({ exporter: "github", pmRoot: root, global: { json }, options: { ids: native.id,
          repo: "fixture/repo", form: ".github/ISSUE_TEMPLATE/case.yml", "form-ref": "main", "label-map": "local=TRIAGE" } })).result as { plan: ExportPlanEntry[] };
        assert.deepEqual(result.plan[0]!.payload.labels, ["bug", "TRIAGE"]);
      }
    });
  } finally { await server.close(); }
}));

test("1000 items return complete counts and bounded rows on a read-only non-git tracker", async () => tracker(async root => {
  const base = await item(root, "Thousand fixture base", ["bug"], "fixture-0001");
  for (let i = 1; i < 1000; i++) {
    const id = `${base.id}-bulk-${String(i).padStart(4, "0")}`;
    writeFileSync(getItemPath(root, "Task", id), serializeItemDocument({ metadata: { ...base, id, title: `Fixture ${i}`, tags: ["bug", `gh:fixture/repo#${i}`] }, body: "" }));
  }
  const seeded = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true }));
  assert.equal(seeded.items.length, 1000, "source fixture is complete before preview or permission changes");
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())) chmodSync(join(entry.parentPath, entry.name), 0o444);
  const before = snapshot(root);
  const result = await planGithubLabelMigration(root, request(), { readCatalog, page: { limit: 7, offset: 996 } });
  assert.deepEqual(result.counts, { scanned: 1000, items: 1000, tags: 1000, filters: 1, mappings: 1, review: 1000, total: 1002 });
  assert.equal(result.rows.length, 6);
  assert.equal(result.next, null);
  assert.equal(snapshot(root), before);
  const first = await planGithubLabelMigration(root, request(), { readCatalog, page: { limit: 7 } });
  assert.equal(first.rows.length, 7);
  assert.equal(first.next, 7);
  assert.equal(first.approval, result.approval);
}));

test("bounded provenance skips foreign or malformed references without losing the affected item", async () => tracker(async root => {
  const repo = `${"a".repeat(100)}/${"b".repeat(100)}`;
  const valid = `gh:${repo}#${Number.MAX_SAFE_INTEGER}`;
  await item(root, "Extreme provenance", ["bug", valid, `gh:${repo}#${"9".repeat(300)}`, `gh:${repo}#0`,
    `gh:${repo}#${"0".repeat(300)}1`, "gh:other/repo#1"]);
  const report = await planGithubLabelMigration(root, request({ repo, filters: [], mappings: [] }), { readCatalog });
  assert.equal(report.counts.items, 1);
  assert.deepEqual(report.rows[0]!.identities, [valid]);
  assert.deepEqual(validateGithubLabelMigrationReport(decode(encode(report))), report);
}));

test("approval revalidates current target revisions and exact label IDs, never a saved plan", async () => tracker(async root => {
  const created = await item(root, "Target", ["bug"]);
  const input = request({ choices: { tags: "replace", filters: "keep", mappings: "replace" } });
  const before = snapshot(root);
  const plan = await planGithubLabelMigration(root, input, { readCatalog });
  assert.equal((await planGithubLabelMigration(root, input, { readCatalog, approval: plan.approval })).checked, true);
  assert.equal(snapshot(root), before);
  await assert.rejects(planGithubLabelMigration(root, request(), { readCatalog, approval: (await planGithubLabelMigration(root, request(), { readCatalog })).approval }), code("unresolved_choices"));
  for (const labels of [[target], [{ ...source, id: "LA_recreated" }, target], [{ ...source, name: "renamed" }, target]]) {
    await assert.rejects(planGithubLabelMigration(root, input, { readCatalog: async () => ({ complete: true, labels }), approval: plan.approval }), code("stale_labels"));
  }
  await assert.rejects(planGithubLabelMigration(root, input, { readCatalog: async () => ({ complete: true, labels: [source, target] }), approval: plan.approval }), code("stale_plan"));
  await update(created.id, { title: "Peer edited", parent: "none", clearDeps: true }, { pmRoot: root });
  await assert.rejects(planGithubLabelMigration(root, input, { readCatalog, approval: plan.approval }), code("stale_plan"));
  const edited = await planGithubLabelMigration(root, input, { readCatalog });
  await update(created.id, { title: created.title, parent: "none", clearDeps: true }, { pmRoot: root });
  await assert.rejects(planGithubLabelMigration(root, input, { readCatalog, approval: edited.approval }), code("stale_plan"));
  await assert.rejects(planGithubLabelMigration(root, input, { readCatalog, approval: plan.approval }), code("stale_plan"));
}));

test("strict bounded boundaries reject sparse arrays, extreme numbers and malformed policies alone", async () => tracker(async (root, directory) => {
  const valid = await planGithubLabelMigration(root, request({ filters: [], mappings: [] }), { readCatalog });
  assert.equal(valid.counts.total, 0);
  const invalid = [null, {}, { ...request(), extra: true }, { ...request(), sources: new Array(2) },
    { ...request(), sources: [] }, { ...request(), sources: [source, source] }, { ...request(), filters: new Array(3) },
    { ...request(), mappings: [request().mappings[0], request().mappings[0]] },
    { ...request(), sources: [{ ...source, name: "bug\r\n" }] }, { ...request(), choices: { tags: "infer" } }];
  for (const input of invalid) await assert.rejects(planGithubLabelMigration(root, input as GithubLabelMigrationInput, { readCatalog }), code("invalid_input"));
  for (const page of [{ limit: 0 }, { limit: 101 }, { limit: NaN }, { limit: Infinity }, { offset: -1 }, { offset: 0.5 }, { offset: 2 ** 53 }]) {
    await assert.rejects(planGithubLabelMigration(root, request(), { readCatalog, page }), code("invalid_input"));
  }
  for (const bad of [{ complete: false, labels: [] }, { complete: true, labels: new Array(3) }, { ...catalog, labels: [source, source] }]) {
    await assert.rejects(planGithubLabelMigration(root, request(), { readCatalog: async () => bad }), code("invalid_input"));
  }
  await assert.rejects(planGithubLabelMigration(root, request(), { readCatalog, approval: "bad" }), code("invalid_input"));
  await assert.rejects(planGithubLabelMigration(root, request(), { readCatalog: async () => { throw new Error("offline"); } }), code("catalog_unavailable"));
  await assert.rejects(planGithubLabelMigration(join(root, "missing"), request(), { readCatalog }), code("incomplete_read"));
  const file = join(directory, "input.json");
  writeFileSync(file, JSON.stringify(request(), null, 2).replaceAll("\n", "\r\n"));
  assert.deepEqual(readLabelMigrationJson(file), request());
  writeFileSync(file, "invalid");
  assert.throws(() => readLabelMigrationJson(file), code("invalid_input"));
  writeFileSync(file, " ".repeat(1048577));
  assert.throws(() => readLabelMigrationJson(file), code("invalid_input"));
  assert.throws(() => readLabelMigrationJson(directory), code("invalid_input"));
  assert.throws(() => readLabelMigrationJson(join(directory, "missing")), code("invalid_input"));
  symlinkSync(file, join(directory, "linked"));
  assert.throws(() => readLabelMigrationJson(join(directory, "linked")), code("invalid_input"));
  for (const extreme of [-1, NaN, Infinity, -Infinity, 2 ** 53, 0.5]) {
    for (const field of Object.keys(valid.counts)) assert.throws(() => validateGithubLabelMigrationReport({ ...valid, counts: { ...valid.counts, [field]: extreme } }), code("invalid_output"));
  }
  for (const output of [{ ...valid, rows: new Array(2) }, { ...valid, counts: { ...valid.counts, total: 1 } },
    { ...valid, counts: { ...valid.counts, items: 1 } }, { ...valid, counts: { ...valid.counts, review: 1 } },
    { ...valid, next: 0 }, { ...valid, next: 1 }, { ...valid, rows: [{ kind: "tags" }] }]) {
    assert.throws(() => validateGithubLabelMigrationReport(output), code("invalid_output"));
  }
  const complete = await planGithubLabelMigration(root, request(), { readCatalog });
  assert.throws(() => validateGithubLabelMigrationReport({ ...complete, offset: 9 }), code("invalid_output"));
  assert.throws(() => validateGithubLabelMigrationReport({ ...complete, rows: [], next: 0 }), code("invalid_output"));
  assert.equal((await planGithubLabelMigration(root, request(), { readCatalog, page: { offset: Number.MAX_SAFE_INTEGER } })).next, null);
}));

test("live catalog drains pages, preserves opaque IDs and refuses incomplete or redirected pagination", async () => {
  let mode = "pages";
  const server = await startMockGithub((req, res, _body, base) => {
    if (mode === "nonarray") return jsonResponse(res, 200, {});
    if (mode === "malformed") { res.end("not json"); return; }
    if (mode === "invalid") return jsonResponse(res, 200, [null]);
    if (mode === "duplicate") return jsonResponse(res, 200, [{ node_id: "same", name: "bug" }, { node_id: "same", name: "other" }]);
    if (mode === "foreign") res.setHeader("Link", '<https://example.invalid/labels>; rel="next"');
    if (mode === "cycle") res.setHeader("Link", `<${base}${req.url}>; rel="next"`);
    if (mode === "wrong-path") res.setHeader("Link", `<${base}/repos/other/repo/labels>; rel="next"`);
    if (mode === "large") return jsonResponse(res, 200, Array.from({ length: 101 }, () => ({ node_id: "id", name: "name" })));
    if (mode === "pages" && !req.url!.includes("page=2")) res.setHeader("Link", `<${base}/repos/fixture/repo/labels?page=2>; rel="next"`);
    jsonResponse(res, 200, [{ node_id: req.url!.includes("page=2") ? target.id : source.id, name: req.url!.includes("page=2") ? target.name : source.name, color: "ffffff" }]);
  });
  try {
    await withEnv({ PM_GITHUB_API_BASE: server.baseUrl, GITHUB_TOKEN: "fixture", GH_TOKEN: undefined }, async () => {
      assert.deepEqual(await readGithubLabelCatalog("fixture/repo"), { complete: true, labels: [source, target] });
      for (mode of ["nonarray", "malformed", "invalid", "duplicate", "foreign", "cycle", "wrong-path", "large"]) await assert.rejects(readGithubLabelCatalog("fixture/repo"), code("catalog_unavailable"));
      assert.ok(server.requests.every(req => req.method === "GET"));
      await assert.rejects(readGithubLabelCatalog("bad"), code("invalid_input"));
    });
  } finally { await server.close(); }
});

test("registered CLI returns compact host-renderable reports and typed input refusals", async () => tracker(async (root, directory) => {
  await item(root, "CLI target", ["bug"]);
  const input = join(directory, "request.json");
  const file = join(directory, "catalog.json");
  writeFileSync(input, JSON.stringify(request()));
  writeFileSync(file, JSON.stringify(catalog));
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "hooks", "preflight", "search", "importers"] });
  const run = async (options: Record<string, unknown>) => (await harness.runCommand({ command: "github labels plan", pmRoot: root, args: [], options })).result as GithubLabelMigrationReport;
  const result = await run({ input, catalog: file, limit: "1", offset: "0" });
  assert.equal(result.counts.items, 1);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(validateGithubLabelMigrationReport(decode(encode(result))), result);
  assert.deepEqual(validateGithubLabelMigrationReport(JSON.parse(JSON.stringify(result))), result);
  for (const options of [{}, { input: true }, { input, catalog: true }, { input, approve: true }, { input, catalog: file, limit: "Infinity" }]) await assert.rejects(run(options), code("invalid_input"));
  await assert.rejects(run({ input, catalog: file, approve: "f".repeat(64) }), code("stale_plan"));
  const server = await startMockGithub((_req, res) => jsonResponse(res, 200, catalog.labels.map(label => ({ node_id: label.id, name: label.name }))));
  try {
    await withEnv({ PM_GITHUB_API_BASE: server.baseUrl, GITHUB_TOKEN: "fixture" }, async () => {
      assert.equal((await run({ input })).counts.items, 1);
    });
  } finally { await server.close(); }
}));

test("500 SDK table wire permutations preserve producer rows, absent fields and JSON-looking strings", async () => tracker(async root => {
  await item(root, "Wire witness", ["one,two"]);
  const csv = { id: "CSV", name: "one,two" };
  const input = request({ sources: [csv], change: { kind: "rename", name: "null,[1],constructor" },
    filters: [{ id: "filter", labels: ["ONE,TWO"] }], mappings: [{ id: "mapping", from: "[1]", to: "one,two" }] });
  const readCatalog = async () => ({ complete: true, labels: [csv] });
  const report = await planGithubLabelMigration(root, input, { readCatalog });
  const terminal = await planGithubLabelMigration(root, input, { readCatalog, page: { offset: report.counts.total } });
  let seed = 0xc0dec123;
  /** Replayable integer choices vary sparse rows and their SDK encoding metadata. */
  function random(bound: number) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % bound; }
  let absentWire: { rows: ReturnType<typeof encodePmTableRows>["rows"]; rows_encoding: ReturnType<typeof encodePmTableRows>["encoding"] } | undefined;
  for (let sequence = 0; sequence < 500; sequence++) {
    const rows = [...report.rows];
    for (let i = rows.length - 1; i > 0; i--) { const j = random(i + 1); [rows[i], rows[j]] = [rows[j]!, rows[i]!]; }
    const producerRows = rows.map(row => {
      const value: Parameters<typeof encodePmTableRows>[0][number] = { ...row };
      if (row.kind !== "tags" && random(2)) delete value.after_tags;
      if (row.kind === "filters" && random(2)) delete value.local_tag;
      return value;
    });
    const table = encodePmTableRows(producerRows);
    const wire = { ...report, next: random(2) ? undefined : report.next, rows: table.rows, rows_encoding: table.encoding };
    const expected = { ...report, rows };
    assert.deepEqual(validateGithubLabelMigrationReport(JSON.parse(JSON.stringify(wire))), expected);
    assert.deepEqual(validateGithubLabelMigrationReport(decode(encode(wire))), expected);
    const compactTerminal: Record<string, unknown> = { ...terminal };
    if (random(2)) delete compactTerminal.rows;
    if (random(2)) delete compactTerminal.next;
    assert.deepEqual(validateGithubLabelMigrationReport(JSON.parse(JSON.stringify(compactTerminal))), terminal);
    assert.deepEqual(validateGithubLabelMigrationReport(decode(encode(compactTerminal))), terminal);
    assert.throws(() => validateGithubLabelMigrationReport({ ...terminal, rows: null }), code("invalid_output"));
    assert.throws(() => validateGithubLabelMigrationReport({ ...report, rows: undefined, next: random(2) ? undefined : 0 }), code("invalid_output"));
    if (table.encoding.absent.length) absentWire = wire;
    const extreme = [-1, NaN, Infinity, -Infinity, 2 ** 53, 0.5][sequence % 6]!;
    assert.throws(() => validateGithubLabelMigrationReport({ ...wire,
      rows_encoding: { ...table.encoding, absent: [[extreme, "id"]] } }), code("invalid_output"));
  }
  assert.ok(absentWire);
  assert.throws(() => validateGithubLabelMigrationReport({ ...report, ...absentWire,
    rows_encoding: { ...absentWire.rows_encoding, absent: [...absentWire.rows_encoding.absent, ...absentWire.rows_encoding.absent] } }), code("invalid_output"));
  const table = encodePmTableRows(report.rows);
  const wire = { ...report, rows: table.rows, rows_encoding: table.encoding };
  for (const value of ["not-json", "{}", "1e999"]) {
    assert.throws(() => validateGithubLabelMigrationReport({ ...wire, rows: table.rows.map(row => ({ ...row, after_tags: value })) }), code("invalid_output"));
  }
  for (const encoding of [{ ...table.encoding, json_columns: [...table.encoding.json_columns, ...table.encoding.json_columns] },
    { ...table.encoding, absent: [[report.rows.length, "id"]] }, { ...table.encoding, absent: [[0, "id"]] }]) {
    assert.throws(() => validateGithubLabelMigrationReport({ ...wire, rows_encoding: encoding }), code("invalid_output"));
  }
  assert.throws(() => validateGithubLabelMigrationReport({ ...wire, rows: [{ ...table.rows[0], foreign: "field" }] }), code("invalid_output"));
  const filterIndex = report.rows.findIndex(row => row.kind === "filters");
  const inherited = { ...wire, rows: table.rows.map(row => ({ ...row })),
    rows_encoding: { ...table.encoding, absent: [[filterIndex, "after_tags"]] } };
  delete inherited.rows[filterIndex]!.after_tags;
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "after_tags");
  try {
    Object.defineProperty(Object.prototype, "after_tags", { value: null, configurable: true, writable: true });
    assert.throws(() => validateGithubLabelMigrationReport(inherited), code("invalid_output"));
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, "after_tags", descriptor);
    else Reflect.deleteProperty(Object.prototype, "after_tags");
  }
}));

test("500 seeded model sequences replay older policies and preserve SDK-read native fields and relationships", async () => tracker(async root => {
  let seed = 0x1abe1200;
  /** Reproducible unsigned random integer; no floating-point boundary decisions. */
  const random = (bound: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % bound; };
  const parent = await item(root, "Ambient parent", []);
  const child = await item(root, "Stateful child", ["bug"]);
  const statuses: string[] = [];
  for (let i = 0; i < 3; i++) {
    const name = `custom-${random(100000)}`;
    const registered = await schemaAddStatus(name, { role: ["active"] }, { pmRoot: root });
    statuses.push(registered.status.id);
  }
  const policies: GithubLabelMigrationInput[] = [request()];
  let modelTags = ["bug"];
  for (let sequence = 0; sequence < 500; sequence++) {
    await focus(random(2) ? parent.id : child.id, {}, { pmRoot: root });
    // Native tag normalization comes only from the SDK producer, never a handwritten substitute.
    const raw = random(2) ? " bug , gh:fixture/repo#7, keep " : "keep, Bug";
    modelTags = toImportTags(raw);
    const status = statuses[random(statuses.length)]!;
    await update(child.id, { tags: raw, status, body: `Sequence ${sequence}\r\n retained whitespace  `,
      description: `Native description ${sequence}`, parent: parent.id,
      dep: [`id=${parent.id},kind=related`], priority: random(5), unset: ["sprint", "release", "goal", "objective"] }, { pmRoot: root });
    const before = (await get(child.id, {}, { pmRoot: root })).item;
    assert.deepEqual(before.tags, modelTags);
    assert.equal(before.parent, parent.id);
    assert.equal(before.status, status);
    assert.ok(Array.isArray(before.dependencies) && before.dependencies.length > 0);
    const spelling = ["bug", "BUG", "bUg", "Bug"][random(4)]!;
    const fresh = request({ filters: random(2) ? [{ id: "policy", labels: [spelling] }] : [], mappings: random(2) ? [{ id: "mapping", from: "bug", to: spelling }] : [],
      choices: { tags: random(2) ? "keep" : "replace", filters: "replace", mappings: "keep" } });
    policies.push(fresh);
    const selected = random(3) === 0 ? policies[random(policies.length)]! : fresh;
    const input = JSON.parse(JSON.stringify(selected, null, random(3)).replaceAll("\n", "\r\n")) as GithubLabelMigrationInput;
    const report = await planGithubLabelMigration(root, input, { readCatalog, page: { limit: random(5) + 1, offset: 0 } });
    // Every generated policy targets the selected source; case permutations cannot change that reference fact.
    const expected = { tags: modelTags.includes("bug") ? 1 : 0, filters: selected.filters.length, mappings: selected.mappings.length };
    assert.equal(report.counts.scanned, 2);
    for (const field of ["tags", "filters", "mappings"] as const) assert.equal(report.counts[field], expected[field], `sequence ${sequence}: ${field}`);
    assert.equal(report.counts.total, expected.tags + expected.filters + expected.mappings);
    assert.deepEqual(validateGithubLabelMigrationReport(decode(encode(report))), report);
    assert.deepEqual(validateGithubLabelMigrationReport(JSON.parse(JSON.stringify(report))), report);
    assert.deepEqual((await get(child.id, {}, { pmRoot: root })).item, before, `sequence ${sequence}: SDK state preserved`);
  }
}));
