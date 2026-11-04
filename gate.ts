import { ownValue } from "./own-record.ts";
// pm-github — fail-closed privacy gate over a proposed tracker change.
//
// GitHub issue bodies are untrusted text: anyone who can open an issue can put a
// credential, a personal email, or a host path in it, and an automated import
// writes that text straight into the pm tracker. A sync workflow then pushes the
// tracker to a public branch — publishing the leak with it. This module is the
// gate that runs between the write and any push: it scans ONLY the proposed
// change (the added lines and their filenames in the staged/working/untracked diff under the
// resolved pm tracker path, or an explicit unified diff), so pre-existing
// reviewed content is not re-litigated on every run, and it FAILS CLOSED:
//
//   * a credential signature, personal email, phone number, or host path in an
//     added line fails the gate;
//   * an unreadable input, a git failure, a malformed allowlist, or a scanner
//     error fails the gate — a clean verdict can never be the result of the
//     scanner not being able to read what it was asked to read;
//   * findings name the rule, item, field, offset, redacted excerpt and hash —
//     never the full match — so gate logs cannot become the leak they exist
//     to prevent;
//   * reviewed false positives are suppressed through a content-addressed
//     allowlist (sha256 of the matched content), not a pattern, so an entry can
//     never accidentally un-suppress a different, genuinely dangerous value.
//
// The scanner rules deliberately mirror the high-confidence signature set the
// repository's own identity/privacy gate (scripts/privacy-gate.ts) enforces over
// Git objects, extended with the personal-data shapes a public branch push would
// leak from imported issue text.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { resolvePmRoot } from "@unbrained/pm-cli/sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One fail-closed finding produced by the gate.
 *
 * Deliberately carries no matched text: the report is machine-readable and may
 * be echoed into CI logs, so it identifies WHAT fired (rule), WHERE (item id and
 * the item field that would publish it), and the content-addressed allowlist
 * key (hash), offset and a strictly redacted excerpt.
 */
export interface GateFinding {
  /** Stable rule identifier, safe to print (never contains matched content). */
  readonly rule: string;
  /** The pm item whose change carries the finding, or `""` when unattributable. */
  readonly item_id: string;
  /** The item field the offending added line belongs to, or `""` when unknown. */
  readonly field: string;
  /** sha256 hex digest of the matched content — the allowlist key. */
  readonly hash: string;
  /** Character offset in the scanned field value or serialized added line. */
  readonly match_offset: number;
  /** Safe match shape: only a POSIX root initial, or a fixed redaction marker. */
  readonly excerpt: string;
}

/** Verdict of one gate run: `fail` whenever any non-allowlisted finding exists. */
export type GateVerdict = "pass" | "fail";

/** Machine-readable result of one gate run over a proposed tracker change. */
export interface GateReport {
  /** `fail` when any finding survived the allowlist; `pass` otherwise. */
  readonly verdict: GateVerdict;
  /** Where the scanned change came from: `git` (working tree) or `diff` (explicit file). */
  readonly source: "git" | "diff";
  /** Number of changed tracker files whose added lines were scanned. */
  readonly scanned_files: number;
  /** Number of added lines scanned. */
  readonly added_lines: number;
  /** Findings that survived the allowlist, ordered file/line/ruleset. */
  readonly findings: readonly GateFinding[];
  /** Findings suppressed because their content hash was allowlisted. */
  readonly allowlisted: number;
  /** Path of the allowlist consulted (or `""` when none was resolved). */
  readonly allowlist_path: string;
}

/**
 * Input failure the gate treats as fail-closed: unreadable diff file, not a Git
 * work tree, a Git command that failed, a malformed allowlist, or a scanner
 * error. Callers translate this into a non-zero exit; it must never surface as a
 * clean pass.
 */
export class GateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateInputError";
  }
}

/** One added line of a proposed tracker change, with its attributed item field. */
interface AddedLine {
  /** The added text with the leading diff `+` already stripped. */
  readonly text: string;
  /** Best-effort item field the line belongs to (top-level toon key, or `""`). */
  readonly field: string;
}

/** The proposed change to one tracker file: its repo-relative path plus added lines. */
interface ChangeFile {
  /** Repo-relative or diff-relative path of the changed file. */
  readonly filePath: string;
  /** Best-effort pm item id for the file (`.toon` basename, embedded jsonl id, …). */
  readonly itemId: string;
  /** The added lines of the proposed change for this file. */
  readonly addedLines: readonly AddedLine[];
}

/** Subprocess contract for running Git, injectable so tests can force failures. */
export type RunGit = (cwd: string, args: readonly string[]) => { ok: boolean; stdout: string; stderr: string };

/**
 * Collaborators a gate run depends on, injectable for tests.
 *
 * The production object shells out to Git and reads the filesystem; a test can
 * substitute either to exercise the fail-closed paths deterministically (a Git
 * failure, an unreadable file) without depending on machine state.
 */
export interface GateRunDependencies {
  /** Git runner used to resolve the work tree and collect the change. */
  readonly runGit?: RunGit;
  /** File reader used for the explicit diff file and untracked tracker files. */
  readonly readFileSync?: (filePath: string) => string;
}

/** Resolved input for one gate run: what to scan and which allowlist to consult. */
export interface TrackerGateInput {
  /** pm root as the extension host supplies it (workspace root or data dir). */
  readonly pmRoot: string;
  /** Explicit unified diff file to scan instead of the working tree. */
  readonly diffFile?: string;
  /** Explicit allowlist file; missing explicit files fail closed. */
  readonly allowlistFile?: string;
  /** Injectable collaborators; production defaults shell out to Git and `fs`. */
  readonly dependencies?: GateRunDependencies;
  /** Rendered import values scanned in memory before persistence or diagnostics. */
  readonly plannedItems?: readonly { readonly itemId: string; readonly fields: Readonly<Record<string, unknown>> }[];
  /** Scan the same rendered plan without collecting a Git diff (read-only previews). */
  readonly planOnly?: boolean;
}

// ---------------------------------------------------------------------------
// pm tracker path resolution (shared with index.ts; lives here so the gate
// module never needs an import cycle with the command module)
// ---------------------------------------------------------------------------

/**
 * Resolve the pm data dir from the `pmRoot` a command handler receives.
 *
 * The host may hand either the workspace root (the dir containing `.agents/pm`)
 * or the data dir itself — the pm CLI accepts both for `--path`. This returns
 * the dir that actually holds `settings.json` and `locks/`, defaulting to
 * `pmRoot` unchanged when no nested `.agents/pm` exists.
 *
 * @param pmRoot - The path supplied by the extension host.
 * @returns The resolved pm data directory.
 */
export function resolvePmDataDir(pmRoot: string): string {
  return resolvePmRoot(process.cwd(), pmRoot);
}

// ---------------------------------------------------------------------------
// Scanner rules
// ---------------------------------------------------------------------------

/**
 * A content rule with an optional confirmation predicate.
 *
 * The confirmation runs on the matched text and prunes values whose raw shape
 * matches the pattern but is overwhelmingly prose or structured data (e.g. a
 * bearer phrase followed by a single long word with no digits). Rules whose
 * signature is already high-confidence leave it unset.
 */
interface ContentRule {
  /** Stable rule identifier printed in findings. */
  readonly rule: string;
  /** Global regex over one added line. */
  readonly pattern: RegExp;
  /** Optional extra confirmation on the matched text. */
  readonly confirm?: (matched: string) => boolean;
}

/**
 * High-confidence credential signatures. Every pattern is shaped so ordinary
 * prose, identifiers, or version numbers cannot match it; broad low-confidence
 * patterns are deliberately excluded so reviewed imports are not buried in
 * noise — the gate stays at a zero false-positive posture on well-formed
 * trackers while every listed provider shape still fails closed.
 */
