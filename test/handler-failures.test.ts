// Handler-level failure-surface tests for the github commands.
//
// Where `http-boundary.test.ts` exercises the raw HTTP stack, this file drives
// the REGISTERED command handlers (`github validate`, `github sync`,
// `github export`, the search provider, the Projects v2 commands) through the
// SDK test harness against the same local mock server. That runs the real
// request-building AND the real handler logic (error → exit-code mapping,
// per-item batch isolation, dry-run vs apply divergence, GraphQL parsing) —
// nothing mocked at the unit level. GitHub is stubbed only at the HTTP
// boundary via `PM_GITHUB_API_BASE`.
//
// Coverage targets (previously-uncovered index.ts):
//   - runValidate: token-source detection, repo accessible/inaccessible, the
//     low-rate-limit warning, and the no-repo skip.
//   - runSync: upstream-state fetch, divergence PATCH, already-in-sync skip,
//     the 404-on-read skip, dry-run preview vs apply.
//   - runExport --apply: the real applyExportPlan POST/PATCH path, mid-batch
//     per-item isolation (one create succeeds while another 422s), and the
//     all-fail → exit-1 batch outcome.
//   - search provider query: remote hit → local item mapping, unmatched drops,
//     network-failure degrades to no hits, and the no-repo short-circuit.
//   - Projects v2 (GraphQL): list, fields (resolveProject + status field),
//     import dry-run (fetchProjectItems) — the GraphQL HTTP path end to end.

import assert from "node:assert/strict";
import test from "node:test";
import type { ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { SearchProviderQueryContext } from "@unbrained/pm-cli/sdk/authoring";

import extension, { parseImportOptions, runImport, type GhIssue } from "../index.ts";
import {
  captureStderr,
  jsonResponse,
  withMockGithub,
} from "./helpers/mock-github-server.ts";

const MANIFEST_CAPABILITIES = ["commands", "importers", "schema", "hooks", "preflight", "search"] as const;
const harnessPromise: Promise<ExtensionTestHarness> =
  createExtensionTestHarness(extension, { capabilities: [...MANIFEST_CAPABILITIES] });

const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = { encoding: "utf-8" as const, shell: process.platform === "win32" };

// A PATH that finds the local `pm` shim + `node` but NOT `gh`, so the
// token-resolution fallback (`gh auth token`) deterministically fails while
// `pm list-all` still works. Used for the no-token guards whose handlers read
// the tracker before checking the token.
const PM_BIN_DIR = fileURLToPath(new URL("../node_modules/.bin", import.meta.url));
const GH_FREE_PATH = `${PM_BIN_DIR}${path.delimiter}${path.dirname(process.execPath)}`;

/** Set env vars for `fn`, restoring the prior values (or deleting them) after. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Create a throwaway pm workspace (`pm init test`) and return its root. */
function freshTracker(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-handler-"));
  const init = spawnSync(PM_BIN, ["--path", root, "init", "test"], PM_SPAWN_OPTS);
  assert.strictEqual(init.status, 0, `pm init failed: ${init.error?.message ?? init.stderr}`);
  return root;
}

/** Create a pm item carrying a GitHub provenance tag and the given status. */
function createLinkedItem(root: string, title: string, tag: string, status: string): string {
  const r = spawnSync(
    PM_BIN,
    ["--path", root, "create", "task", title, "--status", status, "--tags", tag],
    PM_SPAWN_OPTS,
  );
  assert.strictEqual(r.status, 0, `pm create failed: ${r.error?.message ?? r.stderr}`);
  // Re-read to get the assigned id.
  const list = spawnSync(PM_BIN, ["--path", root, "--json", "list-all", "--full"], { encoding: "utf-8" });
  const parsed = JSON.parse(list.stdout) as { items?: Array<{ id: string; tags?: string[] }> };
  const item = (parsed.items ?? []).find((i) => (i.tags ?? []).includes(tag));
  assert.ok(item, `created item carrying ${tag} should be listable`);
  return item!.id;
}

/**
 * Build a search-provider query context. The provider reads only `query`,
 * `options`, and `documents`; the SDK types `settings` as a fully-required
 * `PmSettings` the provider never inspects, so a single `unknown` bridge (no
 * `any`) satisfies the contract without fabricating 20+ unused fields.
 */
function searchContext(overrides: {
  query?: string;
  repo?: string;
  documents?: unknown[];
} = {}): SearchProviderQueryContext {
  return {
    query: overrides.query ?? "x",
    mode: "semantic",
    tokens: [],
    options: overrides.repo === undefined ? {} : { repo: overrides.repo },
    settings: {},
    documents: overrides.documents ?? [],
  } as unknown as SearchProviderQueryContext;
}

// ===========================================================================
// runValidate — token source, repo accessibility, rate-limit reporting.
// ===========================================================================

test("runValidate reports an accessible repo and the resolved rate limit", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await withMockGithub((_req, res) => {
      jsonResponse(res, 200, { id: 1, name: "widgets", full_name: "a/b" }, {
        "x-ratelimit-remaining": "4998",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": "1780000000",
      });
    }, async () => {
      const result = await ext.runCommand({ command: "github validate", args: ["a/b"], global: { json: true } });
      assert.strictEqual(result.handled, true);
      const report = result.result as Record<string, unknown>;
      assert.strictEqual(report.ok, true);
      assert.strictEqual(report.token, true);
      assert.strictEqual(report.token_source, "env");
      assert.strictEqual(report.repo, "a/b");
      assert.strictEqual(report.repo_accessible, true);
      assert.strictEqual(report.repo_status, 200);
      assert.strictEqual(report.rate_limit_remaining, 4998);
    });
  });
});

