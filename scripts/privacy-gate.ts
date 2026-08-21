#!/usr/bin/env node
/**
 * Fail-closed privacy gate for Git identities, secrets, and host paths.
 *
 * This is the forward gate required by pm item pm-github-zqad. It walks the
 * LOCAL object store — reachable and unreachable commits, annotated tags, and
 * blobs alike — and fails closed on:
 *
 * 1. Any commit author, committer, or annotated-tag tagger whose email is not
 *    listed in `.github/approved-git-identities.txt`.
 * 2. Any blob containing a high-confidence credential signature (private key
 *    PEM headers, GitHub / npm / Slack token shapes, AWS access key ids).
 * 3. Any blob containing an absolute personal host path (`/home/<user>/` or
 *    `/Users/<user>/`).
 *
 * Synthetic review fixtures are exempt through a checked-in manifest that maps
 * exact Git blob object ids to a written justification, so a fixture can never
 * silently mask real content: the exemption is content-addressed, not
 * path-addressed, and every exemption is reviewable in the diff that adds it.
 *
 * The gate never prints matched secret or host-path values; findings name only
 * the rule and the object id, so gate logs cannot become the leak they exist
 * to prevent.
 *
 * Coverage note (mirrors tests/identity_audit.rs in pm-rust): CI clones never
 * transfer server-side unreachable objects, so a green CI run is evidence
 * about refs and tags; a green local `release:check` run is evidence about the
 * whole local store including dangling objects.
 *
 * @example
 * ```bash
 * node scripts/privacy-gate.ts
 * ```
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { isMainInvocation } from "./docstring-gate.ts";

/**
 * Outcome of one gate run, held as plain strings so a test can inspect it.
 *
 * Pure by design: {@link runGate} touches neither the process streams nor
 * `process.exit`, while the thin {@link main} entry point writes them and sets
 * the exit code.
 */
export interface PrivacyGateResult {
  /** Process exit code the run would produce (0 on success; 1 on failure). */
  readonly exitCode: number;
  /** Content the run would write to stdout, without a trailing newline. */
  readonly stdout: string;
  /** Content the run would write to stderr, without a trailing newline. */
  readonly stderr: string;
}

/** One fail-closed finding: which rule fired and on which object. */
interface Finding {
  /** Stable rule identifier, safe to print (contains no matched content). */
  readonly rule: string;
  /** Git object id of the offending object. */
  readonly oid: string;
}

/** Shape of one entry in the synthetic-fixture exemption manifest. */
interface FixtureEntry {
  /** Human-readable justification recorded next to the fixture in review. */
  readonly justification: string;
}

/** Path of the identity allowlist, relative to the repository root. */
const ALLOWLIST_PATH = ".github/approved-git-identities.txt";

/** Path of the synthetic-fixture exemption manifest, relative to the root. */
const FIXTURE_MANIFEST_PATH = "test/fixtures/privacy-gate/manifest.json";

/**
 * High-confidence credential signatures. Every pattern is shaped so ordinary
 * prose, identifiers, or version numbers cannot match it; broad low-confidence
 * patterns are deliberately excluded to keep the false-positive rate at zero
 * without weakening the gate.
 */
