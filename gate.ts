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
//   * findings name the rule, the item id, the item field, and a content hash —
//     never the matched text — so gate logs cannot become the leak they exist
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
 * key (hash) — nothing more.
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
  { rule: "openai-api-key", pattern: /sk-[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/g },
  { rule: "openai-project-key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { rule: "openai-service-account-key", pattern: /sk-svcacct-[A-Za-z0-9_-]{20,}/g },
  { rule: "anthropic-api-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    rule: "bearer-token",
    pattern: /(?:authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{20,})/gi,

  },
  { rule: "private-key-block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
];

/**
 * Personal-data signatures: an email that is not a no-reply address, and phone
 * numbers in their two common written shapes.
 */
const PERSONAL_DATA_RULES: readonly ContentRule[] = [
  {
    rule: "email-address",
    // An SCP-style SSH clone URL (`git@github.com:owner/repo.git`, the colon
    // followed directly by a path) names the git service account, not a
    // person, so the pattern skips exactly that shape; a bare `git@host`
    // contact address, even before a colon and a space, is still matched.
    // The lookbehind keeps a match from starting inside a local part.
    pattern: /(?<![A-Za-z0-9._%+-])(?!git@[A-Za-z0-9.-]+\.[A-Za-z]{2,}:[A-Za-z0-9_~./-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    // GitHub, GitLab and most mail systems use a "noreply" domain or local part
    // for automated identities; anything else in imported issue text is a real
    // person's address and fails closed.
    confirm: (matched) => {
      const [local, domain] = matched.toLowerCase().split("@");
      return !/^(?:no-?reply)$/.test(local!) && !/(?:^|\.)no-?reply(?:\.|$)/.test(domain!);
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
    pattern: /\b(?:phone|telephone|tel|mobile)\b["']?\s*[:=]\s*["']?\s*\+?\d[\d \t().-]{5,}\d/gi,
    // Contact labels distinguish unformatted numbers from issue/comment ids.
    confirm: (matched) => { const digits = matched.replace(/\D/g, "").length; return digits >= 7 && digits <= 15; },
  },
];

/**
 * Host-identifying path signatures: absolute personal/system filesystem paths
 * and home-directory usernames (`~user`, but never the anonymous `~/`), which
 * would publish the machine and account that produced an import. The list is
 * the POSIX/Windows set a developer workstation actually leaks, mirroring the
 * repository's own object-store privacy gate.
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
    pattern: /(?<=^|[\s"'`([=,{]|[A-Za-z0-9_]{2}:|file:\/\/)\/(?:home|Users|root|tmp|var|etc|opt|srv|mnt|media|private|Volumes|usr|run|proc|data|nix|scratch|workspace|builds|Library|System)(?=\/|$|[\s"'`<>),;\]}])(?:\/[^\s"'`<>),;\]}]*)?/g,
  },
  {
    rule: "windows-host-path",
    // A drive letter at a token start, or as a `file:///C:/…` URL path.
    pattern: /(?:(?<![A-Za-z0-9_:/])|(?<=file:\/\/\/))[A-Za-z]:[\\/][^\s"'`<>),;\]}]+/g,
  },
  {
    rule: "home-username",
    // A leading tilde followed by a name AND a path separator is a username
    // leak (`~alice/report.txt`); `~/` (anonymous), `~~strikethrough~~`, and
    // prose approximations (`~most users`) are excluded by the boundary and
    // the required trailing slash.
    pattern: /(?:^|[\s"'`([=,])~[A-Za-z][A-Za-z0-9._-]*\/[^\s"'`<>),;\]}]*/g,
  },
];

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
  /(?:^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9_-]{0,48})(?:\\?["'`])?\s*[:=]\s*(?:\\?["'`])?([A-Za-z0-9+/_=-]{20,256})(?:\\?["'`])?/g;

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

/**
 * Scan one added line with every content rule.
 *
 * Rules are evaluated independently: one line can produce several hits (a
 * bearer header wrapping a GitHub token reports both shapes), because each is a
 * distinct reviewed rule. The high-entropy assignment rule is regex-scan +
 * predicate, so it is driven here rather than in the static table.
 *
 * @param line - The added line text (diff `+` already stripped).
 * @returns Every rule hit on the line, in evaluation order.
 */
export function scanLineForRuleHits(line: string): RuleHit[] {
  // Serialized tracker text may escape separators or provider prefixes. Map
  // decoded characters back to their original offsets for history attribution.
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
    } else if (line[index] === "\\" && /[\\/nrt]/.test(line[index + 1] ?? "")) {
      decoded += ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[line[index + 1]!] ?? line[index + 1]!;
      offsets.push(index);
      index++;
    } else {
      decoded += line[index]!;
      offsets.push(index);
    }
  }
  const hits: RuleHit[] = [];
  for (const rule of [...CREDENTIAL_RULES, ...PERSONAL_DATA_RULES, ...HOST_PATH_RULES]) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(decoded); match; match = rule.pattern.exec(decoded)) {
      if (!rule.confirm || rule.confirm(match[0])) {
        const matched = rule.rule === "home-username" ? match[0].slice(match[0].indexOf("~")) : match[0];
        hits.push({ rule: rule.rule, matched, index: offsets[match.index]! });
      }
    }
  }
  HIGH_ENTROPY_ASSIGNMENT.lastIndex = 0;
  for (let match = HIGH_ENTROPY_ASSIGNMENT.exec(decoded); match; match = HIGH_ENTROPY_ASSIGNMENT.exec(decoded)) {
    const [identifier, value] = [match[1]!, match[2]!];
    if (isHighEntropySecretAssignment(identifier, value)) {
      hits.push({ rule: "high-entropy-assignment", matched: value, index: offsets[match.index]! });
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
          `pm github gate: untracked tracker file is too large to scan ; refusing to guess.`,
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
    throw new GateInputError(`pm github gate: allowlist file is not valid JSON: (allowlist)`);
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
              if (typeof record[key] === "string") values.push({ text: record[key], field: key });
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
      for (const hit of scanLineForRuleHits(value.text)) {
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
    if (input.diffFile) {
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
      `pm github gate: could not read the proposed tracker change; input is unavailable.`,
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
      findings.push({ rule: raw.rule, item_id: raw.item_id, field: raw.field, hash: raw.hash });
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
 * Every line names only the rule, item, field, and short hash prefix — the
 * matched content never appears, so gate output is safe to paste anywhere. The
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
        `${finding.rule} · sha256:${finding.hash.slice(0, 12)}…`,
    );
  }
  return lines;
}