test("runValidate flags an inaccessible repo and exits non-zero (NOT_FOUND)", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await withMockGithub((_req, res) => {
      jsonResponse(res, 404, { message: "Not Found" });
    }, async () => {
      // The command handler throws a CommandError (carrying exitCode) when the
      // report is not ok — matching runtime semantics, the harness propagates it.
      await assert.rejects(
        ext.runCommand({ command: "github validate", args: ["a/b"], global: { json: true } }),
        (err: unknown) => err instanceof Error && /returned HTTP 404/.test(err.message),
      );
    });
  });
});

test("runValidate warns when the rate-limit budget is low", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await withMockGithub((_req, res) => {
      jsonResponse(res, 200, { full_name: "a/b" }, { "x-ratelimit-remaining": "3", "x-ratelimit-limit": "5000" });
    }, async () => {
      const { result } = await ext.runCommand({ command: "github validate", args: ["a/b"], global: { json: true } });
      const report = result as Record<string, unknown>;
      assert.strictEqual(report.rate_limit_low, true);
      assert.ok(
        (report.messages as string[]).some((m) => /WARNING.*quota is low.*3 left/.test(m)),
        "a low-quota warning must be emitted",
      );
    });
  });
});

test("runValidate with no --repo skips the accessibility check (ok)", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
    const { result } = await ext.runCommand({ command: "github validate", global: { json: true } });
    const report = result as Record<string, unknown>;
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.repo, undefined);
    assert.ok((report.messages as string[]).some((m) => /No --repo given/.test(m)));
  });
});

// ===========================================================================
// runSync — pm status → GitHub issue close/reopen, against a mock GitHub.
// ===========================================================================

