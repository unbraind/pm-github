import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  completePmListArgs,
  decodeCompletePmItems,
  readPmItems,
} from "../index.ts";

/** Current complete `pm list-all --json` envelope, with caller overrides. */
function completeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [
      {
        id: "fixture-1",
        title: "Fixture",
        status: "open",
        body: "Body",
        description: "Description",
        tags: ["gh:acme/widgets#1", "bug"],
      },
    ],
    count: 1,
    total: 1,
    has_more: false,
    truncated: false,
    next_cursor: null,
    completeness: {
      status: "complete",
      unreadable_item_count: 0,
      unreadable_directory_count: 0,
    },
    projection: { mode: "full", fields: null },
    omission_receipt: {
      has_omissions: false,
      omitted_field_group_count: 0,
      omitted_field_groups: [],
    },
    read_output: {
      contract_version: 1,
      command: "list",
      requested_dimensions: ["include", "amount", "cost"],
      within_budget: true,
      strings_compacted: false,
      rows_compacted: false,
      result_omitted: false,
    },
    ...overrides,
  };
}

/** Clone an envelope and remove one top-level truthfulness field. */
function withoutField(field: string): Record<string, unknown> {
  const envelope = completeEnvelope();
  delete envelope[field];
  return envelope;
}

/** Execute the installed pm CLI or fail with its captured diagnostic. */
function runPm(args: string[], cwd?: string): string {
  return execFileSync("pm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PM_AUTHOR: "pm-github-acceptance" },
    shell: process.platform === "win32",
  });
}

test("whole-corpus argv requests strict full unbounded output without an arbitrary row ceiling", () => {
  const args = completePmListArgs("/workspace/.agents/pm");
  assert.deepEqual(args, [
    "--path",
    "/workspace/.agents/pm",
    "list-all",
    "--json",
    "--include-body",
    "--output-include",
    "full",
    "--strict-read",
    "--output-limit",
    "unbounded",
    "--output-budget",
    "unbounded",
  ]);
  assert.ok(!args.includes("--limit"), "a list-all row ceiling makes the corpus incomplete by construction");
});

test("Windows strategy keeps shell metacharacters inside the pm workspace argument", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pm-github-&()-"));
  try {
    runPm(["init", "-y", "--force", "--workspace", workspace]);
    runPm([
      "--path",
      workspace,
      "create",
      "Task",
      "Metacharacter path",
      "--description",
      "Argument-vector acceptance",
    ]);

    assert.deepEqual(
      readPmItems(
        workspace,
        "win32",
        dirname(createRequire(import.meta.url).resolve("@unbrained/pm-cli/package.json")),
      ).map((item) => item.title),
      ["Metacharacter path"],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("decoder preserves every pm field consumed by GitHub import, export, sync, project, and search paths", () => {
  assert.deepEqual(decodeCompletePmItems(completeEnvelope()), [
    {
      id: "fixture-1",
      title: "Fixture",
      status: "open",
      body: "Body",
      description: "Description",
      tags: ["gh:acme/widgets#1", "bug"],
    },
  ]);
  assert.deepEqual(
    decodeCompletePmItems(completeEnvelope({ items: [], count: 0, total: 0 })),
    [],
  );
});

test("decoder refuses every independent incomplete, omitted, paginated, compacted, or contradictory receipt", () => {
  const completeReadOutput = completeEnvelope().read_output as Record<string, unknown>;
  const cases: Array<[string, unknown, RegExp]> = [
    ["bare array", [], /top-level object/],
    ["missing items", withoutField("items"), /items must be an array/],
    ["truncated", completeEnvelope({ truncated: true }), /truncated must be false/],
    ["has more", completeEnvelope({ has_more: true }), /has_more must be false/],
    ["cursor", completeEnvelope({ next_cursor: "next" }), /next_cursor must be null/],
    ["missing completeness", withoutField("completeness"), /completeness.status must be "complete"/],
    ["null completeness", completeEnvelope({ completeness: null }), /completeness.status must be "complete"/],
    ["partial completeness", completeEnvelope({ completeness: { status: "partial", unreadable_item_count: 1, unreadable_directory_count: 0 } }), /completeness.status must be "complete"/],
    ["unreadable item", completeEnvelope({ completeness: { status: "complete", unreadable_item_count: 1, unreadable_directory_count: 0 } }), /unreadable_item_count must be 0/],
    ["unreadable directory", completeEnvelope({ completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 1 } }), /unreadable_directory_count must be 0/],
    ["missing omission receipt", withoutField("omission_receipt"), /omission_receipt.has_omissions must be false/],
    ["array omission receipt", completeEnvelope({ omission_receipt: [] }), /omission_receipt.has_omissions must be false/],
    ["omitted fields", completeEnvelope({ omission_receipt: { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: ["body"] } }), /has_omissions must be false/],
    ["contradictory omission count", completeEnvelope({ omission_receipt: { has_omissions: false, omitted_field_group_count: 1, omitted_field_groups: [] } }), /omitted_field_group_count must be 0/],
    ["contradictory omission groups", completeEnvelope({ omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: ["body"] } }), /omitted_field_groups must be empty/],
    ["non-array omission groups", completeEnvelope({ omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: "body" } }), /omitted_field_groups must be empty/],
    ["missing projection", withoutField("projection"), /projection.mode must be "full"/],
    ["brief projection", completeEnvelope({ projection: { mode: "brief" } }), /projection.mode must be "full"/],
    ["missing read receipt", withoutField("read_output"), /read_output.contract_version must be 1/],
    ["future contract version", completeEnvelope({ read_output: { ...completeReadOutput, contract_version: 2 } }), /read_output.contract_version must be 1/],
    ["wrong command", completeEnvelope({ read_output: { ...completeReadOutput, command: "context" } }), /read_output.command must be "list"/],
    ["over budget", completeEnvelope({ read_output: { ...completeReadOutput, within_budget: false } }), /within_budget must be true/],
    ["strings compacted", completeEnvelope({ read_output: { ...completeReadOutput, strings_compacted: true } }), /strings_compacted must be false/],
    ["rows compacted", completeEnvelope({ read_output: { ...completeReadOutput, rows_compacted: true } }), /rows_compacted must be false/],
    ["result omitted", completeEnvelope({ read_output: { ...completeReadOutput, result_omitted: true } }), /result_omitted must be false/],
    ["missing include proof", completeEnvelope({ read_output: { ...completeReadOutput, requested_dimensions: ["amount", "cost"] } }), /requested_dimensions must include include, amount, and cost/],
    ["missing amount proof", completeEnvelope({ read_output: { ...completeReadOutput, requested_dimensions: ["include", "cost"] } }), /requested_dimensions must include include, amount, and cost/],
    ["missing cost proof", completeEnvelope({ read_output: { ...completeReadOutput, requested_dimensions: ["include", "amount"] } }), /requested_dimensions must include include, amount, and cost/],
    ["budget truncation disclosure", completeEnvelope({ output_budget_truncation: { reason: "output_budget_reached" } }), /budget truncation or omission disclosure/],
    ["budget omission disclosure", completeEnvelope({ output_budget_exceeded: { omitted_result: true } }), /budget truncation or omission disclosure/],
    ["non-integer count", completeEnvelope({ count: "1" }), /count must be a non-negative safe integer/],
    ["negative total", completeEnvelope({ total: -1 }), /total must be a non-negative safe integer/],
    ["row count mismatch", completeEnvelope({ count: 2, total: 2 }), /items.length 1 must equal count 2/],
    ["total mismatch", completeEnvelope({ total: 2 }), /count 1 must equal total 2/],
  ];

  for (const [name, envelope, expected] of cases) {
    assert.throws(() => decodeCompletePmItems(envelope), expected, name);
  }
});

