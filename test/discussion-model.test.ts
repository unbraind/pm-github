/** Seeded state-machine oracle normalizes only by writing and reading native SDK state. */
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { decode, encode } from "@toon-format/toon";
import { init, PmClient, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { captureGithubDiscussion, validateDiscussionCaptureReport, type DiscussionCaptureInput } from "../index.ts";
import { discussionTracker, discussionSource, discussionRequest } from "./helpers/discussions.ts";

test("500 seeded operation sequences preserve all touched native fields, relations, historical inputs and JSON/TOON round trips", async () => {
  await discussionTracker(async (root, sdk, parent, directory) => {
    const referenceRoot = join(directory, "reference");
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { cwd: directory, pmRoot: referenceRoot, noExtensions: true });
    const reference = new PmClient({ pmRoot: referenceRoot, author: "fixture", noExtensions: true });
    const scope = { parent: "none", clearDeps: true, unset: ["sprint", "release", "goal", "objective"] };
    await reference.create({ id: parent, title: "Issue context", type: "Task", ...scope });
    const ambient = (await sdk.client.create({ title: "Ambient context", type: "Task", ...scope })).item.id;
    const other = (await sdk.client.create({ title: "Related native task", type: "Task", ...scope })).item.id;
    const sources = new Map<number, ReturnType<typeof discussionSource>>();
    const older: DiscussionCaptureInput[] = [];
    const model = new Map<string, string>();
    const expected = new Map<string, string>();
    let seed = 0xdec1510;
    /** Reproducible exact integer choices, including boundary and replay operations. */
    function random(bound: number): number { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % bound; }
    const statuses: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = `custom-${random(100000)}`;
      statuses.push((await sdk.client.schemaAddStatus(name, { role: [i === 4 ? "blocked" : "active"] })).status.id);
    }
    const projection = { fields: "id,type,title,status,description,body,parent,dependencies,sprint,release,goal,objective,tags,docs,priority" };
    let operations = 0;
    let creates = 0;
    let replays = 0;
    let stale = 0;
    for (let sequence = 0; sequence < 500; sequence++) {
      await sdk.client.focus(random(2) ? ambient : other);
      const parentOptions = { body: `Native body ${random(9)}\r\n preserved  `, description: `Native description ${random(12)}`,
        tags: random(2) ? "KEEP, native" : "native", status: statuses[random(statuses.length)]!,
        parent: "none", dep: [`id=${other},kind=related`], unset: ["sprint", "release", "goal", "objective"] };
      await sdk.client.update(parent, parentOptions);
      const nativeBefore = (await sdk.client.get(parent, projection)).item;
      // Bound the state population while retaining 500 independent random operation sequences.
      // Reusing prior revisions exercises idempotency without quadratic staging-copy growth.
      const sourceId = 20 + random(2);
      const raw = `${random(2) ? "  " : ""}Decision ${random(2)}${random(2) ? "\r\n" : "\n"}keep exact bytes${random(2) ? "  " : ""}`;
      sources.set(sourceId, { ...discussionSource(raw, sourceId), updated_at: `2026-10-0${raw.includes("Decision 1") ? 2 : 1}T00:00:00Z` });
      const source = sources.get(sourceId)!;
      let input = discussionRequest(parent, source);
      if (older.length && random(3) === 0) { input = older[random(older.length)]!; replays++; }
      else older.push(input);
      const readComment = async (_repo: string, _issue: number, id: number) => sources.get(id);
      const plan = await captureGithubDiscussion(root, input, sdk, { readComment }); operations++;
      const wireInput = (random(2) ? JSON.parse(JSON.stringify(input)) : decode(encode(input))) as DiscussionCaptureInput;
      const wirePlan = validateDiscussionCaptureReport(random(2) ? JSON.parse(JSON.stringify(plan)) : decode(encode(plan)));
      assert.deepEqual(wirePlan, plan);
      assert.deepEqual(await captureGithubDiscussion(root, wireInput, sdk, { readComment }), plan, "preview verdict uses the same boundary and preparation as apply"); operations++;
      const selectedSource = sources.get(input.selections[0]!.comment)!;
      const selection = input.selections[0]!;
      const selectable = selectedSource.body.slice(selection.start, selection.end) === selection.quote && selection.end <= selectedSource.body.length;
      assert.equal(plan.refused, selectable ? 0 : 1, `reference selection ${sequence}`);
      if (!selectable) { assert.deepEqual((await sdk.client.get(parent, projection)).item, nativeBefore); continue; }
      const evidence = { type: "github.discussion-decision.v1", repo: "fixture/repo", issue: 3, comment: selectedSource.id,
        url: selectedSource.html_url, revision: createHash("sha256").update(JSON.stringify([selectedSource.id, selectedSource.body, selectedSource.issue_url, selectedSource.html_url, selectedSource.updated_at, selectedSource.user.id, selectedSource.user.login])).digest("hex"),
        author: selectedSource.user, updatedAt: selectedSource.updated_at, span: { start: selection.start, end: selection.end, quote: selection.quote } };
      assert.deepEqual(plan.rows[0]!.evidence, evidence);
      const modelKey = JSON.stringify(evidence);
      const id = plan.rows[0]!.id;
      if (model.has(modelKey)) assert.equal(id, model.get(modelKey));
      if (random(7) === 0) {
        sources.set(selectedSource.id, { ...selectedSource, updated_at: "2026-10-29T00:00:00Z" });
        await assert.rejects(captureGithubDiscussion(root, wireInput, sdk, { readComment, approval: wirePlan.approval }), (error: unknown) => (error as { code: string }).code === "stale_plan");
        sources.set(selectedSource.id, selectedSource); stale++; operations++;
      }
      const applied = await captureGithubDiscussion(root, wireInput, sdk, { readComment, approval: wirePlan.approval }); operations++;
      assert.equal(applied.created, model.has(modelKey) ? 0 : 1);
      if (!model.has(modelKey)) {
        model.set(modelKey, id); creates++;
        const status = resolveRuntimeStatusRegistry((await readSettings(root)).schema).open_status;
        await reference.create({ id, type: "Decision", title: "GitHub issue #3 decision", status,
          description: `Selected GitHub issue-comment evidence: ${evidence.url}`, body: JSON.stringify(evidence),
          parent, clearDeps: true, unset: ["sprint", "release", "goal", "objective"], tags: "github-discussion-decision",
          doc: [`path: ${evidence.url}\nscope: project\nnote: Source revision ${evidence.revision}`] });
        expected.set(id, modelKey);
      }
      const actualItem = (await sdk.client.get(id, projection)).item;
      const expectedItem = (await reference.get(id, projection)).item;
      // The oracle delegates every native conversion to a second real SDK tracker.
      for (const field of ["id", "type", "title", "status", "description", "body", "parent", "dependencies", "sprint", "release", "goal", "objective", "tags", "docs"] as const) {
        assert.deepEqual(actualItem[field], expectedItem[field], `SDK state ${field}, sequence ${sequence}`);
      }
      assert.deepEqual((await sdk.client.get(parent, projection)).item, nativeBefore, "capture never changes the existing related item");
      const repeated = await captureGithubDiscussion(root, wireInput, sdk, { readComment, approval: wirePlan.approval }); operations++;
      assert.equal(repeated.created, 0); assert.equal(repeated.unchanged + repeated.skipped, 1);
    }
    const finalItems = (await sdk.client.listAllComplete({ includeBody: true })).items.filter(item => item.type === "Decision");
    assert.equal(finalItems.length, expected.size);
    for (const item of finalItems) { assert.equal(typeof item.body, "string"); assert.deepEqual(JSON.parse(String(item.body)), JSON.parse(expected.get(item.id)!)); }
    assert.ok(creates > 20 && replays > 100 && stale > 20);
    console.log(JSON.stringify({ sequences: 500, seed: "0xdec1510", operations, creates, older_input_replays: replays, stale, model_items: expected.size }));
  });
});