test("runSync --dry-run previews a divergence (pm open, GitHub closed → would reopen)", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    createLinkedItem(root, "Linked", "gh:a/b#5", "open");
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      await withMockGithub((_req, res) => {
        // Upstream issue is closed; pm item is open → desired "open" diverges.
        jsonResponse(res, 200, { number: 5, state: "closed" });
      }, async () => {
        const { result } = await ext.runCommand({
          command: "github sync",
          options: { repo: "a/b", "dry-run": true },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as Record<string, unknown>;
        assert.strictEqual(r.dryRun, true);
        assert.strictEqual(r.wouldSync, 1, "the divergent issue is counted as a would-sync");
        assert.strictEqual(r.planned, 1);
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runSync --apply PATCHes GitHub to match pm status", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    createLinkedItem(root, "Linked", "gh:a/b#6", "closed");
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      await withMockGithub((req, res) => {
        if (req.method === "GET") {
          jsonResponse(res, 200, { number: 6, state: "open" });
        } else {
          jsonResponse(res, 200, { state: "closed" });
        }
      }, async (server) => {
        const { result } = await ext.runCommand({
          command: "github sync",
          options: { repo: "a/b" },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as Record<string, unknown>;
        assert.strictEqual(r.synced, 1, "the issue was PATCHed to closed");
        const patch = server.requests.find((q) => q.method === "PATCH");
        assert.ok(patch, "a PATCH request was made");
        assert.match(patch!.body, /"state":"closed"/, "the PATCH carries the desired state");
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runSync skips an issue already in the desired state", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    createLinkedItem(root, "Linked", "gh:a/b#7", "open");
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      await withMockGithub((_req, res) => {
        jsonResponse(res, 200, { number: 7, state: "open" }); // already matches
      }, async (server) => {
        const { result } = await ext.runCommand({
          command: "github sync",
          options: { repo: "a/b" },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as Record<string, unknown>;
        assert.strictEqual(r.synced, 0);
        assert.strictEqual(r.skipped, 1, "an in-sync issue is skipped, not PATCHed");
        assert.equal(server.requests.every((q) => q.method !== "PATCH"), true, "no PATCH issued");
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runSync tolerates a 404 reading upstream state (skipped, not aborted)", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    createLinkedItem(root, "Linked", "gh:a/b#8", "open");
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      await withMockGithub((_req, res) => {
        // The linked issue was deleted upstream.
        jsonResponse(res, 404, { message: "Not Found" });
      }, async (server) => {
        const { result } = await ext.runCommand({
          command: "github sync",
          options: { repo: "a/b" },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as Record<string, unknown>;
        assert.strictEqual(r.synced, 0);
        assert.strictEqual(r.skipped, 1, "a deleted upstream issue is skipped, not a crash");
        assert.equal(server.requests.every((q) => q.method !== "PATCH"), true);
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runSync requires a GitHub token to apply (dry-run is allowed without one)", async () => {
  const ext = await harnessPromise;
  // Hide `gh` AND any env token so resolveGitHubToken() resolves to nothing.
  // Otherwise a locally-authed `gh` would supply a real token and the branch
  // under test would be unreachable. PATH is scoped to a gh-free directory for
  // this test only and restored afterwards.
  await withEnv(
    { GITHUB_TOKEN: undefined, GH_TOKEN: undefined, PATH: "/tmp" },
    async () => {
      await assert.rejects(
        ext.runCommand({
          command: "github sync",
          options: { repo: "a/b" },
          pmRoot: "/unused",
          global: { json: true },
        }),
        (err: unknown) => err instanceof Error && /GitHub token/.test(err.message),
      );
    },
  );
});

// ===========================================================================
// runExport --apply — real applyExportPlan POST path + per-item isolation.
// ===========================================================================

test("runExport --apply continues past a mid-batch 422 (partial success, exit 0)", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    spawnSync(PM_BIN, ["--path", root, "create", "task", "First"], PM_SPAWN_OPTS);
    spawnSync(PM_BIN, ["--path", root, "create", "task", "Second"], PM_SPAWN_OPTS);
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      let posts = 0;
      await withMockGithub((req, res) => {
        if (req.method === "POST") {
          posts++;
          // First create succeeds; the second 422s (e.g. a bad label). The
          // batch must record the failure and CONTINUE — never abort.
          if (posts === 2) jsonResponse(res, 422, { message: "Validation Failed" });
          else jsonResponse(res, 200, { number: posts, state: "open" });
        } else {
          jsonResponse(res, 200, {});
        }
      }, async () => {
        const { result } = await ext.runCommand({
          command: "github export",
          options: { repo: "a/b", apply: true },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as Record<string, unknown>;
        assert.strictEqual(r.applied, true);
        assert.strictEqual(r.created, 1, "one create landed");
        assert.strictEqual(r.failed, 1, "the 422 was counted, not thrown");
        assert.strictEqual(posts, 2, "every item was attempted");
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runExport --apply exits non-zero when a non-empty batch writes nothing", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    spawnSync(PM_BIN, ["--path", root, "create", "task", "A"], PM_SPAWN_OPTS);
    spawnSync(PM_BIN, ["--path", root, "create", "task", "B"], PM_SPAWN_OPTS);
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      await withMockGithub((_req, res) => {
        // Every create fails — the batch as a whole must report failure.
        jsonResponse(res, 422, { message: "Validation Failed" });
      }, async () => {
        await assert.rejects(
          ext.runCommand({
            command: "github export",
            options: { repo: "a/b", apply: true },
            pmRoot: root,
            global: { json: true },
          }),
          (err: unknown) => err instanceof Error && /All 2 item\(s\) failed/.test(err.message),
        );
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runExport --apply requires --repo <owner/repo>", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    spawnSync(PM_BIN, ["--path", root, "create", "task", "X"], PM_SPAWN_OPTS);
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      await assert.rejects(
        ext.runCommand({
          command: "github export",
          options: { apply: true },
          pmRoot: root,
          global: { json: true },
        }),
        (err: unknown) => err instanceof Error && /--repo <owner\/repo>/.test(err.message),
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// search provider — remote hits mapped back to local imported items.
// ===========================================================================

test("search provider maps remote matches to local imported items and drops the rest", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined, PM_GITHUB_REPO: undefined }, async () => {
    await withMockGithub((_req, res) => {
      // #5 is imported locally; #99 is not. The runtime would drop #99 anyway,
      // but the provider must not emit a hit for an absent local item.
      jsonResponse(res, 200, { items: [{ number: 5 }, { number: 99 }] });
    }, async () => {
      const hits = await ext.runSearchProvider({
        provider: "github",
        operation: "query",
        context: searchContext({
          query: "memory leak",
          repo: "a/b",
          documents: [{ metadata: { id: "pm-1", title: "Linked", tags: ["gh:a/b#5"] }, body: "" }],
        }),
      });
      const list = Array.isArray(hits) ? hits : (hits as { hits?: unknown[] }).hits;
      assert.strictEqual(list!.length, 1, "only the locally-imported match becomes a hit");
      assert.strictEqual((list![0] as { id: string }).id, "pm-1");
    });
  });
});

test("search provider degrades to no hits when GitHub is unreachable", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined, PM_GITHUB_REPO: undefined }, async () => {
    await withMockGithub((_req, res) => {
      // A persistent 5xx exercises the provider's catch → return [].
      jsonResponse(res, 500, "down", { "retry-after": "0" });
    }, async () => {
      await captureStderr(async () => {
        const hits = await ext.runSearchProvider({
          provider: "github",
          operation: "query",
          context: searchContext({ query: "x", repo: "a/b" }),
        });
        const list = Array.isArray(hits) ? hits : (hits as { hits?: unknown[] }).hits ?? [];
        assert.strictEqual(list.length, 0, "a network failure yields no hits, not a throw");
      });
    });
  });
});

test("search provider is a no-op when no repo is configured", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined, PM_GITHUB_REPO: undefined }, async () => {
    const hits = await ext.runSearchProvider({
      provider: "github",
      operation: "query",
      context: searchContext({ query: "x" }),
    });
    const list = Array.isArray(hits) ? hits : (hits as { hits?: unknown[] }).hits ?? [];
    assert.strictEqual(list.length, 0, "no repo → no remote query at all");
  });
});

// ===========================================================================
// Projects v2 (GraphQL) — list, fields, import dry-run against mock /graphql.
// ===========================================================================

/** Respond to a GraphQL POST with a canned `data` payload. */
function graphqlOk(res: ServerResponse, data: unknown): void {
  jsonResponse(res, 200, { data });
}

test("github project list paginates a user owner over the GraphQL endpoint", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await withMockGithub((_req, res, body) => {
      // The listing query asks both user + organization; answer the user side.
      assert.ok(body.includes("projectsV2"), "should POST a projectsV2 query");
      graphqlOk(res, {
        user: {
          projectsV2: {
            pageInfo: { hasNextPage: false, endCursor: "c1" },
            nodes: [
              { number: 5, title: "P5", url: "https://github.com/users/u/projects/5", closed: false, shortDescription: "d" },
            ],
          },
        },
        organization: null,
      });
    }, async (server) => {
      const { result } = await ext.runCommand({
        command: "github project list",
        args: ["u"],
        global: { json: true },
      });
      const r = result as { owner: string; projects: Array<{ number: number; title: string }> };
      assert.strictEqual(r.owner, "u");
      assert.strictEqual(r.projects.length, 1);
      assert.strictEqual(r.projects[0].number, 5);
      // GraphQL goes to /graphql on the same mock origin.
      assert.ok(server.requests[0]?.url.includes("/graphql"));
      assert.equal(server.requests[0]?.headers.authorization, "Bearer tok");
    });
  });
});

test("github project fields resolves the project + Status single-select field", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    let call = 0;
    await withMockGithub((_req, res) => {
      call++;
      if (call === 1) {
        // resolveProject: user side resolves, org is null.
        graphqlOk(res, {
          user: {
            projectV2: {
              id: "PVT_proj",
              title: "Board",
              url: "https://github.com/users/u/projects/5",
              statusField: { id: "F_STATUS", name: "Status", options: [{ id: "o_todo", name: "Todo" }] },
            },
          },
          organization: null,
        });
      } else {
        // The fields introspection query.
        graphqlOk(res, {
          node: {
            fields: {
              nodes: [
                { __typename: "ProjectV2SingleSelectField", name: "Status", options: [{ name: "Todo" }] },
                { __typename: "ProjectV2FieldCommon", name: "Notes", dataType: "TEXT" },
              ],
            },
          },
        });
      }
    }, async () => {
      const { result } = await ext.runCommand({
        command: "github project fields",
        args: ["u/5"],
        global: { json: true },
      });
      const r = result as {
        project: { title: string; ownerType: string; statusField?: { name: string } };
        fields: Array<{ name: string; type: string }>;
      };
      assert.strictEqual(r.project.title, "Board");
      assert.strictEqual(r.project.ownerType, "user");
      assert.strictEqual(r.project.statusField?.name, "Status");
      assert.ok(r.fields.length >= 2);
    });
  });
});

test("github project import --dry-run previews board items (DraftIssue → create)", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      let call = 0;
      await withMockGithub((_req, res) => {
        call++;
        if (call === 1) {
          graphqlOk(res, {
            user: {
              projectV2: {
                id: "PVT_proj",
                title: "Board",
                url: "u",
                statusField: { id: "F_STATUS", name: "Status", options: [{ id: "o_todo", name: "Todo" }, { id: "o_done", name: "Done" }] },
              },
            },
            organization: null,
          });
        } else {
          // fetchProjectItems: one DraftIssue board item.
          graphqlOk(res, {
            node: {
              items: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    id: "PVTI_1",
                    fieldValueByName: { name: "Todo", optionId: "o_todo" },
                    content: { __typename: "DraftIssue", title: "Draft A", body: "a body" },
                  },
                ],
              },
            },
          });
        }
      }, async () => {
        const { result } = await ext.runCommand({
          command: "github project import",
          args: ["u/5"],
          options: { "dry-run": true },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as { dryRun: boolean; wouldImport: number; wouldUpdate: number; planned: number };
        assert.strictEqual(r.dryRun, true);
        assert.strictEqual(r.wouldImport, 1, "the unlinked DraftIssue previews as a create");
        assert.strictEqual(r.wouldUpdate, 0);
        assert.strictEqual(r.planned, 1);
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("github project fields reports NOT_FOUND when the project is inaccessible", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await withMockGithub((_req, res) => {
      // Neither user nor org resolves the project.
      graphqlOk(res, { user: { projectV2: null }, organization: { projectV2: null } });
    }, async () => {
      await assert.rejects(
        ext.runCommand({ command: "github project fields", args: ["u/999"], global: { json: true } }),
        (err: unknown) => err instanceof Error && /not found or not accessible/.test(err.message),
      );
    });
  });
});

// ===========================================================================
// Branch arms in the already-exercised handlers — validation throws, the
// non-JSON summary path, GraphQL error shapes, and the no-token guards. Each
// is a genuine reachable failure mode (not a line touched for its own sake).
// ===========================================================================

test("runSync rejects a missing --repo with a usage error", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await assert.rejects(
      ext.runCommand({ command: "github sync", options: {}, global: { json: true } }),
      (err: unknown) => err instanceof Error && /Usage: pm github sync --repo/.test(err.message),
    );
  });
});

test("runSync rejects --ids with no values", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await assert.rejects(
      ext.runCommand({ command: "github sync", options: { repo: "a/b", ids: "" }, global: { json: true } }),
      (err: unknown) => err instanceof Error && /--ids requires/.test(err.message),
    );
  });
});

test("runSync rejects --ids naming an unknown pm item", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    createLinkedItem(root, "Linked", "gh:a/b#5", "open");
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      await assert.rejects(
        ext.runCommand({
          command: "github sync",
          options: { repo: "a/b", ids: "pm-does-not-exist" },
          pmRoot: root,
          global: { json: true },
        }),
        (err: unknown) => err instanceof Error && /unknown pm item id/i.test(err.message),
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runSync reports planned:0 when no pm items link to the repo", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    spawnSync(PM_BIN, ["--path", root, "create", "task", "Unrelated"], PM_SPAWN_OPTS);
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      const { result } = await ext.runCommand({
        command: "github sync",
        options: { repo: "a/b" },
        pmRoot: root,
        global: { json: true },
      });
      const r = result as Record<string, unknown>;
      assert.strictEqual(r.planned, 0);
      assert.strictEqual(r.synced, 0);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runExport --apply emits a human summary to stderr in non-JSON mode", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    spawnSync(PM_BIN, ["--path", root, "create", "task", "Solo"], PM_SPAWN_OPTS);
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      await withMockGithub((_req, res) => {
        jsonResponse(res, 200, { number: 1, state: "open" });
      }, async () => {
        const { stderr } = await captureStderr(async () => {
          await ext.runCommand({
            command: "github export",
            options: { repo: "a/b", apply: true },
            pmRoot: root,
            global: { json: false },
          });
        });
        assert.ok(stderr.some((l) => /Created 1/.test(l)), `human summary on stderr; got: ${stderr.join(" | ")}`);
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runExport --apply requires a resolvable token", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    spawnSync(PM_BIN, ["--path", root, "create", "task", "X"], PM_SPAWN_OPTS);
    // `gh` is hidden (and no env token) so resolveGitHubToken() returns
    // nothing. readPmItems still runs first, so PATH must keep `pm` reachable.
    await withEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: undefined, PATH: GH_FREE_PATH }, async () => {
      await assert.rejects(
        ext.runCommand({
          command: "github export",
          options: { repo: "a/b", apply: true },
          pmRoot: root,
          global: { json: true },
        }),
        (err: unknown) => err instanceof Error && /requires a GitHub token/.test(err.message),
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runValidate reports when no token is resolvable", async () => {
  const ext = await harnessPromise;
  // Hide `gh` and any env token so both the no-token message AND the
  // "`gh` CLI not found" branch fire (validate never touches the tracker).
  await withEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: undefined, PATH: "/tmp" }, async () => {
    const { result } = await ext.runCommand({ command: "github validate", global: { json: true } });
    const report = result as Record<string, unknown>;
    assert.strictEqual(report.token, false);
    assert.strictEqual(report.token_source, "none");
    assert.strictEqual(report.gh_cli, false);
    const messages = report.messages as string[];
    assert.ok(messages.some((m) => /No GitHub token resolvable/.test(m)), "no-token message present");
    assert.ok(messages.some((m) => /gh.*CLI not found/.test(m)), "gh-missing message present");
  });
});

test("runValidate rejects a malformed --repo (no owner/name)", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await assert.rejects(
      ext.runCommand({ command: "github validate", args: ["not-a-repo"], global: { json: true } }),
      (err: unknown) => err instanceof Error && /Invalid --repo/.test(err.message),
    );
  });
});