const CREDENTIAL_RULES: readonly ContentRule[] = [
  { rule: "github-token-classic", pattern: /gh[ousrp]_[A-Za-z0-9]{36}/g },
  { rule: "github-token-fine-grained", pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
  { rule: "npm-token", pattern: /npm_[A-Za-z0-9]{36}/g },
  { rule: "aws-access-key-id", pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { rule: "slack-token", pattern: /(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10,}/g },
  { rule: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{24,}/g },
  { rule: "openai-legacy-key", pattern: /sk-[A-Za-z0-9]{48}/g },
  {
    rule: "openai-api-key",
    // Consume each candidate once: a missing marker must not retry at embedded sk- prefixes.
    // The eight-character marker needs 20 payload characters on either side (48 total).
    pattern: /sk-[A-Za-z0-9_-]{48,}/g,
    confirm: matched => matched.slice("sk-".length + 20, -20).includes("T3BlbkFJ"),
  },
  { rule: "openai-project-key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { rule: "openai-service-account-key", pattern: /sk-svcacct-[A-Za-z0-9_-]{20,}/g },
  { rule: "anthropic-api-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    rule: "bearer-token",
    pattern: /(?:authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{20,})/gi,

  },
  { rule: "private-key-block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
];

// ---------------------------------------------------------------------------
// Public technical forms — the exact allowances shared by the personal-data
// and host-path rules. Each helper answers ONE narrow question; the confirms
// compose them so removing or broadening a single allowance is independently
// observable (see scripts/prove-gate-public-forms.ts).
// ---------------------------------------------------------------------------

/**
 * Documentation-only email domains reserved by RFC 2606/6761 (plus the
 * special-use `localhost` name): mail on them can never reach a real person,
 * so an address is a fixture rather than personal data. Compared exactly and
 * case-insensitively against the whole domain, so registrable look-alikes
 * (`notexample.com`, `example.com.evil.io`) stay refusals.
 */
const RESERVED_EMAIL_DOMAINS: readonly string[] = ["example.com", "example.net", "example.org", "localhost"];

/** Reserved top-level labels whose subdomains are also documentation-only. */
const RESERVED_EMAIL_DOMAIN_SUFFIXES: readonly string[] = [".example", ".invalid", ".test", ".localhost"];

/**
 * Whether an email domain (lowercased, the whole text after the at-sign) is
 * documentation-only per RFC 2606/6761.
 *
 * @param domain - The complete lowercased domain after the at-sign.
 * @returns True for `example.com`/`example.net`/`example.org`/`localhost`
 *          exactly, or any domain whose final label is `example`, `invalid`,
 *          `test` or `localhost`.
 */
function isReservedDocumentationDomain(domain: string): boolean {
  return RESERVED_EMAIL_DOMAINS.includes(domain) ||
    RESERVED_EMAIL_DOMAIN_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

/**
 * Home-root child segments that name no account: the documentation name, the
 * shell/env placeholder users, and bracketed placeholders handled separately.
 */
const HOME_PLACEHOLDER_SEGMENTS: readonly string[] = ["example", "$USER", "${USER}", "%USERNAME%"];

/**
 * Whether a path segment is a bracketed placeholder such as `<user>` or
 * `{user}`: matched brackets around a nonempty placeholder body.
 *
 * @param segment - One slash-separated path segment.
 * @param open - The required opening bracket character.
 * @param close - The required closing bracket character.
 * @returns True when the segment is exactly `open + body + close`.
 */
function isBracketedPlaceholder(segment: string, open: string, close: string): boolean {
  return segment.length > open.length + close.length && segment.startsWith(open) && segment.endsWith(close) &&
    /^[^<> {}\\/\s]+$/.test(segment.slice(open.length, segment.length - close.length));
}

/**
 * Whether a segment directly after a home root names no account.
 *
 * @param segment - The first path segment after `/home/`, `/Users/` or a
 *                  Windows `Users` root.
 * @returns True for `example`, `$USER`, `${USER}`, `%USERNAME%` and bracketed
 *          `<placeholder>`/`{placeholder}` segments.
 */
function isHomePlaceholderSegment(segment: string): boolean {
  return HOME_PLACEHOLDER_SEGMENTS.includes(segment) ||
    isBracketedPlaceholder(segment, "<", ">") || isBracketedPlaceholder(segment, "{", "}");
}

/**
 * Whether one path segment can smuggle traversal or hidden content past a
 * permitted shape.
 *
 * Exact `.`/`..` segments traverse out of the permitted root; percent signs
 * can decode to them or hide other content outside the one Windows env
 * placeholder; a backslash inside a POSIX path is content, never a separator,
 * so it could re-split the path under a different reading and is refused.
 *
 * @param segment - One separator-split path segment.
 * @param posix - Whether the path was split on forward slashes only.
 * @returns True when the segment must keep the whole path a refusal.
 */
function isEscapePathSegment(segment: string, posix: boolean): boolean {
  if (segment === "." || segment === "..") return true;
  if (segment !== "%USERNAME%" && segment.includes("%")) return true;
  return posix && segment.includes("\\");
}

/**
 * Identity-bearing roots that must never appear inside a permitted tail: the
 * two home roots, a Windows drive letter, and the account- or machine-bearing
 * system roots (`tmp`, macOS `private`/`Volumes`, and the mount roots) that a
 * real filesystem path continues into once a permitted prefix has passed.
 * `root` is included because it names the root account's home tree everywhere
 * except the one position procfs exposes it (see {@link isPublicPosixPath}).
 */
const EMBEDDED_IDENTITY_SEGMENTS: readonly string[] = ["home", "Users", "tmp", "private", "Volumes", "mnt", "media", "srv", "root"];

/**
 * Whether any segment of a permitted tail embeds a fresh identity root (a home
 * root, an account-bearing system root, or a Windows drive), which would
 * smuggle a concrete account past the allowed prefix (for example
 * `…/x/home/alice` or `…/root/tmp/alice-notes`).
 *
 * @param segments - The segments after a shape's recognized prefix.
 * @returns True when the tail must keep the whole path a refusal.
 */
function embedsIdentityRoot(segments: readonly string[]): boolean {
  return segments.some((segment) => EMBEDDED_IDENTITY_SEGMENTS.includes(segment) || /^[A-Za-z]:$/.test(segment));
}

/**
 * Runner-tail segments with the hosted runner's own `tmp` directory removed.
 *
 * The GitHub-hosted runner creates a real scratch `tmp` directory inside its
 * workspace, so that one segment is runner infrastructure rather than an
 * identity root there; every other identity segment keeps refusing the tail.
 *
 * @param segments - The segments after a runner workspace's recognized prefix.
 * @returns The tail segments the embedded-identity check must judge.
 */
function runnerTailSegments(segments: readonly string[]): readonly string[] {
  return segments.filter((segment) => segment !== "tmp");
}

/**
 * Whether an absolute POSIX path is a public, non-identifying technical form.
 *
 * Admits exactly the procfs interface paths (`/proc` itself, `/proc/self/…`
 * and `/proc/<placeholder>/…`; a concrete numeric pid names one host's process
 * and stays a refusal), the GitHub-hosted runner
 * workspaces (the fixed hosted account's `work/<seg>/<seg>/…` subtree under
 * either home root), the hosted tool cache (`/opt/hostedtoolcache/…`) and
 * placeholder home roots (`<placeholder>` children of either home root).
 * Every other root — a concrete account, `/root`, `/tmp`, `/var` and friends —
 * and any path with a traversal or encoding escape, or an identity root
 * embedded in its tail, stays a refusal.
 *
 * @param matched - The complete matched path, starting at its leading slash.
 * @returns True when the path carries no host or account identity.
 */
function isPublicPosixPath(matched: string): boolean {
  const segments = matched.slice(1).split("/");
  const [root = "", first = ""] = segments;
  if (segments.some((segment) => isEscapePathSegment(segment, true))) return false;
  if (root === "sys") return !embedsIdentityRoot(segments.slice(1));
  if (root === "proc") {
    if (first === "" || first === "self" || isBracketedPlaceholder(first, "<", ">")) {
      // `root` directly after the `self` pid directory is the real
      // procfs root entry (the process's own root). It re-exposes the whole
      // filesystem, so only the entry itself is public: anything after it
      // names a host path. As a tail segment everywhere else it names the
      // root account's tree.
      const tail = segments.slice(2);
      const exemptRootEntry = first === "self" && tail[0] === "root";
      if (exemptRootEntry) return tail.slice(1).every((segment) => segment === "");
      return !embedsIdentityRoot(tail);
    }
    return false;
  }
  if (root === "opt") return first === "hostedtoolcache" && !embedsIdentityRoot(segments.slice(2));
  if (root !== "home" && root !== "Users") return false;
  if (isHomePlaceholderSegment(first)) return !embedsIdentityRoot(segments.slice(2));
  return first === "runner" && segments[2] === "work" && (segments[3] ?? "") !== "" && (segments[4] ?? "") !== "" &&
    !embedsIdentityRoot(runnerTailSegments(segments.slice(5)));
}

/**
 * Whether a Windows drive path is a public, non-identifying technical form.
 *
 * Admits exactly the GitHub-hosted runner workspaces (`D:\a\<seg>\<seg>\…`
 * with either separator) and placeholder home roots
 * (`C:\Users\<placeholder>\…`). Any other drive, root or account segment, and
 * any path with a traversal or encoding escape, or an identity root embedded
 * in its tail, stays a refusal.
 *
 * @param matched - The complete matched path, starting at its drive letter.
 * @returns True when the path carries no host or account identity.
 */
function isPublicWindowsPath(matched: string): boolean {
  const [drive = "", ...segments] = matched.split(/[\\/]/);
  const [root = "", first = ""] = segments;
  if (segments.some((segment) => isEscapePathSegment(segment, false))) return false;
  if (drive.toLowerCase() === "c:") {
    return root === "Users" && isHomePlaceholderSegment(first) && !embedsIdentityRoot(segments.slice(2));
  }
  return drive.toLowerCase() === "d:" && root === "a" && first !== "" && (segments[2] ?? "") !== "" &&
    !embedsIdentityRoot(runnerTailSegments(segments.slice(3)));
}

/**
 * Characters of an ordinary path segment name: letters (with their combining
 * marks) and digits in any script, plus `.`, `_`, `~` and `-`. Each is judged
 * as a whole code point, so an astral letter is a name character too. Every other character inside a matched
 * host path is a delimiter that can end one path and begin the next — the two
 * bracket pairs (which continue a path while they wrap a whole placeholder
 * segment), the colon and equals of a label or assignment prefix (`cwd:`,
 * `path=`), and any other punctuation (`[`, `(`, `|`, `@`, `#`, `?`, `&`, `*`,
 * `!`, `+`, …) written straight into a permitted tail. Naming the segment
 * characters rather than the delimiters keeps unlisted punctuation from hiding
 * a second path; only a delimiter directly followed by a path start is judged.
 */
const PATH_NAME_CHARACTER = /[\p{L}\p{M}\p{N}._~-]/u;

/**
 * Whether the text after a delimiter begins with a shape a host-path rule can
 * start on: a POSIX root slash, a tilde username, a Windows drive, or a
 * `file://` URL. Every other continuation is ordinary path content.
 *
 * @param text - The complete matched path.
 * @param offset - The index directly after one delimiter.
 * @returns Whether the delimiter can end one path and begin the next.
 */
function startsWithHostPathStart(text: string, offset: number): boolean {
  const first = text[offset];
  return text.startsWith("file://", offset) || first === "/" || first === "~" || /^[A-Za-z]:[\\/]/.test(text.slice(offset, offset + 3));
}

/**
 * Whether the text after a delimiter is a host path a standalone scan would
 * refuse.
 *
 * The sticky rule patterns match at one fixed offset (the start of `rest`, or
 * the URL path of a `file://` prefix) and reproduce exactly the rule match
 * that would begin there; the verdict then uses ONLY the non-recursive
 * public-path predicates — never `rule.confirm`, whose re-entry into the
 * delimiter check branches exponentially on adversarial bracket chains. That
 * is sound because every delimiter of the match is examined on its own: a
 * refused path always begins directly after some delimiter, so it is always
 * judged at that delimiter without re-judging the suffixes around it.
 *
 * @param rest - The text following one delimiter.
 * @returns True when the suffix is a host path the gate refuses standalone.
 */
function refusedHostPathAfterDelimiter(rest: string): boolean {
  const posix = STICKY_HOST_PATH_PATTERNS.get("absolute-host-path")!;
  const windows = STICKY_HOST_PATH_PATTERNS.get("windows-host-path")!;
  const tilde = STICKY_HOST_PATH_PATTERNS.get("home-username")!;
  if (rest.startsWith("file://")) {
    posix.lastIndex = "file://".length;
    const hit = posix.exec(rest);
    return hit !== null && !isPublicPosixPath(hit[0]);
  }
  if (rest[0] === "/") {
    posix.lastIndex = 0;
    const hit = posix.exec(rest);
    return hit !== null && !isPublicPosixPath(hit[0]);
  }
  if (rest[0] === "~") {
    tilde.lastIndex = 0;
    return tilde.exec(rest) !== null;
  }
  windows.lastIndex = 0;
  const hit = windows.exec(rest);
  return hit !== null && !isPublicWindowsPath(hit[0]);
}

/**
 * Most delimiter-started paths one match may have judged. Each judgment copies
 * and checks the remaining suffix, so the bound keeps a match's cost linear in
 * its length; a match with more delimiter-started paths fails closed.
 */
const MAX_DELIMITER_PATH_JUDGMENTS = 64;

/**
 * Whether a delimiter inside a matched path begins a second host path that
 * would be refused on its own.
 *
 * A whole placeholder segment (`<pid>`, `{user}`, `${USER}`, `%USERNAME%`)
 * is judged in place, so its brackets, `$` and `%` never start a second path. A delimiter (any character
 * outside {@link PATH_NAME_CHARACTER}) in any other segment — including the
 * `:` or `=` of a label or assignment prefix — can end one path and begin the
 * next (a root-account, temp, other-drive or
 * tilde-username path written straight after it), so the text after it is
 * judged with the public-path predicates, exactly as if it stood alone.
 * The colon of a leading Windows drive prefix (`C:/…`) is the exception: it
 * belongs to the matched path itself, which the Windows predicate judged whole.
 *
 * The scan is linear in the match length: one pass keeps the segment start,
 * each segment is scanned forward once for its placeholder verdict, only
 * delimiters directly followed by a possible path start are judged (at most
 * {@link MAX_DELIMITER_PATH_JUDGMENTS}; more fail closed), and the sticky rule
 * patterns are built once (see {@link STICKY_HOST_PATH_PATTERNS}) — never rebuilt per
 * delimiter and rule, and never re-entered recursively.
 *
 * @param matched - The complete matched path.
 * @returns True when a path behind a non-placeholder delimiter must refuse the
 *          whole match.
 */
function hidesHostPathBehindDelimiter(matched: string): boolean {
  let segmentStart = 0;
  let judgedSegmentStart = -1;
  let judgedPlaceholder = false;
  let judgments = 0;
  // A Windows match begins with its own drive prefix, and the Windows
  // predicate has already judged that whole path, so the drive colon starts
  // no second path. Judging the rest as a POSIX path would keep a mixed
  // separator segment (`<user>\AppData`) whole and refuse a public form.
  const scanStart = /^[A-Za-z]:[\\/]/.test(matched) ? 2 : 0;
  for (let index = scanStart; index < matched.length; index++) {
    const character = String.fromCodePoint(matched.codePointAt(index)!);
    // Step over the low half of an astral character so it is judged once.
    if (character.length === 2) index++;
    if (character === "/" || character === "\\") {
      segmentStart = index + 1;
      continue;
    }
    if (PATH_NAME_CHARACTER.test(character)) continue;
    if (segmentStart !== judgedSegmentStart) {
      // Forward scan to this segment's end: each segment is scanned once, so
      // the whole pass stays linear in the match length.
      let segmentEnd = index;
      while (segmentEnd < matched.length && matched[segmentEnd] !== "/" && matched[segmentEnd] !== "\\") segmentEnd++;
      judgedSegmentStart = segmentStart;
      const segment = matched.slice(segmentStart, segmentEnd);
      judgedPlaceholder = isHomePlaceholderSegment(segment);
    }
    if (judgedPlaceholder || !startsWithHostPathStart(matched, index + 1)) continue;
    // Each judgment copies and checks the remaining suffix, so bound how many
    // one match may request; a match needing more fails closed.
    judgments += 1;
    if (judgments > MAX_DELIMITER_PATH_JUDGMENTS) return true;
    if (refusedHostPathAfterDelimiter(matched.slice(index + 1))) return true;
  }
  return false;
}

/**
 * Personal-data signatures: an email that is not a no-reply or documentation
 * address, and phone numbers in their two common written shapes.
 */
const PERSONAL_DATA_RULES: readonly ContentRule[] = [
  {
    rule: "email-address",
    // An SCP-style SSH clone URL (`git@github.com:owner/repo.git`, the colon
    // followed directly by a path) names the git service account, not a
    // person, so the pattern skips exactly that shape; a bare `git@host`
    // contact address, even before a colon and a space, is still matched.
    // The ssh:// form permits only the git service account with a URL path.
    // The lookbehind keeps a match from starting inside a local part.
    pattern: /(?<![A-Za-z0-9._%+-])(?!(?<=ssh:\/\/)git@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?=\/|:\d+\/))(?!git@[A-Za-z0-9.-]+\.[A-Za-z]{2,}:[A-Za-z0-9_~./-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9.-][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]*)*\.[A-Za-z]{2}[A-Za-z0-9-]*|[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt])(?![A-Za-z0-9-]|\.[A-Za-z0-9])/g,
    // GitHub, GitLab and most mail systems use a "noreply" domain or local part
    // for automated identities; anything else in imported issue text is a real
    // person's address and fails closed. RFC 2606/6761 documentation domains
    // (matched exactly after the at-sign) never deliver to a person, so fixture
    // addresses on them are public examples rather than personal data; every
    // registrable look-alike (`notexample.com`, `example.com.evil.io`) still
    // fails closed.
    confirm: (matched) => {
      const [local, domain] = matched.toLowerCase().split("@");
      if (/^(?:no-?reply)$/.test(local!) || /(?:^|\.)no-?reply(?:\.|$)/.test(domain!)) return false;
      return !isReservedDocumentationDomain(domain!);
    },
  },
  {
    rule: "phone-number",
    pattern: /\+\d{1,3}[\s.-]?(?:\d{2,4}[\s.-]?){2,4}\d{2,4}/g,
    // International notation needs a real phone digit count; short sequences
    // like "+1 2 3" are not phone numbers. The pattern guarantees at least one
    // digit, so the match can never be null here.
    confirm: (matched) => matched.match(/\d/g)!.length >= 8,
  },
  {
    rule: "phone-number",
    pattern: /\(\d{3}\)\s*\d{3}[\s.-]\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g,
    // The North-American grouping is 10 digits by construction; the digit check
    // only guards the parenthesized variant against truncation by surrounding
    // punctuation.
    confirm: (matched) => matched.match(/\d/g)!.length === 10,
  },
  {
    rule: "phone-number",
    pattern: /\b(?:phone|telephone|tel|mobile)\b["']?\s*[:=](?:\s*["']\s*|\s*)\+?\d[\d \t().-]{5,}\d/gi,
    // Contact labels distinguish unformatted numbers from issue/comment ids.
    confirm: (matched) => { const digits = matched.replace(/\D/g, "").length; return digits >= 7 && digits <= 15; },
  },
];

/**
 * Host-identifying path signatures: absolute personal/system filesystem paths
 * and home-directory usernames (`~user`, but never the anonymous `~/`), which
 * would publish the machine and account that produced an import. The list is
 * the POSIX/Windows set a developer workstation actually leaks, mirroring the
 * repository's own object-store privacy gate. Each path rule also carries a
 * `confirm` that keeps exactly the public, non-identifying technical forms
 * (see the public-forms helpers above) from failing; everything a real
 * person's machine produces still fails closed.
 */
const HOST_PATH_RULES: readonly ContentRule[] = [
  {
    rule: "absolute-host-path",
    // Anchored to roots that identify a host (home, system and mount roots),
    // so GitHub slash commands (`/assign`), repository-relative links
    // (`/docs/setup.md`) and API routes (`GET /api/v1`) in issue text are not
    // flagged; the root must end at a separator or delimiter (`/homework` is
    // not `/home`). The lead-in is a lookbehind so the match is the path
    // itself; it also admits `file://` URLs and `label:` prefixes (`cwd:/home/…`),
    // whose two-character minimum leaves drive letters to the Windows rule.
    // Every opening or closing bracket is a lead-in too, so a path hidden
    // directly behind a permitted form (an allowed root followed by `>` or
    // `;`) is still matched on its own. Angle brackets are continuation
    // characters (they carry placeholder segments such as `<pid>`), never a
    // silent stop; the confirm then judges the complete path and refuses a
    // second host path hiding behind any delimiter inside it. A closing tag
    // that names one bare word (`</var>`, `</root>`) is markup, not a path:
    // its slash never starts a match, and a match ends before it, so the tag
    // can never pass as a path segment. `</home/alice>` is still matched.
    pattern: /(?<=^|[\s"'`([=,{<>),;\]}]|[A-Za-z0-9_]{2}:|file:\/\/)(?!(?<=<)\/[A-Za-z]+>)\/(?:home|Users|root|tmp|var|etc|opt|srv|mnt|media|private|Volumes|usr|run|proc|sys|data|nix|scratch|workspace|builds|Library|System)(?=\/|$|[\s"'`<>),;\]}])(?:\/(?:(?!<\/[A-Za-z]+>)[^\s"'`),;\]])*)?/g,
    confirm: (matched) => !isPublicPosixPath(matched) || hidesHostPathBehindDelimiter(matched),
  },
  {
    rule: "windows-host-path",
    // A drive letter at a token start, or as a `file:///C:/…` URL path.
    // Angle brackets are continuation characters here too, so placeholder
    // segments (`<placeholder>` after a Users root) are matched whole and
    // judged by the confirm instead of truncating the match before them. A
    // match ends before a bare closing tag (`</var>`), as in the POSIX rule.
    pattern: /(?:(?<![A-Za-z0-9_:/])|(?<=file:\/\/\/))[A-Za-z]:[\\/](?:(?!<\/[A-Za-z]+>)[^\s"'`),;\]])+/g,
    confirm: (matched) => !isPublicWindowsPath(matched) || hidesHostPathBehindDelimiter(matched),
  },
  {
    rule: "home-username",
    // A leading tilde followed by a name AND a path separator is a username
    // leak (`~alice/report.txt`); `~/` (anonymous), `~~strikethrough~~`, and
    // prose approximations (`~most users`) are excluded by the boundary and
    // the required trailing slash. The boundary is any character outside the
    // segment-name class and the path separators, the same set the delimiter
    // scan uses, so a `]`, `)` or `;` that ends a host-path match cannot hide
    // a tilde path written straight after it.
    pattern: /(?:^|[^\p{L}\p{N}._~/\\-])~[A-Za-z][A-Za-z0-9._-]*\/[^\s"'`<>),;\]}]*/gu,
  },
];

/**
 * Sticky copies of the host-path rule patterns, built once per process and
 * reused for every delimiter suffix. A sticky match at the start of a suffix
 * (or at the URL path of a `file://` prefix) reproduces exactly the rule match
 * that would begin there, so suffixes are judged without re-running the
 * rules — and therefore without re-entering their confirms — recursively.
 */
const STICKY_HOST_PATH_PATTERNS: ReadonlyMap<string, RegExp> = new Map(
  // Keep every flag but the global one (the tilde rule needs `u`).
  HOST_PATH_RULES.map((rule) => [rule.rule, new RegExp(rule.pattern.source, `${rule.pattern.flags.replace("g", "")}y`)] as const),
);

/** Identifier segments whose presence marks an assignment target as secret-bearing. */
const SECRET_IDENTIFIER_SEGMENTS: readonly string[] = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "apikey",
];

/**
 * Identifier segment pairs (normalized on `[_-]`) that mark composite assignment
 * targets like `api_key` or `private_key` without matching prose such as
 * `sort_key` or `author`.
 */
const SECRET_IDENTIFIER_PAIRS: readonly string[] = ["api_key", "access_key", "private_key", "secret_key"];

/** Assignment shape for the high-entropy rule: `NAME = "value"` / `name: value`. */
const HIGH_ENTROPY_ASSIGNMENT =
  /(?:^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9_-]{0,48})(?:\\?["'`])?\s*[:=]\s*(?:\\?["'`])?([A-Za-z0-9+/_=-]{20,256})(?:\\?["'`])?/dg;

/**
 * Shannon entropy per character of a value.
 *
 * Uniform random base62 has an expected ~5.5 bits/char, random hex ~4.0; natural
 * language and dates sit far lower (~3–3.4). The assignment rule uses the gap:
 * a long value over a secret-bearing identifier is only a finding when its
 * per-character entropy is indistinguishable from random.
 *
 * @param value - The string to measure.
 * @returns Bits per character (0 for the empty string).
 */
export function shannonEntropyPerChar(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Whether an `identifier = "value"` assignment looks like a hardcoded secret.
 *
 * Fires only when the identifier names a credential (token/secret/password/
 * credential/api_key/access_key/private_key segment) AND the value is long
 * (≥20 chars), high-entropy (≥3.9 bits/char — above dates, timestamps, prose),
 * and the identifier names a credential. Both halves are required: identifier-only would
 * flag every `token: "the token above"` prose reference, entropy-only would
 * flag every generated id.
 *
 * @param identifier - The assignment target, e.g. `AWS_SECRET_ACCESS_KEY`.
 * @param value - The assigned value text.
 * @returns Whether the pair reads as a hardcoded credential.
 */
export function isHighEntropySecretAssignment(identifier: string, value: string): boolean {
  if (value.length < 20) return false;
  const segments = identifier.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]+/).filter(Boolean);
  const namesSecret =
    segments.some((segment) => SECRET_IDENTIFIER_SEGMENTS.includes(segment)) ||
    SECRET_IDENTIFIER_PAIRS.includes(segments.join("_"));
  if (!namesSecret) return false;
  return shannonEntropyPerChar(value) >= 3.9;
}

/** One raw hit of a content rule, before item/field attribution. */
interface RuleHit {
  /** Rule identifier that fired. */
  readonly rule: string;
  /** The matched text — kept in memory only; never printed or reported. */
  readonly matched: string;
  /** Character offset of the match within its line, for jsonl field attribution. */
  readonly index: number;
}

/** Sticky `\uXXXX` matcher: reads at one offset without copying the line suffix. */
const UNICODE_ESCAPE = /\\u([0-9a-f]{4})/iy;

/** Complete Markdown code-fence marker at a known line start. */
const CODE_FENCE = /```[A-Za-z0-9_-]*[ \t]*(?:\r?\n|$)/y;

/**
 * Locate a whole JSON string field's serialization quotes, including TOON scalars.
 *
 * Only a complete, valid string wrapper is ignored for code quote tracking;
 * quotes within its decoded content still delimit strings in the source.
 *
 * @param line - Original field value or serialized tracker line.
 * @param trackerLine - Whether a TOON scalar wrapper is meaningful here.
 * @returns Outer quote offsets, or undefined for ordinary text.
 */
function serializedStringBounds(line: string, trackerLine: boolean): readonly [number, number] | undefined {
  const start = line.indexOf('"');
  if (start < 0 || !(trackerLine ? /^\s*(?:[a-z][a-z0-9_]*:\s*)?$/ : /^\s*$/).test(line.slice(0, start))) return undefined;
  const end = line.trimEnd().length - 1;
  try {
    JSON.parse(line.slice(start, end + 1));
    return [start, end];
  } catch {
    return undefined;
  }
}

/**
 * Mark string-literal content in one linear pass over decoded text.
 *
 * Escaped quotes cannot close a string. Ambiguous slashes retain both regex
 * and division interpretations, including regex character classes. Markdown
 * fences delimit code; single backticks are treated as template strings.
 *
 * @param line - Decoded source with serialization quotes blanked out.
 * @returns Whether each character lies inside quoted source text.
 */
function quotedSourcePositions(line: string): boolean[] {
  const quoted: boolean[] = [];
  // A slash may be division or a regex opener. Retain both interpretations:
  // quotes inside earlier regex source must not cancel a later real string.
  let states = new Set([""]);
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const ch = line[index]!;
    quoted[index] = states.has('"') || states.has("'") || states.has("`");
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === "`" && (index === 0 || line[index - 1] === "\n") && states.has("") && !states.has('"') && !states.has("'")) {
      CODE_FENCE.lastIndex = index;
      const fence = CODE_FENCE.exec(line);
      if (fence) { index += fence[0].length - 1; states = new Set([""]); continue; }
    }
    if (!["/", "[", "]", "\n", '"', "'", "`"].includes(ch)) continue;
    const next = new Set<string>();
    for (const state of states) {
      if (ch === "\n" && state !== "`") next.add("");
      else if (state === "/") next.add(ch === "/" ? "" : ch === "[" ? "[" : state);
      else if (state === "[") next.add(ch === "]" ? "/" : state);
      else if (state === "") {
        if (ch === "/") { next.add(""); next.add("/"); }
        else next.add(['"', "'", "`"].includes(ch) ? ch : "");
      } else next.add(ch === state ? "" : state);
    }
    states = next;
  }
  return quoted;
}

/**
 * Recognize a bare-root token inside an immediately invoked JavaScript regex.
 *
 * Require an expression boundary and a closed regex expression without crossing
 * quotes, escapes, newlines or another slash. Actual slash-separated paths
 * remain findings, including paths inside regex source. Walk the lead-in once
 * backwards instead of rescanning a whole prefix for every candidate. Quoted
 * source is excluded using a shared linear quote scan.
 *
 * @param line - Decoded field or serialized tracker line.
 * @param matched - Candidate absolute host path.
 * @param index - Candidate offset in the decoded line.
 * @param quoted - Whether the candidate occurs inside quoted source.
 * @returns Whether this candidate is recognizable regex source rather than a path.
 */
function isBareRootRegex(line: string, matched: string, index: number, quoted: boolean): boolean {
  if (quoted || matched.slice(1).includes("/")) return false;
  let before = index - 1;
  while (before >= 0 && /[ \t]/.test(line[before]!)) before--;
  return (before < 0 || "=([,:".includes(line[before]!)) &&
    /^[ \t][^/"'`\\\r\n]*\/[dgimsuvy]*(?:\.(?:test|exec)[ \t]*\(|[ \t]*(?:[,;)]|$))/.test(line.slice(index + matched.length));
}

/**
 * Scan one added line with every content rule.
 *
 * Rules are evaluated independently: one line can produce several hits (a
 * bearer header wrapping a GitHub token reports both shapes), because each is a
 * distinct reviewed rule. The high-entropy assignment rule is regex-scan +
 * predicate, so it is driven here rather than in the static table.
 *
 * @param line - Decoded field value or added tracker line (diff `+` stripped).
 * @param trackerLine - Whether the caller supplies serialized TOON tracker text.
 * @returns Every rule hit on the line, in evaluation order.
 */
export function scanLineForRuleHits(line: string, trackerLine = false): RuleHit[] {
  // Serialized tracker text may escape separators or provider prefixes. Map
  // decoded characters back to their original offsets for history attribution.
  const serialized = serializedStringBounds(line, trackerLine);
  const offsets: number[] = [];
  let decoded = "";
  for (let index = 0; index < line.length; index++) {
    // A sticky match at the current offset keeps the decoder linear in the line
    // length; slicing the suffix per character is quadratic where slices copy.
    UNICODE_ESCAPE.lastIndex = index;
    const unicode = line[index] === "\\" ? UNICODE_ESCAPE.exec(line) : null;
    if (unicode) {
      decoded += String.fromCharCode(Number.parseInt(unicode[1]!, 16));
      offsets.push(index);
      index += 5;
    } else if (serialized && (index === serialized[0] || index === serialized[1])) {
      decoded += " ";
      offsets.push(index);
    } else if (serialized && line[index] === "\\" && line[index + 1] === '"') {
      decoded += '"';
      offsets.push(index);
      index++;
    } else if (line[index] === "\\" && /[\\/nrt]/.test(line[index + 1] ?? "")) {
      decoded += ownValue({ n: "\n", r: "\r", t: "\t" }, line[index + 1]!) ?? line[index + 1]!;
      offsets.push(index);
      index++;
    } else {
      decoded += line[index]!;
      offsets.push(index);
    }
  }
  let quoted: boolean[] | undefined;
  // Rule normalization can collapse backslash pairs in raw source. Keep its
  // original quote state too, so that an escaped quote cannot become a closer.
  let originalQuoted: boolean[] | undefined;
  const hits: RuleHit[] = [];
  for (const rule of [...CREDENTIAL_RULES, ...PERSONAL_DATA_RULES, ...HOST_PATH_RULES]) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(decoded); match; match = rule.pattern.exec(decoded)) {
      if (rule.rule === "absolute-host-path") {
        // Only this rule needs quote state. Inputs without host-path candidates
        // avoid two full scans, and unchanged decoded text shares the same map.
        quoted ??= quotedSourcePositions(decoded);
        originalQuoted ??= serialized ? [] : decoded === line ? quoted : quotedSourcePositions(line);
        if (isBareRootRegex(decoded, match[0], match.index, quoted[match.index]! || originalQuoted[offsets[match.index]!] === true)) continue;
      }
      if (!rule.confirm || rule.confirm(match[0])) {
        const matched = rule.rule === "home-username" ? match[0].slice(match[0].indexOf("~")) : match[0];
        const start = match.index + match[0].length - matched.length;
        hits.push({ rule: rule.rule, matched, index: offsets[start]! });
      }
    }
  }
  HIGH_ENTROPY_ASSIGNMENT.lastIndex = 0;
  for (let match = HIGH_ENTROPY_ASSIGNMENT.exec(decoded); match; match = HIGH_ENTROPY_ASSIGNMENT.exec(decoded)) {
    const [identifier, value] = [match[1]!, match[2]!];
    if (isHighEntropySecretAssignment(identifier, value)) {
      hits.push({ rule: "high-entropy-assignment", matched: value, index: offsets[match.indices![2]![0]]! });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Item id + field attribution
// ---------------------------------------------------------------------------

/** Top-level field header of a `.toon` line, e.g. `body:`, `notes[7]{…}:`, `tags[5]:`. */
const TOON_FIELD_HEADER = /^([a-z][a-z0-9_]*)(?:\[\d+\])?(?:\{[^}]*\})?\s*:/;

/** One source line of a diff walk, marked added or unchanged context. */
interface WalkLine {
  /** Line text without the diff marker. */
  readonly text: string;
  /** Whether the line is an added (`+`) line rather than context. */
  readonly added: boolean;
}

/**
 * Attribute a toon field to every line of a change walk.
 *
 * Walks the lines in file order maintaining the enclosing top-level field: a
 * field header (added OR context) updates the tracker, so an added section row
 * (`"ts",author,"text"`) attributes to its section (`notes`, `files`, …) even
 * when the section header itself is unchanged context. Added lines that are
 * their own field header attribute to that field.
 *
 * @param lines - Added and context lines in walk order.
 * @returns A field name per input line (never `undefined`; `"unknown"` when no header was seen yet).
 */
export function attributeToonFields(lines: readonly WalkLine[]): string[] {
  let current = "unknown";
  return lines.map((line) => {
    const match = TOON_FIELD_HEADER.exec(line.text);
    if (match) current = match[1]!;
    return current;
  });
}

/** Item id statement inside a pm history JSONL event. */
const JSONL_ITEM_ID = /"path":"\/metadata\/id"\s*,\s*"value":"([^"]+)"/;

/**
 * Resolve the item id for a changed tracker file.
 *
 * `.toon` files are named `<id>.toon`; history JSONL carries the id inside the
 * event (the file itself is also named `<id>.jsonl`, but reading the event makes
 * a synthesized diff work identically); other paths have no item id.
 *
 * @param filePath - The changed file path.
 * @param line - The added line being attributed (already needed for JSONL).
 * @returns The item id, or `""`.
 */
function itemIdForFile(filePath: string, line: string): string {
  const base = path.basename(filePath);
  if (base.endsWith(".toon")) return base.slice(0, -".toon".length);
  if (base.endsWith(".jsonl")) return JSONL_ITEM_ID.exec(line)?.[1] ?? base.slice(0, -".jsonl".length);
  return "";
}

// ---------------------------------------------------------------------------
// Change collection — unified diff parsing and Git working-tree collection
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff into per-file added lines with toon field attribution.
 *
 * Accepts `git diff` (with or without `a/` `b/` prefixes) and plain
 * `diff -u` output. Removed lines are skipped — only the proposed ADDITIONS can
 * publish new content; deletions cannot leak anything that was not already in
 * the tracked state.
 *
 * @param diffText - The unified diff text.
 * @returns One entry per changed file with added lines and attribution.
 */
export function parseUnifiedDiff(diffText: string): ChangeFile[] {
  if (diffText.trim() !== "" && !/^\+\+\+ /m.test(diffText) && !/^diff --git /m.test(diffText)) {
    throw new GateInputError("pm github gate: input is not a unified diff.");
  }
  const files: ChangeFile[] = [];
  let filePath = "";
  let itemId = "";
  let walk: WalkLine[] = [];
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  const completeHunk = (): void => {
    if (oldRemaining !== 0 || newRemaining !== 0) {
      throw new GateInputError("pm github gate: unified diff is truncated or malformed.");
    }
    inHunk = false;
  };

  const flushFile = (): void => {
    if (filePath === "" || walk.length === 0) {
      walk = [];
      return;
    }
    const fields = attributeToonFields(walk);
    const added = walk
      .map((line, index) => ({ line, field: fields[index]! }))
      .filter((entry) => entry.line.added)
      .map((entry) => ({ text: entry.line.text, field: entry.field }));
    files.push({ filePath, itemId, addedLines: added });
    walk = [];
  };

  const lines = diffText.split("\n");
  for (const raw of lines) {
    if (raw === "GIT binary patch" || raw.startsWith("Binary files ") || raw.includes("\0")) {
      throw new GateInputError("pm github gate: binary input cannot be privacy-scanned.");
    }
    if (raw.startsWith("diff --git ") || (raw.startsWith("--- ") && !(inHunk && oldRemaining > 0))) {
      completeHunk();
      flushFile();
      filePath = "";
      continue;
    }
    if (raw.startsWith("+++ ") && !(inHunk && newRemaining > 0)) {
      completeHunk();
      flushFile();
      filePath = raw.slice(4).split("\t")[0]!.trim();
      if (filePath.startsWith('"')) {
        try { filePath = JSON.parse(filePath) as string; } catch {
          throw new GateInputError("pm github gate: unreadable diff filename.");
        }
      }
      if (filePath === "/dev/null") filePath = "";
      else filePath = filePath.replace(/^[ab]\//, "");
      itemId = "";
      continue;
    }
    // Header and index lines before a target are metadata, but a hunk is parsed
    // even without one: its added lines must never pass unscanned.
    if (filePath === "" && !inHunk && !raw.startsWith("@@")) continue;
    if (raw.startsWith("@@")) {
      completeHunk();
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(raw);
      if (!hunk) throw new GateInputError("pm github gate: invalid unified diff hunk.");
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      inHunk = true;
      continue;
    }
    // Diff metadata (`\ No newline at end of file`) is checked before the marker
    // checks: real added content is always `+`-prefixed, so a bare `\\` line is
    // never content.
    if (raw.startsWith("\\")) continue;
    if (raw === "" && !inHunk) continue;
    if (!inHunk) throw new GateInputError("pm github gate: content outside a diff hunk.");
    if (raw.startsWith("+")) {
      // Only `+++ /dev/null` or a header without a ---/+++ pair leaves no
      // target; Git never adds lines there, so an operator-supplied --diff that
      // does is malformed and fails closed rather than passing vacuously.
      if (filePath === "") throw new GateInputError("pm github gate: added diff content has no target file.");
      newRemaining--;
      const text = raw.slice(1);
      if (itemId === "") itemId = itemIdForFile(filePath, text);
      walk.push({ text, added: true });
      continue;
    }
    if (raw.startsWith("-")) { oldRemaining--; continue; }
    if (raw.startsWith(" ")) {
      oldRemaining--;
      newRemaining--;
      // The enclosing branch guarantees the leading space.
      walk.push({ text: raw.slice(1), added: false });
      continue;
    }
    if (raw === "" && oldRemaining === 0 && newRemaining === 0) { completeHunk(); continue; }
    throw new GateInputError("pm github gate: invalid unified diff content.");
  }
  completeHunk();
  flushFile();

  return files;
}

/**
 * Read one whole file as a proposed addition (an untracked tracker file).
 *
 * A file Git has never tracked has no diff, but its full content is exactly the
 * change a commit would publish, so every line is treated as added.
 *
 * @param filePath - Absolute path of the file to read.
 * @param repoRelative - Repo-relative path for attribution.
 * @param readFileSync - File reader (injectable).
 * @returns The change file with all lines added.
 */
function wholeFileChange(
  filePath: string,
  repoRelative: string,
  readFileSync: (filePath: string) => string,
): ChangeFile {
  const content = readFileSync(filePath);
  if (content.includes("\0")) throw new GateInputError("pm github gate: binary input cannot be privacy-scanned.");
  const lines = content.split("\n").map((text) => ({ text, added: true }));
  const fields = attributeToonFields(lines);
  let itemId = "";
  const addedLines = lines.map((line, index) => {
    if (itemId === "") itemId = itemIdForFile(repoRelative, line.text);
    return { text: line.text, field: fields[index]! };
  });
  return { filePath: repoRelative, itemId, addedLines };
}

/**
 * Operational tracker subpaths the gate does not scan.
 *
 * `locks/`, `extensions/`, and `checkpoints/` hold transient process state,
 * installed extension code, and resumable journals — none of it is pm item
 * content, all of it is either gitignored or runtime-managed, and scanning
 * installed extension code would re-litigate reviewed package text on every
 * run. Item files, history, schema, and settings stay in scope.
 */
const UNTRACKED_SCAN_EXCLUDED = ["locks", "extensions", "checkpoints"];

/**
 * Whether a repo-relative changed path is operational state, out of gate scope.
 *
 * @param repoRelative - Repo-relative path of the changed file.
 * @returns Whether the path is excluded from scanning.
 */
function isOperationalTrackerPath(repoRelative: string): boolean {
  const normalized = repoRelative.replace(/\\/g, "/");
  return UNTRACKED_SCAN_EXCLUDED.includes(normalized.split("/")[0]!);
}

/**
 * Run Git with the production subprocess runner.
 *
 * Trimmed stdout is returned as-is; a non-zero exit yields `ok: false` with the
 * child's stderr so the fail-closed collector can report a diagnosable error.
 *
 * @param cwd - Directory to run in.
 * @param args - Git argument vector.
 * @returns The normalized subprocess result.
 */
export function runGitDefault(cwd: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    // stdout/stderr are nullish only when the child never spawned, and spawnSync
    // then always reports the failure through `result.error`, so no second
    // "git failed" fallback can ever be needed beyond String(result.error).
    stdout: new TextDecoder("utf-8", { fatal: true }).decode(result.stdout ?? Buffer.alloc(0)),
    stderr: result.stderr ? new TextDecoder("utf-8", { fatal: true }).decode(result.stderr) : String(result.error),
  };
}

/**
 * Read tracker, diff, or allowlist text without silently replacing invalid bytes.
 *
 * @param filePath - Input file to decode as UTF-8.
 * @returns Complete decoded text; malformed input throws and fails the gate.
 */
function readTrackerText(filePath: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath));
}

/**
 * Collect the proposed tracker change from the Git working tree.
 *
 * The proposed change is everything a commit would publish: staged plus unstaged
 * modifications of tracked files under the tracker path (their added diff lines)
 * and the full content of untracked files under it. Unreachable/deleted paths
 * contribute nothing; operational subpaths are excluded by
 * {@link isOperationalTrackerPath}. Any Git or read failure throws
 * {@link GateInputError} — fail closed, never pass vacuously.
 *
 * @param pmDataDir - The resolved pm data directory.
 * @param dependencies - Injectable Git runner and file reader.
 * @returns One change entry per scanned file (empty when the tree is clean).
 */
export function collectTrackerChange(
  pmDataDir: string,
  dependencies: GateRunDependencies = {},
): ChangeFile[] {
  const runGit = dependencies.runGit ?? runGitDefault;
  const readFileSync = dependencies.readFileSync ?? readTrackerText;

  const toplevel = runGit(pmDataDir, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok || toplevel.stdout.trim() === "") {
    throw new GateInputError(
      "pm github gate: the pm root is not inside a Git work tree, so the proposed tracker change cannot be read. " +
        "Run inside the repository, or pass --diff <file> to scan an explicit diff.",
    );
  }
  const repoRoot = fs.realpathSync(toplevel.stdout.trim());
  const trackerDir = fs.realpathSync(pmDataDir);
  const trackerRel = path.relative(repoRoot, trackerDir);
  if (trackerRel.startsWith("..")) {
    throw new GateInputError(
      "pm github gate: the resolved pm tracker path escapes the Git work tree; refusing to scan an unclear change.",
    );
  }
  const trackerSpec = trackerRel === "" ? "." : trackerRel;

  // Literal pathspecs: a tracker path must never be read as pathspec magic
  // (":(...)", ":!") or a glob, or its diff could come back empty and unread.
  const status = runGit(repoRoot, ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", trackerSpec]);
  if (!status.ok) {
    throw new GateInputError("pm github gate: git status failed; refusing to scan incomplete input.");
  }

  const changes: ChangeFile[] = [];
  const tokens = status.stdout.split("\0").filter((token) => token !== "");
  for (let index = 0; index < tokens.length; index++) {
    const entry = tokens[index]!;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    // Rename/copy entries carry the original path as the next NUL token; it is
    // provenance of the rename, not a second changed path.
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") index++;
    if (xy === "??" && isOperationalTrackerPath(path.relative(trackerDir, path.join(repoRoot, filePath)))) continue;
    if (xy === "??") {
      const absolute = path.join(repoRoot, filePath);
      let size = 0;
      let symlink = false;
      try {
        const stat = fs.lstatSync(absolute);
        size = stat.size;
        symlink = stat.isSymbolicLink();
      } catch {
        throw new GateInputError("pm github gate: a proposed file cannot be inspected.");
      }
      if (size > UNTRACKED_FILE_BYTE_CAP) {
        throw new GateInputError(
          `pm github gate: an untracked tracker file exceeds the ${UNTRACKED_FILE_BYTE_CAP}-byte scan cap; refusing to guess.`,
        );
      }
      changes.push(wholeFileChange(absolute, filePath, symlink ? (file) => fs.readlinkSync(file) : readFileSync));
      continue;
    }
    if (xy.includes("D") && !/[AMU]/.test(xy)) continue; // pure deletion
    const addedLines: AddedLine[] = [];
    for (const revision of [["--cached"], []]) {
      const diff = runGit(repoRoot, ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=2147483647", ...revision, "--", filePath]);
      if (!diff.ok) {
        throw new GateInputError("pm github gate: git diff failed; refusing to scan incomplete input.");
      }
      for (const parsed of parseUnifiedDiff(diff.stdout)) addedLines.push(...parsed.addedLines);
    }
    if (addedLines.length > 0) changes.push({ filePath, itemId: itemIdForFile(filePath, ""), addedLines });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/** One reviewed allowlist entry for a matched content hash. */
interface AllowlistEntry {
  /** Human-readable justification recorded next to the exemption in review. */
  readonly reason: string;
}

/**
 * Parse a gate allowlist file.
 *
 * The file maps the sha256 of REVIEWED matched content to a written
 * justification. Entries without a non-empty reason are rejected — an unreviewed
 * exemption is how a gate rots. A missing file fails closed only when it was
 * passed explicitly; the default location is optional so a clean repo needs no
 * allowlist file.
 *
 * @param allowlistPath - Absolute path of the allowlist JSON.
 * @param required - Whether an explicit caller named the file (missing → error).
 * @param readFileSync - File reader (injectable).
 * @returns Hash → justification entries.
 */
export function readGateAllowlist(
  allowlistPath: string,
  required: boolean,
  readFileSync: (filePath: string) => string = (filePath) => fs.readFileSync(filePath, "utf-8"),
): Map<string, AllowlistEntry> {
  let raw: string;
  try {
    raw = readFileSync(allowlistPath);
  } catch (err: unknown) {
    if (!required && (err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new GateInputError("pm github gate: allowlist file is unreadable.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GateInputError("pm github gate: allowlist file is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GateInputError(`pm github gate: allowlist file must be a JSON object keyed by content hash`);
  }
  const entries = new Map<string, AllowlistEntry>();
  for (const [hash, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new GateInputError(`pm github gate: allowlist key is not a sha256 content hash`);
    }
    const reason = (value as { reason?: unknown } | null)?.reason;
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new GateInputError(`pm github gate: allowlist entry ${hash.slice(0, 12)}… has no review justification`);
    }
    entries.set(hash, { reason: reason.trim() });
  }
  return entries;
}

/** Default allowlist filename, resolved at the repository root when one exists. */
export const GATE_ALLOWLIST_FILENAME = ".pm-github-gate-allowlist.json";

/** Byte cap for reading one untracked tracker file whole (8 MiB). */
const UNTRACKED_FILE_BYTE_CAP = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Gate run
// ---------------------------------------------------------------------------

/**
 * Scan one change file's added lines and proposed filename and return raw findings.
 *
 * Each hit is attributed to the changed file's item id; the field comes from the
 * toon walk for `.toon` files and from the enclosing JSONL patch entry for
 * history files. Duplicate hits of the same rule + content + item + field
 * within one file collapse to one finding, so one pasted token repeated in a
 * body reads as one finding, not as noise.
 *
 * @param change - The proposed change for one file.
 * @returns Raw findings including matched content (used for hashing only).
 */
function scanChangeFile(change: ChangeFile): Array<GateFinding & { matched: string }> {
  const findings: Array<GateFinding & { matched: string }> = [];
  const seen = new Set<string>();
  const proposedLines = change.addedLines.length === 0 ? [] : [
    { text: change.filePath, field: "file_path" }, ...change.addedLines,
  ];
  for (const line of proposedLines) {
    const values: Array<{ text: string; field: string }> = [];
    if (change.filePath.endsWith(".jsonl") && line.field !== "file_path") {
      if (line.text.trim() === "") continue;
      // Structural JSON patch paths are pointers, while their values are data.
      // Decode data before scanning so escaped separators cannot bypass a rule.
      let parsed: unknown;
      try { parsed = JSON.parse(line.text); } catch {
        throw new GateInputError("pm github gate: malformed history event.");
      }
      const pending: Array<{ value: unknown; field: string }> = [{ value: parsed, field: "unknown" }];
      while (pending.length > 0) {
        const entry = pending.pop()!;
        if (typeof entry.value === "string") values.push({ text: entry.value, field: entry.field });
        else if (Array.isArray(entry.value)) {
          for (const value of entry.value) pending.push({ value, field: entry.field });
        } else if (entry.value !== null && typeof entry.value === "object") {
          const record = entry.value as Record<string, unknown>;
          const patch = typeof record.op === "string" && ["add", "replace", "remove", "test", "move", "copy"].includes(record.op) && typeof record.path === "string";
          if (patch) {
            for (const key of ["path", "from"]) {
              // Pointers are scanned like data: the host-path rules are anchored
              // to host roots, so `/metadata/...` and `/body` pointers never match,
              // and a secret embedded in a field key is still caught.
              const value = ownValue(record, key);
              if (typeof value === "string") values.push({ text: value, field: key });
            }
          }
          if (patch && Object.hasOwn(record, "value")) {
            const parts = (record.path as string).split("/").filter(Boolean);
            pending.push({ value: record.value, field: parts[0] === "metadata" ? (parts[1] ?? "metadata") : (parts[0] ?? "unknown") });
          }
          for (const [key, value] of Object.entries(record)) {
            if (patch && ["op", "path", "value", "from"].includes(key)) continue;
            // Keys are data too: a credential used as an object key must not pass
            // unscanned (a .toon line with the same content is scanned as text).
            values.push({ text: key, field: entry.field });
            pending.push({ value, field: key === "metadata" || key === "patch" ? entry.field : key });
          }
        }
      }
    } else values.push({ text: line.text, field: line.field });
    for (const value of values) {
      for (const hit of scanLineForRuleHits(value.text, change.filePath.endsWith(".toon") && line.field !== "file_path")) {
        const field = value.field;
        const itemId = change.itemId || itemIdForFile(change.filePath, line.text);
        const key = `${hit.rule}\0${itemId}\0${field}\0${hit.matched}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          rule: hit.rule,
          item_id: scanLineForRuleHits(itemId).length > 0 ? "" : itemId,
          field: scanLineForRuleHits(field).length > 0 ? "unknown" : field,
          hash: createHash("sha256").update(hit.matched).digest("hex"),
          match_offset: hit.index,
          excerpt: hit.rule === "absolute-host-path" ? `/${hit.matched[1]}***/…` : "[redacted]",
          matched: hit.matched,
        });
      }
    }
  }
  return findings;
}

/**
 * Run the fail-closed privacy gate over a proposed tracker change.
 *
 * Resolves the change (explicit `--diff` file, or the staged/working/untracked
 * diff under the resolved pm tracker path), scans every added line with the
 * credential, personal-data, and host-path rules, and applies the reviewed
 * content-hash allowlist. Any input, Git, allowlist, or scanner failure throws
 * {@link GateInputError}; a returned report therefore always describes a
 * completed scan.
 *
 * @param input - pm root, optional diff file, optional allowlist file, injectable deps.
 * @returns The machine-readable gate report.
 */
export function runTrackerGate(input: TrackerGateInput): GateReport {
  const readFileSync = input.dependencies?.readFileSync ?? readTrackerText;
  const runGit = input.dependencies?.runGit ?? runGitDefault;

  const pmDataDir = resolvePmDataDir(input.pmRoot);
  let source: GateReport["source"];
  let files: ChangeFile[];
  try {
    if (input.planOnly) {
      source = "diff";
      files = [];
    } else if (input.diffFile) {
      source = "diff";
      const diffText = readFileSync(path.resolve(input.diffFile));
      files = parseUnifiedDiff(diffText);
    } else {
      source = "git";
      files = collectTrackerChange(pmDataDir, { runGit, readFileSync });
    }
    for (const item of input.plannedItems ?? []) {
      files.push({ filePath: "planned.jsonl", itemId: item.itemId, addedLines: [{
        text: JSON.stringify({ metadata: item.fields }), field: "unknown",
      }] });
    }
  } catch (err: unknown) {
    if (err instanceof GateInputError) throw err;
    // A collaborator error that already carries the gate's own message prefix
    // (an injected runner raising a gate-scoped diagnostic) must pass through
    // unwrapped instead of being re-labelled as an unreadable input.
    if (err instanceof Error && err.message.startsWith("pm github gate:")) throw err;
    throw new GateInputError(
      "pm github gate: could not read the proposed tracker change; input is unavailable.",
    );
  }

  let allowlist = new Map<string, AllowlistEntry>();
  let allowlistPath = "";
  if (input.allowlistFile) {
    allowlistPath = input.allowlistFile;
    allowlist = readGateAllowlist(path.resolve(input.allowlistFile), true, readFileSync);
  } else {
    const toplevel = runGit(pmDataDir, ["rev-parse", "--show-toplevel"]);
    if (toplevel.ok) {
      allowlistPath = path.join(toplevel.stdout.trim(), GATE_ALLOWLIST_FILENAME);
      allowlist = readGateAllowlist(allowlistPath, false, readFileSync);
    }
  }

  // The scan phase below only ever throws GateInputError (malformed history
  // events); every other operation is pure regex/Map/array work that cannot
  // throw, so no defensive wrap is needed and a thrown GateInputError already
  // carries the user-facing message.
  const findings: GateFinding[] = [];
  let allowlisted = 0;
  let addedLines = 0;
  for (const change of files) {
    addedLines += change.addedLines.length;
    for (const raw of scanChangeFile(change)) {
      if (allowlist.has(raw.hash)) {
        allowlisted++;
        continue;
      }
      findings.push({ rule: raw.rule, item_id: raw.item_id, field: raw.field, hash: raw.hash,
        match_offset: raw.match_offset, excerpt: raw.excerpt });
    }
  }
  return {
    verdict: findings.length > 0 ? "fail" : "pass",
    source,
    scanned_files: files.length,
    added_lines: addedLines,
    findings,
    allowlisted,
    allowlist_path: allowlistPath ? (input.allowlistFile ? "(explicit allowlist)" : GATE_ALLOWLIST_FILENAME) : "",
  };
}

/**
 * Render a gate report as human-readable lines.
 *
 * Every line names the rule, item, field, offset, redacted excerpt and short
 * hash prefix. Full matches never appear, so gate output is safe to paste. The
 * same lines feed the command's stderr and the import failure message, so the
 * two surfaces cannot drift apart.
 *
 * @param report - The gate report to render.
 * @returns One summary line, then one line per finding.
 */
export function formatGateReport(report: GateReport): string[] {
  const summary =
    `pm github gate: ${report.verdict.toUpperCase()} — ${report.findings.length} finding(s), ` +
    `${report.allowlisted} allowlisted, ${report.scanned_files} file(s), ${report.added_lines} added line(s)`;
  const lines = [summary];
  for (const finding of report.findings) {
    lines.push(
      `  ${finding.item_id || "(no item)"} · ${finding.field || "(unknown field)"} · ` +
        `${finding.rule} · offset:${finding.match_offset} · ${finding.excerpt} · sha256:${finding.hash.slice(0, 12)}…`,
    );
  }
  return lines;
}
