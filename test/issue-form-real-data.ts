/** Measure form completion on a read-only public tracker snapshot outside git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encode } from "@toon-format/toon";
import { listAllComplete, certifyCompleteListResult } from "@unbrained/pm-cli/sdk";
import { compileIssueForm, completeIssueForm } from "../issue-forms.ts";

/** Fingerprint every file; the adapter must not mutate even derived runtime state. */
function digest(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? digest(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}

const [root, formFile, formRevision] = process.argv.slice(2);
assert.ok(root && formFile && formRevision, "Pass a public tracker snapshot, selected form file and public form revision");
const complete = await listAllComplete({}, { pmRoot: root, noExtensions: true });
certifyCompleteListResult(complete);
const request = { repo: "unbraind/pm-cli", ref: formRevision, path: ".github/ISSUE_TEMPLATE/feature-request.yml",
  yaml: readFileSync(formFile, "utf8"), bindings: { problem: "description", solution: "acceptance_criteria", context: "body" }, answers: { area: "Extensions and hooks" } };
const contract = compileIssueForm(request);
const before = digest(root);
let ready = 0;
let incomplete = 0;
let repairs = 0;
let replayed = 0;
const jsonBytes: number[] = [];
const toonBytes: number[] = [];
const reasons: Record<string, number> = {};
for (const item of complete.items) {
  const result = await completeIssueForm(root, { ...request, item: item.id });
  jsonBytes.push(Buffer.byteLength(JSON.stringify(result.report)));
  toonBytes.push(Buffer.byteLength(encode(result.report)));
  if (result.report.ok) ready++; else incomplete++;
  repairs += result.report.checklist.length + result.report.omitted;
  for (const entry of result.report.checklist) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
  assert.deepEqual(await completeIssueForm(root, { ...request, item: item.id }), result);
  replayed++;
}
assert.equal(digest(root), before);
console.log(JSON.stringify({ items: complete.items.length, fields: contract.fields.length, required: contract.fields.filter(field => field.required).length,
  ready, incomplete, repairs, reasons, replayed, max_json_bytes: Math.max(0, ...jsonBytes), max_toon_bytes: Math.max(0, ...toonBytes), tracker_writes: 0, remote_writes: 0, source_unchanged: true }));