const SECRET_RULES: readonly (readonly [rule: string, pattern: RegExp])[] = [
  ["private-key-pem", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["github-token-classic", /ghp_[A-Za-z0-9]{36}/],
  ["github-token-fine-grained", /github_pat_[A-Za-z0-9_]{22,}/],
  ["npm-token", /npm_[A-Za-z0-9]{36}/],
  ["slack-token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["aws-access-key-id", /AKIA[0-9A-Z]{16}/],
] as const;

/**
 * Absolute personal host-path shape. Matches `/home/<name>/` and
 * `/Users/<name>/` but not the redacted `$HOME` form the history rewrite
 * standardized on, and not bare `/home` or URI scheme text.
 */
const HOST_PATH_PATTERN = /\/(?:home|Users)\/[A-Za-z0-9][A-Za-z0-9._-]*\//;

/**
 * Parses the approved-git-identities allowlist file.
 *
 * Comment lines (starting with `#`) and blank lines are ignored; every other
 * line is trimmed and collected. A missing file fails closed with an error
 * rather than passing vacuously.
 *
 * @param root - Absolute repository root holding `.github/`.
 * @returns The set of approved email addresses.
 */
function parseAllowlist(root: string): Set<string> {
  const raw = readFileSync(join(root, ALLOWLIST_PATH), "utf8");
  return new Set(
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
}

/**
 * Loads the synthetic-fixture exemption manifest, or an empty map when absent.
 *
 * A missing manifest is not an error: repositories without fixtures need no
 * exemptions, and requiring the file would make the gate unusable before the
 * first fixture exists.
 *
 * @param root - Absolute repository root holding `test/fixtures/`.
 * @returns Map from exact Git blob object id to its recorded justification.
 */
function loadFixtureManifest(root: string): Map<string, string> {
  let raw: string;
  try {
    raw = readFileSync(join(root, FIXTURE_MANIFEST_PATH), "utf8");
  } catch {
    return new Map();
  }
  const parsed: Record<string, FixtureEntry> = JSON.parse(raw) as Record<string, FixtureEntry>;
  return new Map(Object.entries(parsed).map(([oid, entry]) => [oid, entry.justification]));
}

/**
 * Enumerates the blob object ids actually present under the fixture directory
 * in the HEAD tree via `git ls-tree -r HEAD -- <dir>`.
 *
 * An exemption only holds when the exempted content is literally a reviewed
 * fixture file at HEAD; this closes the hole where a manifest key silences an
 * arbitrary leaked blob that lives elsewhere in history.
 *
 * @param root - Absolute repository root.
 * @returns Set of blob object ids under the fixture directory at HEAD.
 * @throws Error when git exits non-zero or cannot be spawned.
 */
function listFixtureTreeBlobs(root: string): Set<string> {
  const dir = dirname(FIXTURE_MANIFEST_PATH);
  const result = spawnSync("git", ["ls-tree", "-r", "HEAD", "--", dir], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ls-tree HEAD -- ${dir} failed: ${result.stderr.trim()}`);
  }
  const oids = new Set<string>();
  for (const line of (result.stdout ?? "").split("\n")) {
    const match = /^\d+ blob ([0-9a-f]{40})\t/.exec(line);
    if (match?.[1] !== undefined) oids.add(match[1]);
  }
  return oids;
}

/**
 * Builds the effective fixture exemption set: manifest keys intersected with
 * the blobs actually present under the fixture directory at HEAD.
 *
 * @param root - Absolute repository root.
 * @returns Map from exemptable Git blob object id to its justification.
 */
function loadFixtureExemptions(root: string): Map<string, string> {
  const manifest = loadFixtureManifest(root);
  const fixtureBlobs = listFixtureTreeBlobs(root);
  return new Map([...manifest].filter(([oid]) => fixtureBlobs.has(oid)));
}

/**
 * Computes the Git blob object id for content, matching `git hash-object`.
 *
 * Git blob ids are SHA-1 over the header `blob <byteLength>\0` followed by the
 * content; computing the id here lets tests predict fixture exemptions without
 * shelling out to git.
 *
 * @param content - Exact bytes stored in the blob.
 * @returns The 40-character hexadecimal Git blob object id.
 */
export function gitBlobOid(content: string): string {
  const body = Buffer.from(content, "utf8");
  const hash = createHash("sha1");
  hash.update(`blob ${body.byteLength}\0`);
  hash.update(body);
  return hash.digest("hex");
}

/**
 * Extracts the email address from a Git `author`, `committer`, or `tagger`
 * header line of the form `role Name <email> timestamp tz`.
 *
 * @param line - The raw header line from a commit or tag object.
 * @returns The address between the first `<` and the last `>`, or undefined
 *          when the line carries no such pair.
 */
export function extractEmail(line: string): string | undefined {
  const start = line.indexOf("<");
  const end = line.lastIndexOf(">");
  if (start === -1 || end <= start) return undefined;
  return line.slice(start + 1, end);
}

/**
 * Reads every object in the repository's local store via
 * `git cat-file --batch-all-objects --batch-check`.
 *
 * Unlike a rev-list walk this includes unreachable (dangling or orphaned)
 * objects, which is the whole point: amended credentials and dropped branches
 * must still fail the gate until the store has actually discarded them.
 *
 * @param root - Absolute repository root (any working tree or bare repo).
 * @returns Array of `[oid, type]` pairs for every object in the store.
 * @throws Error when git is missing, the path is not a repository, or git
 *         exits non-zero.
 */
export function listAllObjects(root: string): [oid: string, type: string][] {
  const result = spawnSync("git", ["cat-file", "--batch-all-objects", "--batch-check"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git cat-file --batch-all-objects failed: ${result.stderr.trim()}`);
  }
  return (result.stdout ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split(" ");
      return [parts[0] ?? "", parts[1] ?? ""] as [string, string];
    });
}

/**
 * Reads one object's full content via `git cat-file <type> <oid>`.
 *
 * @param root - Absolute repository root.
 * @param type - Git object type (`commit`, `tag`, or `blob`).
 * @param oid - Git object id to read.
 * @returns The object's full text content.
 * @throws Error when git exits non-zero or cannot be spawned.
 */
export function readObject(root: string, type: string, oid: string): string {
  const result = spawnSync("git", ["cat-file", type, oid], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git cat-file ${type} ${oid} failed: ${result.stderr.trim()}`);
  }
  return result.stdout ?? "";
}

/**
 * Scans one blob's content against the secret and host-path rules, honouring
 * content-addressed fixture exemptions.
 *
 * @param oid - Git object id of the blob being scanned.
 * @param content - Blob text content.
 * @param exemptions - Content-addressed fixture exemptions loaded once per run
 *                     by {@link runGate} via {@link loadFixtureExemptions}.
 * @returns Findings for every rule that fired, empty when clean or exempt.
 */
export function scanBlob(
  oid: string,
  content: string,
  exemptions: ReadonlyMap<string, string>,
): Finding[] {
  if (exemptions.has(oid)) return [];
  const findings: Finding[] = [];
  for (const [rule, pattern] of SECRET_RULES) {
    if (pattern.test(content)) findings.push({ rule, oid });
  }
  if (HOST_PATH_PATTERN.test(content)) findings.push({ rule: "host-path", oid });
  return findings;
}

/**
 * Runs the full privacy audit against a repository root and returns what it
 * would report.
 *
 * The audit enumerates every object in the local store, checks commit author
 * and committer emails plus annotated-tag tagger emails against the allowlist,
 * and scans every blob against the secret and host-path rules. Any allowlist,
 * git, or parse failure fails closed with exit code 1.
 *
 * @param root - Absolute repository root to audit.
 * @returns The exit code and the newline-free stdout/stderr content.
 */
export function runGate(root: string): PrivacyGateResult {
  let allowlist: Set<string>;
  try {
    allowlist = parseAllowlist(root);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `privacy-gate: cannot read ${ALLOWLIST_PATH}: ${(error as Error).message}`,
    };
  }

  let objects: [string, string][];
  try {
    objects = listAllObjects(root);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `privacy-gate: object enumeration failed: ${(error as Error).message}`,
    };
  }

  const findings: Finding[] = [];
  let exemptions: Map<string, string>;
  try {
    exemptions = loadFixtureExemptions(root);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `privacy-gate: fixture exemption resolution failed: ${(error as Error).message}`,
    };
  }
  try {
    for (const [oid, type] of objects) {
      if (type === "commit" || type === "tag") {
        const content = readObject(root, type, oid);
        // Only the header section (everything before the first blank line) can
        // carry identity headers; message or tag-message lines that merely
        // begin with an identity keyword must not enter this check.
        const headerSection = content.split("\n\n")[0] ?? "";
        for (const line of headerSection.split("\n")) {
          // Match the role keyword without requiring a following space: a
          // crafted object with `author<email>` or a tab separator must still
          // be verified, never skipped.
          if (!/^(author|committer|tagger)/.test(line)) continue;
          // An identity header that carries no parseable address is itself a
          // violation: the gate must never pass an identity it could not
          // verify, so a malformed header fails closed like an unapproved one.
          const email = extractEmail(line);
          if (email === undefined || !allowlist.has(email)) {
            findings.push({ rule: `identity:${type}`, oid });
          }
        }
      } else if (type === "blob") {
        findings.push(...scanBlob(oid, readObject(root, "blob", oid), exemptions));
      }
    }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `privacy-gate: object scan failed: ${(error as Error).message}`,
    };
  }

  if (findings.length > 0) {
    let message = `privacy-gate: ${findings.length} violation(s); values are never printed:\n`;
    for (const finding of findings) {
      message += `${finding.oid} ${finding.rule}\n`;
    }
    message += `Approve the identity in ${ALLOWLIST_PATH} with justification, remove the content, or record a content-addressed fixture exemption.`;
    return { exitCode: 1, stdout: "", stderr: message.replace(/\n$/, "") };
  }

  return {
    exitCode: 0,
    stdout: `privacy-gate: ${objects.length} object(s) audited, all identities approved, no secret or host-path matches`,
    stderr: "",
  };
}

/**
 * CLI entry point: runs the gate against `root` and writes the streams.
 *
 * @param root - Absolute repository root to audit.
 */
export function main(root: string): void {
  const result = runGate(root);
  if (result.stdout.length > 0) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

const repoRoot = join(import.meta.dirname, "..");

if (isMainInvocation(process.argv, import.meta.url)) {
  main(repoRoot);
}
