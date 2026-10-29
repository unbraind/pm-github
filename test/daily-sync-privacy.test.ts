/** Precision corpora retain refusal of host data while admitting source syntax. */
import assert from "node:assert/strict";
import test from "node:test";
import { scanLineForRuleHits } from "../gate.ts";

const mustAllow = [
  "const re = /private paused = true;/;", "const re = /private paused = true;/g.test(source);",
  "const list = [/private paused = true;/, /ordinary/];",
  "https://example.invalid/private/path", "https://example.invalid/home/path", "GET /api/items", "./private/path", "src/home/path",
  "git@github.com:fixture/project.git", "ssh://git@github.com/fixture/project.git", "ssh://git@github.com:2222/fixture/project.git",
  "noreply@example.invalid", "bot@users.noreply.github.com", "no-reply@example.invalid",
];
const mustRefuse = [
  ...["home", "private", "tmp", "etc", "mnt", "Users"].map(root => "/" + root + "/fixture/report"),
  "C:" + "\\Users\\fixture\\report.txt", "C:" + "/Users/fixture/report.txt", "fixture.person@example.invalid",
  "ssh://person@example.invalid/repo.git", "git@github.com", "git@github.com: contact", "ssh://git@github.com: contact",
  'const path = "/' + 'home sample/";', "const re = /home/fixture/;", "const re = /private paused = true;",
];

test("must-allow corpus covers regex literals, URL and repository paths, API routes and bot identities", () => {
  for (const text of mustAllow) assert.deepEqual(scanLineForRuleHits(text), [], text);
});
test("must-refuse corpus keeps real POSIX paths, Windows paths and contact addresses fail-closed", () => {
  for (const text of mustRefuse) assert.ok(scanLineForRuleHits(text).length > 0, text);
});
