/**
 * Behavioral coverage for the privacy gate script.
 *
 * The gate is a fail-closed release gate, so the tests exercise real git
 * repositories built in temporary directories. Narrow executable wrappers
 * inject unreadable inventory and blob failures while delegating other queries
 * to real Git:
 *
 * - the clean path (this repository's rewritten history passes),
 * - every failure path (unapproved author, committer, tagger; each secret
 *   rule; host paths), each proven by committing the offending content into a
 *   throwaway repository and asserting the gate fails naming the rule,
 * - the fixture exemption path, proven by registering a synthetic blob and
 *   observing the same content fail once the exemption is removed,
 * - fail-closed behavior when the allowlist is missing or git cannot run.
 *
 * Assertions run against {@link runGate}'s returned strings or captured
 * process streams. Findings must never contain matched values: the tests
 * assert the offending content does not appear in the gate output.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

import { fileURLToPath } from "node:url";
import {
  extractEmail,
  gitBlobOid,
  type PrivacyGateResult,
  runGate,
  runPrivacyGateIfMain,
  main,
  scanBlob,
} from "../scripts/privacy-gate.ts";

/** Repository root of pm-github itself (the clean-path subject). */
const repoRoot = resolve(import.meta.dirname, "..");

/**
 * Initializes a throwaway git repository with a deliberately unapproved
 * committer identity so every commit created inside it also exercises the
 * identity rules.
 *
 * @param prefix - Temp-name prefix handed to `mkdtempSync`.
 * @returns Absolute path of the initialized repository.
 */
function initRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `pm-github-privacy-${prefix}-`));
  const run = (args: readonly string[]): void => {
    execFileSync("git", args, { cwd: root });
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", "Privacy Fixture"]);
  // Unapproved on purpose: any commit here must trip the identity gate unless
  // the test also writes an allowlist that approves it.
  run(["config", "user.email", "intruder@localhost"]);
  return root;
}

/**
 * Writes an approving allowlist into a temp repository so identity findings
 * can be isolated from blob findings per test.
 *
 * @param root - Temp repository path.
 * @param emails - Emails to approve, one per line.
 */
function writeAllowlist(root: string, emails: readonly string[]): void {
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(
    join(root, ".github", "approved-git-identities.txt"),
    ["# synthetic allowlist", ...emails].join("\n") + "\n",
  );
}

/**
 * Commits the current worktree state in a temp repository.
 *
 * @param root - Temp repository path.
 * @param message - Commit message to use.
 */
function commitAll(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root });
}

test("privacy gate passes on this repository's clean rewritten history", () => {
  const result = runGate(repoRoot);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /audited/);
  assert.equal(result.stderr, "");
});

