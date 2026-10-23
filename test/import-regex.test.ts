/** Compatibility and time bounds for regex consumers of imported GitHub text. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { matchImportedIssue, trimLocatorPunctuation } from "../import-fidelity.ts";
import { scanLineForRuleHits } from "../gate.ts";
import { githubApiBase, type GhIssue } from "../index.ts";
import { withEnv } from "./helpers/mock-github-server.ts";

const url = "https://github.com/fixture/project/issues/42";
const issue: GhIssue = { number: 42, title: "Fixture", body: "", state: "open", labels: [],
  assignee: null, milestone: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", html_url: url };

test("ownership declaration parity with citation adoption disabled: colon, whitespace and missing URL", () => {
  const rows: ReadonlyArray<readonly [string, boolean]> = [
    [`GitHub issue ${url}`, true], [`GitHub issue   ${url}`, true],
    [`GitHub issue\t${url}`, true], [`GitHub issue: ${url}`, true],
    [`GitHub issue \t:\t ${url}`, true], [`gItHuB IsSuE:\n${url}`, true],
    [`GitHub issue:${url}`, false], [`GitHub issue :${url}`, false],
    [`GitHub issue${url}`, false], ["GitHub issue   ", false],
    ["GitHub issue: \t", false], ["GitHub issue: not a URL", false],
    [`GitHub issue ${url}\tmore prose`, true],
  ];
  for (const [description, expected] of rows) {
    const old = /^GitHub issue\s*:?\s+(https?:\/\/[^\s]+)\s*/i.exec(description)?.[1];
    assert.equal(old === url, expected, description);
    assert.equal(matchImportedIssue([{ id: "owner", description }], issue, undefined, false).via,
      expected ? "github-declaration" : "new", description);
  }
  // Enumerate separators on both sides of the optional colon, including all JS whitespace.
  const whitespace = ["", " ", "\t", "\n", "\r", "\v", "\f", "\u00a0", "\u1680", "\u2000", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", " \t  "];
  for (const before of whitespace) for (const colon of ["", ":"]) for (const after of whitespace) {
    const description = `GitHub issue${before}${colon}${after}${url}`;
    const old = /^GitHub issue\s*:?\s+(https?:\/\/[^\s]+)\s*/i.exec(description)?.[1];
    assert.equal(matchImportedIssue([{ id: "owner", description }], issue, undefined, false).via,
      old === url ? "github-declaration" : "new", JSON.stringify(description));
  }
  const citing = matchImportedIssue([{ id: "citing", description: `GitHub issue:${url}` }], issue);
  assert.equal(citing.via, "citation");
  assert.equal(citing.linkOnly, false);
});

test("locator punctuation trim parity table", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["", ""], ["plain", "plain"], ["),.;", ""], ["plain)", "plain"],
    ["plain,", "plain"], ["plain.", "plain"], ["plain;", "plain"],
    ["plain)),..;;", "plain"], ["a)b,c.d;e", "a)b,c.d;e"],
    ["plain) ", "plain) "], ["plain)\n", "plain)\n"], ["plain)))x", "plain)))x"],
    [url + "),.;", url], [url + "/);", url + "/"],
  ];
  for (const [input, expected] of rows) {
    assert.equal(input.replace(/[),.;]+$/, ""), expected);
    assert.equal(trimLocatorPunctuation(input), expected);
  }
  assert.equal(matchImportedIssue([{ id: "owner", links: url + "),.;" }], issue).item?.id, "owner");
  assert.equal(matchImportedIssue([{ id: "owner", links: url + "))x" }], issue).item, undefined);
  assert.equal(trimLocatorPunctuation(url + ":!]}", "),.;:!]}"), url);
  assert.equal(trimLocatorPunctuation(url + ":!]}"), url + ":!]}");
});

test("ownership whitespace trigger: 200000 spaces finish under 50 ms", t => {
  const description = "GitHub issue" + " ".repeat(200_000);
  matchImportedIssue([{ id: "warmup", description: "GitHub issue " }], issue);
  let elapsed = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    const start = performance.now();
    const result = matchImportedIssue([{ id: "owner", description }], issue);
    elapsed = Math.min(elapsed, performance.now() - start);
    assert.equal(result.item, undefined);
  }
  t.diagnostic(`ownership 200000 spaces (best of 3): ${elapsed.toFixed(3)} ms`);
  assert.ok(elapsed < 50, `ownership took ${elapsed.toFixed(3)} ms; limit 50 ms`);
});

test("locator punctuation trigger: 200000 parentheses finish under 50 ms", t => {
  // A non-punctuation sentinel forces the old unanchored suffix regex to retry every start.
  const body = url + ")".repeat(200_000) + "x";
  trimLocatorPunctuation("warmup)");
  let elapsed = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    const start = performance.now();
    const result = matchImportedIssue([], { ...issue, body });
    elapsed = Math.min(elapsed, performance.now() - start);
    assert.equal(result.item, undefined);
  }
  t.diagnostic(`locator 200000 parentheses plus sentinel (best of 3): ${elapsed.toFixed(3)} ms`);
  assert.ok(elapsed < 50, `locator took ${elapsed.toFixed(3)} ms; limit 50 ms`);
  assert.equal(trimLocatorPunctuation(url + ")".repeat(200_000)), url);
});

