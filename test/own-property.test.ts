/** External names remain data across helpers, options, headers and project mappings. */
import assert from "node:assert/strict";
import test from "node:test";
import { emptyRecord, ownValue, setOwnValue } from "../own-record.ts";
import { optionEnabled, optionString, optionCsv, parseRateLimit, computeBackoffMs } from "../index.ts";
import { resolveOptionForStatus } from "../projects.ts";
import { withEnv } from "./helpers/mock-github-server.ts";

const names = ["title", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "prototype", "café", "東京"];

test("own dictionaries allow every prototype name without reading or changing prototypes", () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  const values = emptyRecord<string>();
  assert.equal(Object.getPrototypeOf(values), null);
  for (const name of names) {
    assert.equal(ownValue({}, name), undefined);
    assert.equal(ownValue(undefined, name), undefined);
    assert.equal(ownValue(null, name), undefined);
    values[name] = name;
    assert.equal(ownValue(values, name), name);
    assert.equal(ownValue(Object.fromEntries([[name, name]]), name), name);
    const plain = {};
    setOwnValue(plain, name, name);
    assert.equal(ownValue(plain, name), name);
    assert.equal(Object.getPrototypeOf(plain), Object.prototype);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
});

test("option names and header normalization ignore inherited entries and allow own collisions", () => {
  const inherited: Record<string, unknown> = Object.create({ flag: true, text: "inherited", csv: "one,two" });
  assert.equal(optionEnabled(inherited, "flag"), false);
  assert.equal(optionString(inherited, "text"), undefined);
  assert.deepEqual(optionCsv(inherited, "csv"), []);
  for (const name of names) {
    const value = Object.fromEntries([[name, "true"]]);
    assert.equal(optionEnabled(value, name), true);
    assert.equal(optionString(value, name), "true");
    assert.deepEqual(optionCsv(value, name), ["true"]);
  }
  const headers: Record<string, string> = Object.create({ "x-ratelimit-remaining": "0", "retry-after": "60" });
  assert.equal(parseRateLimit(headers).remaining, undefined);
  assert.equal(computeBackoffMs(headers, 0), 1000);
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  const ownHeaders = Object.fromEntries(names.map(name => [name, "value"]));
  assert.equal(parseRateLimit(ownHeaders).remaining, undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
});

test("project status and option names use own candidates or explicit Map entries", () => {
  for (const name of names) {
    const options = [{ id: "default", name: "Todo" }, { id: "own", name }];
    assert.equal(resolveOptionForStatus(name, options)?.id, "default");
    assert.equal(resolveOptionForStatus(name, options, new Map([[name.toLowerCase(), name]]))?.id, "own");
  }
});

test("environment snapshots preserve own prototype-name entries and restore absence", async () => {
  const before = new Map(names.map(name => [name, ownValue(process.env, name)]));
  const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
  await withEnv(Object.fromEntries(names.map(name => [name, "own-test-value"])), async () => {
    for (const name of names) assert.equal(ownValue(process.env, name), "own-test-value");
  });
  for (const name of names) assert.equal(ownValue(process.env, name), before.get(name));
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototype);
});
