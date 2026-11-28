import assert from "node:assert/strict";
import test from "node:test";
import { appendedHistory } from "./helpers/history-assertions.ts";

test("mutation evidence requires real JSONL records after unchanged history", () => {
  const original = '{"op":"create","patch":[]}\n';
  const change = { op: "update", patch: [{ op: "replace", path: "/body", value: "Edited body" }] };
  const close = { op: "close", patch: [] };
  const changeLine = JSON.stringify(change) + "\n";
  const closeLine = JSON.stringify(close) + "\n";
  for (const before of ["", original]) {
    for (const whitespace of ["", "\n", "\r\n", " \t\n"]) {
      assert.throws(() => appendedHistory(before, before + whitespace), /at least one appended history record/);
    }
    for (const invalid of ["{\n", "null\n", '{"op":"update"}\n', '{"op":"","patch":[]}\n']) {
      assert.throws(() => appendedHistory(before, before + invalid));
    }
    assert.deepEqual(appendedHistory(before, before + changeLine), [change]);
    assert.deepEqual(appendedHistory(before, before + changeLine + closeLine), [change, close]);
  }
  assert.throws(() => appendedHistory(original, changeLine + closeLine), /unchanged prefix/);
});