test("github project list surfaces an unparseable GraphQL response", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await withMockGithub((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("not json");
    }, async () => {
      await assert.rejects(
        ext.runCommand({ command: "github project list", args: ["u"], global: { json: true } }),
        (err: unknown) => err instanceof Error && /unparseable response/.test(err.message),
      );
    });
  });
});

test("github project fields surfaces a GraphQL errors array", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await withMockGithub((_req, res) => {
      jsonResponse(res, 200, { errors: [{ message: "field 'x' not found" }] });
    }, async () => {
      await assert.rejects(
        ext.runCommand({ command: "github project fields", args: ["u/5"], global: { json: true } }),
        (err: unknown) => err instanceof Error && /GraphQL error.*field 'x' not found/.test(err.message),
      );
    });
  });
});

test("github project list requires a token for GraphQL", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: undefined, PATH: "/tmp" }, async () => {
    await assert.rejects(
      ext.runCommand({ command: "github project list", args: ["u"], global: { json: true } }),
      (err: unknown) => err instanceof Error && /requires a token/.test(err.message),
    );
  });
});

test("github project list reports none found for an owner with no projects", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await withMockGithub((_req, res) => {
      graphqlOk(res, { user: { projectsV2: { pageInfo: { hasNextPage: false }, nodes: [] } }, organization: null });
    }, async () => {
      const { stderr } = await captureStderr(async () => {
        await ext.runCommand({ command: "github project list", args: ["u"], global: { json: false } });
      });
      assert.ok(stderr.some((l) => /No Projects v2 found/.test(l)));
    });
  });
});

