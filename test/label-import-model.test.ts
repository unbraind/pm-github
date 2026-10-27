/** Planner/importer agreement is measured through SDK writes and read-back in disposable non-git trackers. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode, encode } from "@toon-format/toon";
import { init, create, update, get, normalizeItemId, readSettings, mutateItem } from "@unbrained/pm-cli/sdk";
import { buildAtomicImportMutations, githubLabelsToTags, parseImportOptions, planGithubLabelMigration,
  prepareGithubImport, validateGithubLabelMigrationReport, verifyImportIdempotency, type GhIssue, type PmItem } from "../index.ts";
import { refreshChanges } from "../refresh.ts";
import { normalizeImportValue } from "../import-fidelity.ts";
import { withEnv } from "./helpers/mock-github-server.ts";

test("shared importer conversion covers legacy refresh deltas and every native mutation path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-label-import-paths-"));
  const root = join(directory, "tracker");
  try {
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", GIT_CEILING_DIRECTORIES: dirname(directory), PATH: directory }, async () => {
      await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
      const scope = { parent: "none", clearDeps: true, unset: ["sprint", "release", "goal", "objective"] };
      const repo = "fixture/repo";
      const raw = [" One,TWO ", "ONE", " GH:FIXTURE/REPO#1 "];
      const expected = (await create({ title: "SDK reference", type: "Task", tags: raw.join(","), ...scope }, { pmRoot: root })).item;
      const match = (await create({ title: "Legacy target", type: "Task", tags: "old", ...scope }, { pmRoot: root })).item;
      const settings = await readSettings(root);
      const issue: GhIssue = { number: 1, title: "Legacy target", body: "", state: "open", labels: [{ name: " One,TWO " }, { name: "ONE" }],
        assignee: null, milestone: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
        html_url: `https://github.com/${repo}/issues/1` };
      const prepared = (await prepareGithubImport(issue, repo, parseImportOptions({}), undefined, match, undefined,
        { items: [match], releases: [], timeline: async () => [] }))!;
      assert.deepEqual(prepared.tags, expected.tags);
      assert.deepEqual(githubLabelsToTags(raw), expected.tags);
      await mutateItem({ pmRoot: root, settings, id: match.id, author: "fixture", op: "update", mutate: document => {
        document.metadata.tags = raw;
        return { changedFields: ["tags"] };
      } });
      const nativeReference = (await get(match.id, {}, { pmRoot: root })).item;
      assert.deepEqual(normalizeImportValue("tags", raw), nativeReference.tags);
      assert.notDeepEqual(nativeReference.tags, expected.tags, "native array atoms and provider CSV labels have distinct domains");
      const legacy = { ...prepared, tags: raw };
      assert.deepEqual(refreshChanges(legacy).find(change => change.field === "tags")!.new, expected.tags);
      assert.ok(!refreshChanges({ ...legacy, match: { ...match, tags: expected.tags } }).some(change => change.field === "tags"));
      for (const updateOnly of [false, true]) {
        const plan = buildAtomicImportMutations(repo, legacy, settings.id_prefix, normalizeItemId, updateOnly);
        const mutation = plan.mutations[0]!;
        assert.equal(mutation.op, "update");
        if (mutation.op !== "update") throw new Error("Expected update");
        assert.equal(mutation.options.tags, expected.tags!.join(","));
      }
      const created = buildAtomicImportMutations(repo, { ...legacy, match: undefined }, settings.id_prefix, normalizeItemId);
      for (const mutation of created.mutations) {
        assert.ok(mutation.op === "create" || mutation.op === "update");
        if (mutation.op === "create" || mutation.op === "update") assert.equal(mutation.options.tags, expected.tags!.join(","));
      }
      const linked = buildAtomicImportMutations(repo, { ...legacy, linkOnly: true }, settings.id_prefix, normalizeItemId);
      const linkedMutation = linked.mutations[0]!;
      if (linkedMutation.op !== "update") throw new Error("Expected link-only update");
      assert.deepEqual((linkedMutation.options as Record<string, unknown>).addTags, expected.tags);
      for (const linkOnly of [true, false]) {
        const before = (await get(match.id, {}, { pmRoot: root })).item;
        const retained = { ...prepared, match: before, tags: [...before.tags!, "fresh"], linkOnly,
          identity: { via: linkOnly ? "provider-link" : "citation" } };
        const retainedPlan = buildAtomicImportMutations(repo, retained, settings.id_prefix, normalizeItemId);
        const mutation = retainedPlan.mutations[0]!;
        if (mutation.op !== "update") throw new Error("Expected retained-owner update");
        await update(match.id, { ...mutation.options, ...scope }, { pmRoot: root });
        const actual = (await get(match.id, {}, { pmRoot: root })).item;
        assert.ok(actual.tags!.includes("one,two"));
        assert.ok(!actual.tags!.includes("two"), "retaining a native comma atom must not invent an additional tag");
        assert.equal(mutation.options.tags, undefined, "existing native state must not travel through a CSV replacement");
        assert.ok((mutation.options.addTags as string[]).every(tag => !tag.includes(",")));
        assert.ok(!refreshChanges({ ...retained, match: actual }).some(change => change.field === "tags"));
      }
      verifyImportIdempotency([], [{ ...legacy, match: undefined }], repo);
      verifyImportIdempotency([], [{ ...legacy, identity: { via: "citation" } }], repo);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("500 random label sets predict the importer's actual SDK tag changes and approval choices", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-label-import-model-"));
  const root = join(directory, "tracker");
  try {
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", GIT_CEILING_DIRECTORIES: dirname(directory), PATH: directory }, async () => {
      await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
      const native = (await create({ title: "Import witness", type: "Task", parent: "none", clearDeps: true,
        unset: ["sprint", "release", "goal", "objective"] }, { pmRoot: root })).item;
      const settings = await readSettings(root);
      const options = parseImportOptions({});
      const repo = "fixture/repo";
      const provenance = `gh:${repo}#1`;
      const issue: GhIssue = { number: 1, title: "Import witness", body: "Native field witness\r\n whitespace  ", state: "open",
        labels: [], assignee: null, milestone: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
        html_url: `https://github.com/${repo}/issues/1` };
      const current = new Map<string, PmItem>([[native.id, native]]);
      /** Execute the dry-run import's real mutation on its disposable witness; read the result through the SDK. */
      async function imported(names: string[]) {
        const match = current.get(native.id)!;
        const entry = (await prepareGithubImport({ ...issue, labels: names.map(name => ({ name })) }, repo, options, undefined, match,
          undefined, { items: [match], releases: [], timeline: async () => [] }))!;
        const plan = buildAtomicImportMutations(repo, entry, settings.id_prefix, normalizeItemId);
        assert.equal(plan.mutations.length, 1);
        const mutation = plan.mutations[0]!;
        assert.equal(mutation.op, "update");
        if (mutation.op !== "update") throw new Error("Expected an existing-target import");
        await update(native.id, { ...mutation.options, parent: "none", clearDeps: true,
          unset: ["sprint", "release", "goal", "objective"] }, { pmRoot: root });
        const actual = (await get(native.id, {}, { pmRoot: root })).item;
        current.set(native.id, actual);
        assert.deepEqual(entry.tags, actual.tags, "the importer preview must expose exactly the tags its writer produces");
        assert.deepEqual(normalizeImportValue("tags", actual.tags), actual.tags);
        assert.deepEqual(refreshChanges({ ...entry, tags: [...names, provenance] }).find(change => change.field === "tags")!.new,
          actual.tags, "refresh previews expose the writer's complete normalized tags even for replayed raw plans");
        const refresh = { ...entry, match: actual };
        assert.ok(!refreshChanges(refresh).some(change => change.field === "tags"), "a replay must not invent a tag change");
        // A previous release's raw plan is still compared through the shared converter.
        assert.ok(!refreshChanges({ ...refresh, tags: [...names, provenance] }).some(change => change.field === "tags"));
        verifyImportIdempotency([actual], [{ ...entry, match: undefined, tags: [` ${provenance.toUpperCase()} `] }], repo);
        return actual;
      }
      let seed = 0x1abe1c52;
      /** Seeded integer choices keep boundary decisions exact and replayable. */
      function random(bound: number) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % bound; }
      const words = ["one", "TWO", "Bug Fix", "kind/BUG", "scope:One", "tags: TWO", "constructor", "__proto__", "İ"];
      /** Generate provider names with embedded CSV delimiters and normalization collisions. */
      function name() {
        const first = words[random(words.length)]!;
        const second = words[random(words.length)]!;
        return ` ${first}${random(2) ? ` , ${second}, ${first.toLowerCase()}` : ""} `;
      }
      for (let sequence = 0; sequence < 500; sequence++) {
        const names = Array.from({ length: 1 + random(4) }, name);
        if (sequence % 3 === 0) names.push(names[0]!.toUpperCase());
        const sources = names.map((name, index) => ({ id: `SOURCE_${index}`, name }));
        const destination = { id: "TARGET", name: `migration-${sequence},${name()}` };
        const readCatalog = async () => ({ complete: true, labels: [...sources, destination] });
        const before = await imported(names);
        const input = { repo, sources, change: { kind: "consolidate", target: destination } as const,
          filters: [], mappings: [], choices: { tags: "review", filters: "keep", mappings: "keep" } as const };
        const report = await planGithubLabelMigration(root, input, { readCatalog, page: { limit: 100 } });
        const affected = [...new Set(report.rows.map(row => row.before))].sort();
        assert.deepEqual(affected, before.tags!.filter(tag => tag !== provenance).sort(), `source impacts ${sequence}`);
        assert.equal(report.counts.tags, report.rows.length);
        assert.equal(report.counts.items, 1);
        assert.equal(report.next, null);
        await assert.rejects(planGithubLabelMigration(root, input, { readCatalog, approval: report.approval, page: { limit: 1 } }),
          (error: unknown) => (error as { code: string }).code === "unresolved_choices");
        assert.deepEqual((await get(native.id, {}, { pmRoot: root })).item, before, "preview and approval preserve every SDK field");
        assert.deepEqual(validateGithubLabelMigrationReport(decode(encode(report))), report);
        assert.deepEqual(validateGithubLabelMigrationReport(JSON.parse(JSON.stringify(report))), report);
        const after = await imported([destination.name]);
        const afterTags = after.tags!.filter(tag => tag !== provenance);
        for (const row of report.rows) assert.deepEqual(row.after_tags, afterTags, `destination impacts ${sequence}`);
        const projected = [...new Set([...before.tags!.filter(tag => !affected.includes(tag)), ...report.rows.flatMap(row => row.after_tags!)])].sort();
        assert.deepEqual(projected, [...after.tags!].sort(), `predicted tag changes equal actual dry-run import ${sequence}`);
        await assert.rejects(planGithubLabelMigration(root, input, { readCatalog, approval: report.approval }),
          (error: unknown) => (error as { code: string }).code === "stale_plan");
      }
      assert.deepEqual(githubLabelsToTags([",,,"]), []);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("500 native tag arrays keep literal identities and refresh decisions equal SDK import writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-native-label-model-"));
  const root = join(directory, "tracker");
  try {
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", GIT_CEILING_DIRECTORIES: dirname(directory), PATH: directory }, async () => {
      await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
      const scope = { parent: "none", clearDeps: true, unset: ["sprint", "release", "goal", "objective"] };
      const target = (await create({ title: "Native witness", type: "Task", ...scope }, { pmRoot: root })).item;
      const settings = await readSettings(root);
      const repo = "fixture/repo";
      const provenance = `gh:${repo}#1`;
      const issue: GhIssue = { number: 1, title: "Native witness", body: "", state: "open", labels: [], assignee: null, milestone: null,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", html_url: `https://github.com/${repo}/issues/1` };
      let seed = 0x3c0a5e;
      /** Deterministic choices include equal native sets and comma atoms with unequal CSV expansions. */
      function random(bound: number) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % bound; }
      const words = ["one", "two", "Bug Fix", "kind/BUG", "scope:One", "constructor", "__proto__", "İ"];
      for (let sequence = 0; sequence < 500; sequence++) {
        const first = sequence === 0 ? "one" : words[random(words.length)]!;
        const second = sequence === 0 ? "two" : words[random(words.length)]!;
        const name = `${first},${second}`;
        const variants = [[name], [` ${first.toUpperCase()} , ${second} `], [first.toUpperCase(), ` ${second} `], [name, first]];
        const stored = variants[sequence % variants.length]!;
        await mutateItem({ pmRoot: root, settings, id: target.id, author: "fixture", op: "update", mutate: document => {
          document.metadata.tags = [...stored, provenance];
          return { changedFields: ["tags"] };
        } });
        const before = (await get(target.id, {}, { pmRoot: root })).item;
        const source = { id: "SOURCE", name };
        const input = { repo, sources: [source], change: { kind: "rename", name: "replacement,next" } as const,
          filters: [], mappings: [], choices: { tags: "review", filters: "keep", mappings: "keep" } as const };
        const readCatalog = async () => ({ complete: true, labels: [source] });
        const report = await planGithubLabelMigration(root, input, { readCatalog });
        if (sequence === 0) assert.equal((await planGithubLabelMigration(root, input, { readCatalog, approval: report.approval })).checked, true);
        const entry = (await prepareGithubImport({ ...issue, labels: [{ name }] }, repo, parseImportOptions({}), undefined, before,
          undefined, { items: [before], releases: [], timeline: async () => [] }))!;
        const delta = refreshChanges(entry).find(change => change.field === "tags");
        const refreshPlan = buildAtomicImportMutations(repo, entry, settings.id_prefix, normalizeItemId, true);
        const fullPlan = buildAtomicImportMutations(repo, entry, settings.id_prefix, normalizeItemId);
        const mutation = fullPlan.mutations[0]!;
        if (mutation.op !== "update") throw new Error("Expected existing-target SDK import");
        // Execute the full import independently of the refresh's changed-field decision.
        await update(target.id, { ...mutation.options, ...scope }, { pmRoot: root });
        const actual = (await get(target.id, {}, { pmRoot: root })).item;
        const changed = JSON.stringify(before.tags) !== JSON.stringify(actual.tags);
        if (sequence === 0) await assert.rejects(planGithubLabelMigration(root, input, { readCatalog, approval: report.approval }),
          (error: unknown) => (error as { code: string }).code === "stale_plan");
        assert.equal(Boolean(delta), changed, `refresh must compare actual native state ${sequence}`);
        if (delta) assert.deepEqual(delta.new, actual.tags, `refresh output ${sequence}`);
        const refreshMutation = refreshPlan.mutations[0]!;
        if (refreshMutation.op !== "update") throw new Error("Expected refresh update");
        assert.equal(Object.hasOwn(refreshMutation.options, "tags"), changed, `refresh write selection ${sequence}`);
        const desired = new Set(actual.tags!.filter(tag => tag !== provenance));
        const affected = before.tags!.filter(tag => desired.has(tag));
        assert.deepEqual(report.rows.map(row => row.before).sort(), [...affected].sort(), `native identities ${sequence}`);
        assert.ok(report.rows.every(row => before.tags!.includes(row.local_tag!)), "every emitted identity must exist in SDK state");
        assert.equal(report.counts.tags, affected.length);
        assert.equal(report.counts.items, affected.length ? 1 : 0);
        assert.equal(report.counts.total, affected.length);
        assert.equal(report.counts.review, affected.length);
        assert.deepEqual(validateGithubLabelMigrationReport(decode(encode(report))), report);
        assert.deepEqual(validateGithubLabelMigrationReport(JSON.parse(JSON.stringify(report))), report);
        assert.ok(!refreshChanges({ ...entry, match: actual }).some(change => change.field === "tags"), "replayed import reads current native state");
      }
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