test("citation URL punctuation trigger: 50000 exclamations plus sentinel finish under 50 ms", t => {
  const description = `Fixes ${url}${"!".repeat(50_000)}x`;
  matchImportedIssue([{ id: "warmup", description: `Fixes ${url}` }], issue);
  let elapsed = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    const start = performance.now();
    const result = matchImportedIssue([{ id: "owner", description }], issue);
    elapsed = Math.min(elapsed, performance.now() - start);
    assert.equal(result.item, undefined);
  }
  t.diagnostic(`citation URL 50000 exclamations plus sentinel (best of 3): ${elapsed.toFixed(3)} ms`);
  assert.ok(elapsed < 50, `citation URL took ${elapsed.toFixed(3)} ms; limit 50 ms`);
});

test("privacy phone whitespace parity and 20000-space trigger", t => {
  const old = /\b(?:phone|telephone|tel|mobile)\b["']?\s*[:=]\s*["']?\s*\+?\d[\d \t().-]{5,}\d/gi;
  for (const name of ["phone", "telephone", "tel", "mobile"]) {
    for (const before of ["", " ", "\t"]) for (const quote of ["", "'", '"']) for (const after of ["", "  ", "\t"]) {
      const line = `${name}: ${before}${quote}${after}1234567`;
      const expected = [...line.matchAll(old)].map(match => ({ matched: match[0], index: match.index }));
      const actual = scanLineForRuleHits(line).filter(hit => hit.rule === "phone-number")
        .map(hit => ({ matched: hit.matched, index: hit.index }));
      assert.deepEqual(actual, expected, line);
    }
  }
  const line = "phone:" + " ".repeat(20_000) + "x";
  scanLineForRuleHits("phone: x");
  // Keep scheduler pauses out of this supplemental guard, as for the key-marker guard.
  let elapsed = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    const start = performance.now();
    const result = scanLineForRuleHits(line);
    elapsed = Math.min(elapsed, performance.now() - start);
    assert.deepEqual(result, []);
  }
  t.diagnostic(`privacy 20000 spaces (best of 3): ${elapsed.toFixed(3)} ms`);
  assert.ok(elapsed < 50, `privacy took ${elapsed.toFixed(3)} ms; limit 50 ms`);
});

test("API-base slash trim parity and 20000-slash trigger", async t => {
  for (const suffix of ["", "/", "///", "/a///", "/a///x"]) {
    const base = "https://api.example.test" + suffix;
    await withEnv({ PM_GITHUB_API_BASE: base }, async () => assert.equal(githubApiBase(), base.replace(/\/+$/, "")));
  }
  const base = "https://api.example.test/" + "/".repeat(20_000) + "x";
  await withEnv({ PM_GITHUB_API_BASE: base }, async () => {
    let elapsed = Infinity;
    for (let trial = 0; trial < 3; trial++) {
      const start = performance.now();
      const result = githubApiBase();
      elapsed = Math.min(elapsed, performance.now() - start);
      assert.equal(result, base);
    }
    t.diagnostic(`API base 20000 slashes plus sentinel (best of 3): ${elapsed.toFixed(3)} ms`);
    assert.ok(elapsed < 50, `API base took ${elapsed.toFixed(3)} ms; limit 50 ms`);
  });
});

test("privacy key marker parity and 3000-prefix trigger", t => {
  const old = /sk-[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/g;
  const rows = ["sk-", "sk-" + "A".repeat(80), "sk-".repeat(20)];
  for (const left of [0, 19, 20, 21, 40]) for (const right of [0, 19, 20, 21, 40]) {
    rows.push(`sk-${"A".repeat(left)}T3BlbkFJ${"Z".repeat(right)}`);
    rows.push(`sk-sk-${"A".repeat(left)}T3BlbkFJ${"Z".repeat(right)}`);
  }
  const valid = `sk-${"A".repeat(20)}T3BlbkFJ${"Z".repeat(20)}`;
  rows.push(valid + " " + valid, "sk-" + "A".repeat(60) + " " + valid,
    "sk-" + "A".repeat(20) + "T3BlbkFJ".repeat(5),
    "sk-" + "A".repeat(20) + "T3blbkFJ" + "Z".repeat(20));
  for (const line of rows) {
    const expected = [...line.matchAll(old)].map(match => ({ matched: match[0], index: match.index }));
    const actual = scanLineForRuleHits(line).filter(hit => hit.rule === "openai-api-key")
      .map(hit => ({ matched: hit.matched, index: hit.index }));
    assert.deepEqual(actual, expected);
  }
  const line = "sk-".repeat(3_000);
  // Use three trials to keep an isolated scheduler pause from dominating this extra guard.
  let elapsed = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    const start = performance.now();
    const hits = scanLineForRuleHits(line);
    elapsed = Math.min(elapsed, performance.now() - start);
    assert.deepEqual(hits, []);
  }
  t.diagnostic(`privacy 3000 key prefixes (best of 3): ${elapsed.toFixed(3)} ms`);
  assert.ok(elapsed < 50, `privacy key marker took ${elapsed.toFixed(3)} ms; limit 50 ms`);
});