// ===========================================================================
// Projects v2 APPLY — real pm writes driven through the GraphQL mock.
// Covers runProjectImport create, runProjectSync push (add-draft + set-status +
// the pm tag write), and the gql mutation round-trips.
// ===========================================================================

test("github project import --apply creates pm items for unlinked board items", async () => {
  const ext = await harnessPromise;
  const root = freshTracker();
  try {
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      let call = 0;
      await withMockGithub((_req, res) => {
        call++;
        if (call === 1) {
          graphqlOk(res, {
            user: {
              projectV2: {
                id: "PVT_proj",
                title: "Board",
                url: "u",
                statusField: { id: "F", name: "Status", options: [{ id: "o_todo", name: "Todo" }, { id: "o_done", name: "Done" }] },
              },
            },
            organization: null,
          });
        } else {
          graphqlOk(res, {
            node: {
              items: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  id: "PVTI_1",
                  fieldValueByName: { name: "Todo", optionId: "o_todo" },
                  content: { __typename: "DraftIssue", title: "Draft A", body: "a body" },
                }],
              },
            },
          });
        }
      }, async () => {
        const { result } = await ext.runCommand({
          command: "github project import",
          args: ["u/5"],
          pmRoot: root,
          global: { json: true },
        });
        const r = result as { imported: number; updated: number; skipped: number };
        assert.strictEqual(r.imported, 1, "the unlinked DraftIssue is created as a pm item");
        assert.strictEqual(r.updated, 0);
        // The item really landed in the workspace.
        assert.ok(listTitles(root).includes("Draft A"), "the created item is present in the tracker");
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// `resolveProject` queries BOTH user and organization in one request and keeps
// whichever resolves. An organization-owned project must take the org branch
// (ownerType === "organization") — this is the symmetric counterpart to the
// user-owner tests above and the one path that exercises the org fallback.
test("github project fields resolves an organization-owned project", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
    await withMockGithub((_req, res) => {
      graphqlOk(res, {
        user: null,
        organization: {
          projectV2: {
            id: "PVT_org",
            title: "Org Board",
            url: "u",
            statusField: { id: "F", name: "Status", options: [{ id: "o_todo", name: "Todo" }] },
          },
        },
      });
    }, async () => {
      const { result } = await ext.runCommand({
        command: "github project fields",
        args: ["unbraind/5"],
        global: { json: true },
      });
      const r = result as { project: { ownerType: string; title: string } };
      assert.strictEqual(r.project.ownerType, "organization", "org owner resolves on the org branch");
      assert.strictEqual(r.project.title, "Org Board");
    });
  });
});

