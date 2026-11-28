import assert from "node:assert/strict";
import type { HistoryEntry } from "@unbrained/pm-cli/sdk";

/** Require actual history records after the original, byte-identical prefix. */
export function appendedHistory(before: string, after: string): Pick<HistoryEntry, "op" | "patch">[] {
  assert.ok(after.startsWith(before), "existing history must be an unchanged prefix");
  const suffix = after.slice(before.length).trim();
  const lines = suffix === "" ? [] : suffix.split(/\r?\n/);
  assert.ok(lines.length > 0, "expected at least one appended history record");
  return lines.map(line => {
    const record: Pick<HistoryEntry, "op" | "patch"> | null = JSON.parse(line);
    assert.ok(record && typeof record.op === "string" && record.op.length > 0 && Array.isArray(record.patch),
      "expected a history operation and patch");
    return record;
  });
}
