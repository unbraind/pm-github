/** Measure read-only capture plans on a public tracker snapshot and public issue comments. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encode } from "@toon-format/toon";
import { PmClient, createExtensionCommandSdk, certifyCompleteListResult } from "@unbrained/pm-cli/sdk";
import { captureGithubDiscussion } from "../index.ts";

/** Hash the selected snapshot only, including any attempted runtime side effects. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}

const [root, commentsFile, mode] = process.argv.slice(2);
assert.ok(root && commentsFile, "Supply a read-only public tracker snapshot and public issue-comment response");
assert.ok(mode === undefined || mode === "readonly", "Optional mode must be readonly");
const client = new PmClient({ pmRoot: root, noExtensions: true, author: "fixture" });
const sdk = createExtensionCommandSdk(root, client);
const comments = JSON.parse(readFileSync(commentsFile, "utf8")) as { id: number; body: string }[];
const corpus = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
const before = fingerprint(root);
const byId = new Map(comments.map(comment => [comment.id, comment]));
const readComment = async (_repo: string, _issue: number, id: number) => byId.get(id);
let planned = 0;
let repeated = 0;
let unmarked = 0;
let jsonBytes = 0;
let toonBytes = 0;
let nativeRefusals = 0;
const sample = corpus.items.filter((_item, index) => index % Math.max(1, Math.floor(corpus.items.length / 24)) === 0).slice(0, mode === "readonly" ? 1 : 24);
for (const item of sample) {
  const selected = comments[planned % comments.length]!;
  const quote = selected.body.slice(0, 160);
  const input = { repo: "unbraind/pm-github", issue: 143, item: item.id,
    selections: [{ comment: selected.id, start: 0, end: quote.length, quote, marked: true as const }] };
  const report = await captureGithubDiscussion(root, input, sdk, { readComment });
  assert.equal(report.rows[0]!.state, mode === "readonly" ? "refused" : "create");
  if (report.rows[0]!.state === "create") planned++;
  else { assert.equal(report.rows[0]!.reason, "native_refused"); nativeRefusals++; }
  jsonBytes = Math.max(jsonBytes, Buffer.byteLength(JSON.stringify(report)));
  toonBytes = Math.max(toonBytes, Buffer.byteLength(encode(report)));
  assert.deepEqual(await captureGithubDiscussion(root, input, sdk, { readComment }), report); repeated++;
  assert.equal((await captureGithubDiscussion(root, { ...input, selections: [] }, sdk, { readComment })).selected, 0); unmarked++;
}
assert.equal(fingerprint(root), before);
console.log(JSON.stringify({ public_issue: 143, public_comments: comments.length, items: corpus.items.length, sampled_items: sample.length, selected_plans: planned, native_refusals: nativeRefusals,
  repeated_previews: repeated, unmarked_zero_plans: unmarked, max_json_bytes: jsonBytes, max_toon_bytes: toonBytes,
  tracker_writes: 0, remote_writes: 0, snapshot_unchanged: true }));