/** A minimal upstream GitHub issue for runImport reconciliation fixtures. */
function upstreamIssue(number: number, title: string, state: "open" | "closed"): GhIssue {
  return {
    number,
    title,
    body: "reconciled body",
    state,
    labels: [],
    assignee: null,
    milestone: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    html_url: `https://github.com/a/b/issues/${number}`,
  };
}

/** Read a pm item's status by its provenance tag (for reconciliation asserts). */
function statusForTag(root: string, tag: string): string | undefined {
  const r = spawnSync(PM_BIN, ["--path", root, "--json", "list-all", "--full"], { encoding: "utf-8" });
  const parsed = JSON.parse(r.stdout) as { items?: Array<{ status?: string; tags?: string[] }> };
  return (parsed.items ?? []).find((i) => (i.tags ?? []).includes(tag))?.status;
}

// runImport is the non-atomic idempotent pipeline. These exercise the REAL
// write path (default fetchAllIssues over the mock + real pm mutations): a
// linked item whose upstream state DIVERGED is reconciled — closed upstream →
// pm close; reopened upstream → pm reopen. This is the "conflicting local and
// remote edits" surface, and the close/reopen reconciliation branches were
// previously unexercised (only dry-run + atomic paths were covered).
test("runImport closes a linked item whose upstream issue was closed", async () => {
  const root = freshTracker();
  try {
    createLinkedItem(root, "Linked", "gh:a/b#5", "open");
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      await withMockGithub((_req, res) => {
        jsonResponse(res, 200, [upstreamIssue(5, "Linked", "closed")]);
      }, async () => {
        const result = (await runImport("a/b", root, parseImportOptions({}))) as Record<string, unknown>;
        assert.strictEqual(result.updated, 1);
        assert.strictEqual(statusForTag(root, "gh:a/b#5"), "closed", "pm item closed to match upstream");
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runImport reopens a linked item whose upstream issue was reopened", async () => {
  const root = freshTracker();
  try {
    createLinkedItem(root, "Linked", "gh:a/b#6", "closed");
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      await withMockGithub((_req, res) => {
        jsonResponse(res, 200, [upstreamIssue(6, "Linked", "open")]);
      }, async () => {
        const result = (await runImport("a/b", root, parseImportOptions({}))) as Record<string, unknown>;
        assert.strictEqual(result.updated, 1);
        assert.strictEqual(statusForTag(root, "gh:a/b#6"), "open", "pm item reopened to match upstream");
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** List the titles of every pm item in a workspace (for apply assertions). */
function listTitles(root: string): string[] {
  const r = spawnSync(PM_BIN, ["--path", root, "--json", "list", "--full"], { encoding: "utf-8" });
  const parsed = JSON.parse(r.stdout);
  const arr = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.results ?? []);
  return (arr as Array<{ title?: string }>).map((i) => i.title ?? "");
}

// (The helper's own throw → 500 path is intentionally not asserted here: a
// thrown handler surfaces as HTTP 500, which `request` legitimately retries with
// exponential backoff, making such a test both slow and a test of the retry
// layer rather than the helper. The retry behaviour is covered in
// http-boundary.test.ts.)