test("decoder refuses malformed and duplicate rows instead of trusting a TypeScript cast", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["non-object", null, /item 0 must be an object/],
    ["missing id", { title: "Fixture", status: "open", body: "", description: "", tags: [] }, /non-empty id/],
    ["empty id", { id: " ", title: "Fixture", status: "open", body: "", description: "", tags: [] }, /non-empty id/],
    ["non-string title", { id: "fixture-1", title: 1, status: "open", body: "", description: "", tags: [] }, /title must be a string/],
    ["non-string status", { id: "fixture-1", title: "Fixture", status: 1, body: "", description: "", tags: [] }, /status must be a string/],
    ["non-string body", { id: "fixture-1", title: "Fixture", status: "open", body: null, description: "", tags: [] }, /body must be a string/],
    ["non-string description", { id: "fixture-1", title: "Fixture", status: "open", body: "", description: null, tags: [] }, /description must be a string/],
    ["tags not an array", { id: "fixture-1", title: "Fixture", status: "open", body: "", description: "", tags: "bug" }, /tags must be an array of strings/],
    ["non-string tag", { id: "fixture-1", title: "Fixture", status: "open", body: "", description: "", tags: [1] }, /tags must be an array of strings/],
  ];

  for (const [name, row, expected] of cases) {
    assert.throws(() => decodeCompletePmItems(completeEnvelope({ items: [row] })), expected, name);
  }

  assert.throws(
    () => decodeCompletePmItems(completeEnvelope({
      items: [
        { id: "same", title: "First", status: "open", body: "", description: "", tags: [] },
        { id: "same", title: "Second", status: "closed", body: "", description: "", tags: [] },
      ],
      count: 2,
      total: 2,
    })),
    /duplicate item id same/,
  );
});

test("real installed CLI returns a complete open-and-closed corpus from a fresh tracker", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pm-github-complete-corpus-"));
  try {
    runPm(["init", "-y", "--force", "--workspace", workspace]);
    const created = JSON.parse(runPm([
      "--path",
      workspace,
      "--json",
      "create",
      "Issue",
      "Imported issue",
      "--description",
      "Real imported issue",
      "--body",
      "Acceptance body",
      "--tags",
      "gh:acme/widgets#7,bug",
    ])) as { id: string };
    runPm(["--path", workspace, "close", created.id, "--reason", "acceptance complete"]);
    runPm([
      "--path",
      workspace,
      "create",
      "Task",
      "Still open",
      "--description",
      "Open acceptance task",
    ]);

    const items = readPmItems(workspace);
    assert.equal(items.length, 2);
    assert.deepEqual(
      items
        .map((item) => ({ title: item.title, status: item.status }))
        .sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "")),
      [
        { title: "Imported issue", status: "closed" },
        { title: "Still open", status: "open" },
      ],
    );
    const imported = items.find((item) => item.id === created.id);
    assert.ok(imported);
    assert.equal(imported.body, "Acceptance body");
    assert.deepEqual(imported.tags, ["bug", "gh:acme/widgets#7"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