test("privacy gate fails closed when the allowlist file is missing", () => {
  const root = initRepo("no-allowlist");
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /cannot read .*approved-git-identities/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy gate fails closed when the path is not a git repository", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-github-privacy-notrepo-"));
  try {
    writeAllowlist(root, ["someone@example.com"]);
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /object enumeration failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy gate reports unapproved commit authors and committers without printing emails", () => {
  const root = initRepo("identity");
  try {
    writeAllowlist(root, ["maintainer@example.com"]);
    writeFileSync(join(root, "clean.txt"), "nothing suspicious\n");
    commitAll(root, "committed by an unapproved identity");
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /identity:commit/);
    assert.ok(!result.stderr.includes("intruder@localhost"), "must not print the email value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy gate accepts identities listed in the allowlist", () => {
  const root = initRepo("approved-identity");
  try {
    writeAllowlist(root, ["intruder@localhost"]);
    writeFileSync(join(root, "clean.txt"), "nothing suspicious\n");
    commitAll(root, "committed by an approved-for-this-test identity");
    const result = runGate(root);
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy gate reports unapproved annotated-tag taggers", () => {
  const root = initRepo("tagger");
  try {
    writeAllowlist(root, ["maintainer@example.com"]);
    writeFileSync(join(root, "clean.txt"), "nothing suspicious\n");
    commitAll(root, "base commit with an identity approved below");
    // Approve the commit identity so the tag finding is isolated.
    writeAllowlist(root, ["intruder@localhost"]);
    // Override just the tagger via env so the tag carries a distinct,
    // unapproved address while the commits stay approved.
    const env = {
      ...process.env,
      GIT_COMMITTER_NAME: "Tagger Fixture",
      GIT_COMMITTER_EMAIL: "tagger-intruder@localhost",
    };
    execFileSync("git", ["tag", "-a", "v9.9.8-fixture", "-m", "fixture tag two"], { cwd: root, env });
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /identity:tag/);
    assert.ok(!result.stderr.includes("tagger-intruder@localhost"), "must not print the email value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [file, rule] of [
  ["synthetic-github-token.txt", "github-token-classic"],
  ["synthetic-fine-grained-token.txt", "github-token-fine-grained"],
  ["synthetic-npm-token.txt", "npm-token"],
  ["synthetic-slack-token.txt", "slack-token"],
  ["synthetic-aws-key.txt", "aws-access-key-id"],
  ["synthetic-private-key.pem", "private-key-pem"],
  ["synthetic-host-path.txt", "host-path"],
] as const) {
  test(`privacy gate flags ${rule} committed into history`, () => {
    const root = initRepo(`rule-${rule}`);
    try {
      // Approve the fixture committer so only the blob rule can fire.
      writeAllowlist(root, ["intruder@localhost"]);
      const content = readFileSync(join(repoRoot, "test", "fixtures", "privacy-gate", file), "utf8");
      writeFileSync(join(root, "leak.txt"), content);
      commitAll(root, `commit carrying a ${rule} fixture`);
      const result = runGate(root);
      assert.equal(result.exitCode, 1, result.stderr);
      assert.match(result.stderr, new RegExp(rule));
      // The matched value must never appear in the report.
      assert.ok(!result.stderr.includes(content.trim()), "must not print matched content");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("privacy gate exempts exactly the manifest-registered fixture blobs", () => {
  const root = initRepo("exemption");
  try {
    writeAllowlist(root, ["intruder@localhost"]);
    const content = readFileSync(
      join(repoRoot, "test", "fixtures", "privacy-gate", "synthetic-host-path.txt"),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "test", "fixtures", "privacy-gate", "manifest.json"), "utf8"),
    ) as Record<string, { justification: string }>;
    const oid = gitBlobOid(content);
    assert.ok(manifest[oid], "fixture must be registered in the checked-in manifest");
    assert.match(manifest[oid]?.justification ?? "", /Synthetic review fixture/);

    // With no exemption map, the content is flagged...
    assert.deepEqual(scanBlob(oid, content, new Map()).map((f) => f.rule), ["host-path"]);
    // ...and with the registered exemption it is silent.
    assert.deepEqual(scanBlob(oid, content, new Map([[oid, "justified"]])), []);
    // A different exemption key must not silence it.
    assert.equal(scanBlob(oid, content, new Map([["deadbeef", "justified"]])).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gitBlobOid agrees with git hash-object for identical bytes", () => {
  const content = "cross-check\nwith unicode: äöü ✓\n";
  const expected = execFileSync(
    "git",
    ["hash-object", "--stdin"],
    { input: content, encoding: "utf8" },
  ).trim();
  assert.equal(gitBlobOid(content), expected);
});

test("extractEmail parses git header shapes and rejects malformed lines", () => {
  assert.equal(extractEmail("author Name <a@example.com> 1700000000 +0100"), "a@example.com");
  assert.equal(extractEmail("committer Bot <bot@example.com> 1700000000 +0000"), "bot@example.com");
  assert.equal(extractEmail("tagger T <t@example.com> 1700000000 +0000"), "t@example.com");
  assert.equal(extractEmail("no angle brackets here"), undefined);
  assert.equal(extractEmail("reversed >brackets< here"), undefined);
});

test("privacy gate CLI entry point writes streams and sets exit code", async () => {
  const cleanRoot = repoRoot;
  let stdout = "";
  let stderr = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exitCode;
  process.stdout.write = (chunk: Uint8Array | string): boolean => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: Uint8Array | string): boolean => {
    stderr += String(chunk);
    return true;
  };
  try {
    main(cleanRoot);
    assert.equal(process.exitCode, 0);
    assert.match(stdout, /audited/);
    assert.equal(stderr, "");

    stdout = "";
    stderr = "";
    const failingRoot = initRepo("cli-fail");
    try {
      main(failingRoot);
      assert.equal(process.exitCode, 1);
      assert.match(stderr, /cannot read/);
    } finally {
      rmSync(failingRoot, { recursive: true, force: true });
    }
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    process.exitCode = originalExit ?? 0;
  }
});

test("privacy gate verifies identity headers with malformed separators", () => {
  const root = initRepo("separator-identity");
  try {
    writeAllowlist(root, ["intruder@localhost"]);
    writeFileSync(join(root, "clean.txt"), "nothing suspicious\n");
    commitAll(root, "base commit with an approved identity");
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root }).toString().trim();
    const parent = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
    // Craft shapes a naive `role <space>` prefix check would skip:
    // no space after the role keyword, and a tab separator.
    for (const [label, authorLine] of [
      ["no-space", "author<unapproved@example.com> 1700000000 +0000"],
      ["tab", "committer\tTab Fixture <tab-unapproved@example.com> 1700000000 +0000"],
    ] as const) {
      const crafted = `tree ${tree}\nparent ${parent}\n${authorLine}\ncommitter X <intruder@localhost> 1700000000 +0000\n\ncrafted ${label} separator\n`;
      const oid = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin", "--literally"], {
        cwd: root,
        input: crafted,
      }).toString().trim();
      execFileSync("git", ["update-ref", `refs/heads/evil-${label}`, oid], { cwd: root });
      const result = runGate(root);
      assert.equal(result.exitCode, 1, `${label} separator must fail the gate`);
      assert.match(result.stderr, /identity:commit/);
      execFileSync("git", ["update-ref", `-d`, `refs/heads/evil-${label}`], { cwd: root });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy gate does not flag message lines that begin with an identity keyword", () => {
  const root = initRepo("message-keyword");
  try {
    writeAllowlist(root, ["intruder@localhost"]);
    writeFileSync(join(root, "clean.txt"), "nothing suspicious\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["commit", "-q", "-m", "author lines in the message body must not be scanned\n\nauthor something@example.com in body"],
      { cwd: root },
    );
    const result = runGate(root);
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy gate fails closed on an unparseable identity header", () => {
  const root = initRepo("malformed-identity");
  try {
    writeAllowlist(root, ["intruder@localhost"]);
    writeFileSync(join(root, "clean.txt"), "nothing suspicious\n");
    commitAll(root, "base commit with an approved identity");
    // Hand-craft a commit whose author header carries no angle-bracketed
    // email, exactly the shape a crafted object would use to dodge parsing.
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root }).toString().trim();
    const parent = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
    const crafted = `tree ${tree}\nparent ${parent}\nauthor malformed-no-email 1700000000 +0000\ncommitter malformed-no-email 1700000000 +0000\n\ncrafted commit with an unverifiable identity\n`;
    const oid = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin", "--literally"], {
      cwd: root,
      input: crafted,
    }).toString().trim();
    execFileSync("git", ["update-ref", "refs/heads/evil", oid], { cwd: root });
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(`${oid} identity:commit`.replace(/([.*+?^${}()|[\]\\])/g, "\\$&")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy gate ignores manifest exemptions for blobs outside the fixture directory", () => {
  const root = initRepo("exemption-abuse");
  try {
    writeAllowlist(root, ["intruder@localhost"]);
    // Commit a leak-shaped blob OUTSIDE the fixture directory...
    const leak = "token=ghp_" + "q".repeat(36) + "\n";
    writeFileSync(join(root, "leak.txt"), leak);
    commitAll(root, "leak committed outside fixtures");
    // ...then try to silence it through a manifest entry alone.
    mkdirSync(join(root, "test", "fixtures", "privacy-gate"), { recursive: true });
    writeFileSync(
      join(root, "test", "fixtures", "privacy-gate", "manifest.json"),
      JSON.stringify({ [gitBlobOid(leak)]: { justification: "abuse attempt" } }) + "\n",
    );
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /github-token-classic/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy gate main entry audits the supplied root", () => {
  const root = initRepo("main-entry");
  const previous = process.exitCode;
  let stderr = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: Uint8Array | string): boolean => {
    stderr += String(chunk);
    return true;
  };
  try {
    const moduleUrl = new URL("../scripts/privacy-gate.ts", import.meta.url).href;
    runPrivacyGateIfMain(["node", fileURLToPath(moduleUrl)], moduleUrl, root);
    assert.equal(process.exitCode, 1);
    assert.match(stderr, /cannot read/);
  } finally {
    process.stderr.write = original;
    process.exitCode = previous ?? 0;
    rmSync(root, { recursive: true, force: true });
  }
});

/** Launch with a startup PATH: Bun retains the original executable lookup path. */
function privacyProcess(code: string, environment: Record<string, string | undefined>): void {
  const env = { ...process.env, ...environment };
  delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { runGate, listAllObjects, readObject } from ${JSON.stringify(new URL("../scripts/privacy-gate.ts", import.meta.url).href)};
    ${code}
  `], { env, encoding: "utf8", timeout: 30_000 });
}

test("privacy gate fails closed when git cannot be spawned", () => {
  const root = initRepo("no-git");
  writeAllowlist(root, ["intruder@localhost"]);
  try {
    privacyProcess(`
      const root = ${JSON.stringify(root)};
      const result = runGate(root);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /object enumeration failed|fixture exemption resolution failed|cannot read/);
      assert.throws(() => listAllObjects(root));
    `, { PATH: root });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("privacy gate fails closed when object inventory or blob reads are unusable", () => {
  const root = initRepo("bad-git");
  const bin = mkdtempSync(join(tmpdir(), "pm-github-privacy-git-"));
  try {
    writeAllowlist(root, ["intruder@localhost"]);
    writeFileSync(join(root, "clean.txt"), "clean\n");
    commitAll(root, "clean");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = "cat-file" ] && [ "$2" = "--batch-all-objects" ]; then
  printf '%s\n' 'not-a-record'
  exit 0
fi
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
    chmodSync(join(bin, "git"), 0o755);
    privacyProcess(`
      const root = ${JSON.stringify(root)};
      const bin = ${JSON.stringify(bin)};
      const realGit = ${JSON.stringify(realGit)};
      assert.throws(() => listAllObjects(root), /unreadable record/);
      const listed = execFileSync(realGit, ['cat-file', '--batch-all-objects', '--batch-check'], { cwd: root, encoding: 'utf8' });
      const blob = listed.split('\\n').find(line => line.includes(' blob '));
      assert.ok(blob, 'fixture commit created a blob');
      const oid = blob.split(' ')[0];
      writeFileSync(join(bin, 'git'), '#!/bin/sh\\nif [ "$1" = "cat-file" ] && [ "$2" = "blob" ]; then\\n  echo forced-read-failure >&2\\n  exit 1\\nfi\\nexec "$REAL_GIT" "$@"\\n', { mode: 0o755 });
      assert.throws(() => readObject(root, 'blob', oid), /forced-read-failure/);
      const scanned = runGate(root);
      assert.equal(scanned.exitCode, 1);
      assert.match(scanned.stderr, /object scan failed/);
    `, { PATH: bin + delimiter + process.env.PATH, REAL_GIT: realGit });
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy gate negative control: a fresh violation introduced after a clean pass fails", () => {
  const root = initRepo("negative-control");
  try {
    writeAllowlist(root, ["intruder@localhost"]);
    writeFileSync(join(root, "ok.txt"), "clean content\n");
    commitAll(root, "clean commit");
    assert.equal(runGate(root).exitCode, 0);

    // Introduce a violation shaped like a real leak after the clean baseline.
    writeFileSync(join(root, "leak.txt"), "token=ghp_" + "z".repeat(36) + "\n");
    commitAll(root, "introduce a leak-shaped secret");
    const after: PrivacyGateResult = runGate(root);
    assert.equal(after.exitCode, 1);
    assert.match(after.stderr, /github-token-classic/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
