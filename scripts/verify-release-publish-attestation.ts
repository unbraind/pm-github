/**
 * Proves this package has no publish path that omits `--provenance`.
 *
 * The release step used to fall back to `npm publish` without the flag after
 * three failed provenance attempts, reporting success and leaving only a
 * warning annotation. That makes a transient registry failure downgrade the
 * published artifact's supply-chain attestation permanently for that version,
 * and consumers cannot tell such a publish apart from one that never had
 * provenance at all. An unattested publish is not a degraded success; it is a
 * different artifact.
 *
 * A workflow edit is easy to make and easy to lose, so the contract is executed
 * rather than assumed: every `npm publish` this repository can run is found and
 * required to carry the flag. The analysis is separated from the I/O so the
 * rules are driven by the suite against fixtures rather than only against this
 * repository, which happens to satisfy them.
 *
 * @packageDocumentation
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** A tracked file's path and contents. */
interface SourceFile {
  /** Repository-relative path. */
  file: string;
  /** File contents. */
  text: string;
}

/** The outcome of one verifier run. */
interface VerifierResult {
  /** Reasons the run failed; empty means it passed. */
  failures: string[];
  /** Lines describing what was checked, for the operator. */
  notes: string[];
}

/**
 * Collapse shell and YAML line continuations so one logical command is one string.
 *
 * A backslash at end of line joins the next line; without this every multi-line
 * invocation looks like a set of fragments, none of which carries both the
 * version input and the date flag.
 *
 * @param text - Raw file contents.
 * @returns The same text with continuations joined.
 */
function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n\s*/g, " ");
}

/**
 * Index bash array assignments so a shared options array can be expanded.
 *
 * The release workflows declare `common=( ... )` once and pass `"${common[@]}"`
 * to each invocation, precisely so the invocations cannot drift. A scan that
 * reads only the invocation line therefore sees none of the shared flags.
 *
 * @param text - File contents with continuations already joined.
 * @returns Array name mapped to the flag text it holds.
 */
function bashArrays(text: string): Map<string, string> {
  const arrays = new Map<string, string>();
  for (const match of text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=\(([\s\S]*?)\)/g)) {
    arrays.set(match[1], match[2].replace(/\s+/g, " ").trim());
  }
  return arrays;
}

/**
 * Expand `"${name[@]}"` references against the file's array declarations.
 *
 * An unknown name is left untouched rather than erased: silently dropping it
 * would turn "this scan does not understand the command" into "this command has
 * no flags", which reads as a pass.
 *
 * @param line - One logical command.
 * @param arrays - Array declarations from the same file.
 * @returns The command with referenced array contents inlined.
 */
function expandArrays(line: string, arrays: Map<string, string>): string {
  return line.replace(/"?\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"?/g, (whole, name: string) =>
    arrays.get(name) ?? whole);
}

/**
 * Drop an unquoted trailing comment from one command.
 *
 * A `#` inside quotes is an argument -- these invocations pass URLs containing
 * one -- while an unquoted `#` starts a comment the shell never runs. Without
 * this, a comment is part of the command as far as a substring check is
 * concerned, and `... --release-version-from-package  # --date-from-version`
 * satisfies the very check it is complaining about.
 *
 * @param command - One logical command.
 * @returns The command with any unquoted trailing comment removed.
 */
function stripComment(command: string): string {
  let single = false;
  let double = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\") { index += 1; continue; }
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    else if (character === "#" && !single && !double && (index === 0 || /\s/.test(command[index - 1]))) {
      return command.slice(0, index);
    }
  }
  return command;
}

/**
 * Whether this module is the process entry point.
 *
 * Kept as a named function rather than an inline comparison so the suite can
 * execute both answers; a guard nothing exercises is how an entry point stops
 * running and nobody notices.
 *
 * @param argv - The process argv to judge.
 * @param moduleUrl - The module's own `import.meta.url`.
 * @returns True when argv names this module as the script being run.
 */
function isMainInvocation(argv: string[], moduleUrl: string): boolean {
  const script = argv[1];
  return script !== undefined && moduleUrl === pathToFileURL(resolve(script)).href;
}

/** The flag that attaches a build attestation to the published tarball. */
export const ATTESTATION_FLAG = "--provenance";

/** One publish invocation found in a tracked file. */
export interface PublishInvocation {
  /** File the invocation was found in. */
  file: string;
  /** The logical command, with continuations joined and arrays expanded. */
  command: string;
}

/**
 * Split one logical command into the shell segments it would execute.
 *
 * A line can hold several commands, and judging the line as a whole lets a
 * flagged publish cover for an unflagged one beside it. The separator set has
 * to match what the shell treats as a command boundary, or an adversarial
 * edit places the unattested publish behind a separator the scan does not know:
 * `;`, `&`, and `|` (background and compact pipes included, not just the
 * spaced `&&` / `||` forms), plus unquoted parentheses and command substitution
 * markers, so a publish hiding inside `$( ... )` or a subshell is reached.
 *
 * Separators inside single or double quotes are left alone; a backtick or a
 * `$(` outside quotes opens a new segment rather than being blanked, because in
 * shell those quotes constrain argument words but substitution still executes.
 *
 * @param command - One logical command.
 * @returns The executable segments of the command, in order.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  const push = () => {
    if (current.trim().length > 0) segments.push(current);
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\\") {
      current += character;
      index += 1;
      if (index < command.length) current += command[index]!;
      continue;
    }
    if (!single && !double) {
      if (character === "&" || character === "|" || character === ";" || character === "(" || character === ")") {
        if ((character === "&" || character === "|") && command[index + 1] === character) index += 1;
        push();
        continue;
      }
      if (character === "`") {
        push();
        continue;
      }
      if (character === "$" && command[index + 1] === "(") {
        index += 1;
        push();
        continue;
      }
    }
    if (character === "'" && !double) {
      single = !single;
      current += character;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      current += character;
      continue;
    }
    current += character;
  }
  push();
  return segments;
}

/**
 * Find the index of the token the shell would actually execute.
 *
 * The first word of a segment is not automatically the executable: command
 * runners such as `sudo`, `env`, `xargs`, `command`, and `exec` take the
 * command to run as an argument, and assignments like `FOO=bar` precede the
 * command in shell. Skipping a fixed list of runner words, simple options, and
 * word=word assignments finds the executable for those forms, while prose such
 * as `echo npm publish` is correctly not judged as an invocation.
 *
 * Package runners are in that list for a reason worth stating. `npx npm publish`
 * publishes exactly as `npm publish` does, but tokenising without skipping the
 * runner makes the executable `npx`, so the segment is not recognised as a
 * publish at all. That is worse than a missed flag: an unrecognised publish is
 * never checked for `--provenance`, and the non-vacuity guard still passes
 * because the workflow's ordinary attested publish is found elsewhere. The
 * result is an unattested publish that the gate reports as clean. `pnpm dlx`,
 * `yarn dlx`, `npm exec` and `bun x` spell the same thing in two tokens, so the
 * second word is consumed too.
 *
 * @param tokens - Whitespace-split tokens of one segment.
 * @returns The index of the executable token.
 */
function executableIndex(tokens: string[]): number {
  const runners = new Set([
    "env", "sudo", "doas", "time", "nice", "nohup", "xargs", "command", "exec",
    // Package runners: each executes the following words as a command.
    "npx", "bunx", "pnpx",
  ]);
  // Two-token package runners, keyed by the first word. The pair is consumed
  // only when the second word actually matches, so a plain `npm publish` is
  // never mistaken for `npm exec`.
  const pairedRunners = new Map([["pnpm", "dlx"], ["yarn", "dlx"], ["npm", "exec"], ["bun", "x"]]);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (runners.has(token) || token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (pairedRunners.get(token) === tokens[index + 1]) {
      index += 2;
      continue;
    }
    break;
  }
  return index;
}

/**
 * Strip surrounding quotes from one token, if both are there.
 *
 * npm receives the flag whether or not the shell quoted it, so `"--provenance"`
 * enables the attestation exactly as much as `--provenance` does. Normalizing
 * per token instead of blanking quoted spans means a legitimately quoted flag
 * is judged on what it carries, while prose detection upstream still treats
 * quoted mentions as non-commands before this is ever asked.
 *
 * @param token - One shell token.
 * @returns The token without a surrounding pair of matching quotes.
 */
function unquoteToken(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    if ((first === '"' || first === "'") && token[token.length - 1] === first) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * Extract the raw content of each quoted span in one segment.
 *
 * Used only once a segment is known to hand a string to a shell interpreter;
 * the content is what gets executed, so it becomes a segment of its own.
 *
 * @param segment - The segment to mine.
 * @returns The raw contents of every quoted span.
 */
function quotedSpanContents(segment: string): string[] {
  const spans: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (character === "\\") {
      if (quote !== undefined) current += character;
      index += 1;
      if (quote !== undefined && index < segment.length) current += segment[index]!;
      continue;
    }
    if (quote === undefined && (character === "'" || character === '"')) {
      quote = character;
      continue;
    }
    if (quote !== undefined && character === quote) {
      quote = undefined;
      spans.push(current);
      current = "";
      continue;
    }
    if (quote !== undefined) current += character;
  }
  return spans;
}

/**
 * Remove the first N whitespace-delimited tokens from a raw segment.
 *
 * Plain `split(/\s+/)` breaks a quoted span into fragments that no longer
 * match the flag, because `eval` and `bash -c` hand off a string whose
 * boundaries matter. Skipping tokens quote-aware keeps the remainder of the
 * command -- the string an executor would run -- intact for judgement.
 *
 * @param text - One raw segment.
 * @param count - How many tokens to drop.
 * @returns The segment without its leading tokens, quotes preserved.
 */
function dropLeadingTokens(text: string, count: number): string {
  let single = false;
  let double = false;
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\\") { index += 1; continue; }
    if (character === "'" && !double) { single = !single; continue; }
    if (character === '"' && !single) { double = !double; continue; }
    if (!single && !double && /\s/.test(character) && index > 0 && !/\s/.test(text[index - 1]!)) {
      seen += 1;
      if (seen === count) return text.slice(index);
    }
  }
  return "";
}

/**
 * Replace every quote character with a space, keeping the content.
 *
 * Only used on text an executor would run: blanking the span (as prose
 * detection does) would hide the command, but stripping the quote characters
 * preserves word boundaries while turning `eval "npm publish"` back into the
 * tokens the shell concatenates and executes.
 *
 * @param text - The segment handed to an executor.
 * @returns The text without quote characters.
 */
function unquoteText(text: string): string {
  return text.replace(/["']/g, " ");
}

/**
 * Extend a segment list with the commands a shell-string executor would run.
 *
 * `eval`, and `bash`/`sh`/`zsh`/`dash` with `-c`, execute a string passed to
 * them. An unattested publish inside such a string is invisible to a scan that
 * blanks quoted spans, while marking the string as a publish upstream would
 * turn prose mentions into failures; extracting the string's own content, only
 * when the segment actually hands a string to an interpreter, keeps both sides
 * of that trade sound. `eval` joins all of its arguments with spaces, so its
 * remainder is evaluated as one segment rather than span by span. The hand-off
 * is resolved with bounded depth, because a string may itself invoke an
 * executor and the scan must still terminate.
 *
 * @param segments - The pending segment list.
 * @param depth - How many executor hand-offs may still be resolved.
 * @returns The segments plus any executor-resolved ones.
 */
function resolveExecutorStrings(segments: string[], depth: number): string[] {
  const out = [...segments];
  const queue = segments.map((text) => ({ text, depth }));
  while (queue.length > 0) {
    const { text, depth: remaining } = queue.shift()!;
    if (remaining <= 0) continue;
    const tokens = text.trim().split(/\s+/);
    const executableAt = executableIndex(tokens);
    const executable = unquoteToken(tokens[executableAt] ?? "");
    if (executable === "eval") {
      const rest = unquoteText(dropLeadingTokens(text, executableAt + 1));
      if (rest.trim().length > 0) {
        out.push(rest);
        queue.push({ text: rest, depth: remaining - 1 });
      }
      continue;
    }
    if (/^(bash|sh|zsh|dash)$/.test(executable) && tokens.slice(executableAt + 1).some((token) => unquoteToken(token) === "-c")) {
      for (const span of quotedSpanContents(text)) {
        if (span.trim().length > 0) {
          out.push(span);
          queue.push({ text: span, depth: remaining - 1 });
        }
      }
    }
  }
  return out;
}

/**
 * Remove the contents of every quoted span from one command.
 *
 * Release workflows print advice that names the command they are about to run.
 * This repository's own workflow echoes a sentence containing the words `npm
 * publish` in quotes. A substring scan reads that echo as a publish invocation
 * and fails it for lacking a flag no echo could carry, so the gate reports a
 * defect that is not there and gets weakened until it reports nothing. What
 * distinguishes a command from a mention is that the mention sits inside
 * quotes, so quoted spans are removed before the command is judged. Commands an
 * explicit executor (`eval`, `bash -c`) would run are extracted before this
 * stripping happens, so only prose stays hidden.
 *
 * Whitespace replaces each span rather than nothing, so tokens on either side
 * do not fuse into a word that was never written.
 *
 * @param command - One logical command.
 * @returns The command with quoted spans blanked out.
 */
export function stripQuotedSpans(command: string): string {
  let result = "";
  let quote: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\\") {
      result += quote === undefined ? character : " ";
      index += 1;
      if (index < command.length) result += quote === undefined ? command[index]! : " ";
      continue;
    }
    if (quote === undefined && (character === "'" || character === '"')) {
      quote = character;
      result += " ";
      continue;
    }
    if (quote !== undefined && character === quote) {
      quote = undefined;
      result += " ";
      continue;
    }
    result += quote === undefined ? character : " ";
  }
  return result;
}

/**
 * Expand a package manifest into the command lines its scripts would run.
 *
 * A manifest is JSON, so every script body is a *quoted* value -- and quoted
 * spans are erased before a command is judged, because that is what stops the
 * workflow's own advisory `echo` reading as an invocation. Passing the raw
 * manifest through that step therefore erases the very commands it contains: a
 * publish moved into an npm script would be invisible to this gate while being
 * entirely real. Yielding the script bodies as bare lines restores them to the
 * shape the scanner expects.
 *
 * A manifest that will not parse yields nothing rather than throwing, so a
 * malformed sibling file cannot take the gate down; the manifest's own tooling
 * reports that far better than a publish audit can.
 *
 * @param text - The manifest's contents.
 * @returns One line per script body, newline joined.
 */
export function manifestCommandLines(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) return "";
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return "";
  return Object.values(scripts as Record<string, unknown>)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

/**
 * Decide whether one command runs `npm publish`.
 *
 * `publish` does not have to follow `npm` immediately. npm accepts its
 * configuration flags anywhere on the line, so `npm --access public publish
 * --ignore-scripts` is a real, unattested publish that a scan requiring the two
 * words to be adjacent discards before ever looking at its flags -- and it
 * discards it silently, leaving a conventional attested sibling elsewhere in
 * the file to carry the audit to a pass.
 *
 * `npm` must be the token the shell would execute, though. Accepting the pair
 * at any positions means prose such as `echo npm then publish later` reads as
 * an unflagged publish and blocks the release for a defect that is not there,
 * and a gate that cries wolf gets weakened until it reports nothing. Runner
 * words such as `sudo` or `env`, options, and preceding assignments are
 * skipped, because a publish reached through a runner is still a publish.
 *
 * `npm run publish` is excluded: that runs a package script, and the script's
 * own body is scanned separately from the manifest. Requiring `--provenance` on
 * the runner rather than on the publish would report a defect that is not there.
 *
 * @param command - One logical command with quoted spans already blanked.
 * @returns True when the command is an `npm publish` invocation.
 */
export function isPublishCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === undefined) return false;
  const npmAt = executableIndex(tokens);
  if (tokens[npmAt] !== "npm") return false;
  const publishAt = tokens.indexOf("publish", npmAt + 1);
  if (publishAt === -1) return false;
  const preceding = tokens[publishAt - 1];
  return preceding !== "run" && preceding !== "run-script";
}

/**
 * Decide whether one publish command actually enables the attestation.
 *
 * A substring test is not enough. `--provenance=false` and `--no-provenance`
 * both contain the flag's spelling and both turn the attestation off, so a
 * containment check accepts precisely the regression this gate exists to catch
 * -- and it would do so while reporting the file as attested.
 *
 * Tokens are judged in order and the last one wins, which is how npm resolves a
 * flag given more than once: `--provenance --no-provenance` publishes without an
 * attestation, so this must answer false for it. Shell quoting is normalized
 * per token first, because `"--provenance"` enables the attestation exactly the
 * same as `--provenance`.
 *
 * @param command - One logical publish command.
 * @returns True when the command publishes with an attestation.
 */
export function attestationEnabled(command: string): boolean {
  let enabled = false;
  for (const rawToken of command.trim().split(/\s+/)) {
    const token = unquoteToken(rawToken);
    if (token === `--no-${ATTESTATION_FLAG.slice(2)}`) enabled = false;
    else if (token === ATTESTATION_FLAG) enabled = true;
    else if (token.startsWith(`${ATTESTATION_FLAG}=`)) {
      enabled = token.slice(ATTESTATION_FLAG.length + 1) === "true";
    }
  }
  return enabled;
}

/**
 * Find every publish invocation in one file's contents.
 *
 * Continuations are joined and shared arrays expanded first, for the same
 * reason the changelog-date scan does it: a multi-line invocation otherwise
 * looks like fragments, none of which carries the flag. Each logical command is
 * then split on every shell separator, because one line can hold several
 * commands and judging the line as a whole lets a flagged publish cover for an
 * unflagged one beside it. Commands that hand a string to an executor
 * (`eval`, `bash -c`) have the string's content resolved so a publish cannot
 * hide inside it.
 *
 * Detection and attestation deliberately work from different text: detection
 * blanks quoted spans so prose mentions of `npm publish` are not commands at
 * all, while attestation is read from the raw, comment-stripped segment, so a
 * legitimately shell-quoted flag -- `npm publish "--provenance"` -- is judged
 * on what it carries rather than reported as unattested.
 *
 * @param source - The file's path and contents.
 * @returns The publish invocations found, in file order.
 */
export function publishInvocationsIn(source: SourceFile): PublishInvocation[] {
  const raw = source.file.endsWith("package.json") ? manifestCommandLines(source.text) : source.text;
  const text = joinContinuations(raw);
  const arrays = bashArrays(text);
  const found: PublishInvocation[] = [];
  for (const rawLine of text.split("\n")) {
    if (/^\s*#/.test(rawLine)) continue;
    // A line-level prefilter has to be at least as permissive as the judgement
    // below, or it discards the very commands that judgement exists to catch.
    if (!/\bnpm\b/.test(rawLine) || !/\bpublish\b/.test(rawLine)) continue;
    const expanded = expandArrays(rawLine, arrays);
    const segments = resolveExecutorStrings(splitSegments(expanded), 2);
    for (const rawSegment of segments) {
      const segment = stripComment(rawSegment);
      if (!isPublishCommand(stripQuotedSpans(segment))) continue;
      found.push({ file: source.file, command: segment });
    }
  }
  return found;
}

/**
 * Audit every publish invocation across the given files.
 *
 * An absent invocation is a failure rather than a pass: a scan that finds
 * nothing has either been pointed at the wrong files or outlived the workflow
 * it guards, and both look identical to a clean result unless said out loud.
 *
 * @param sources - The tracked files to scan.
 * @returns Failures and per-file notes.
 */
export function auditPublishAttestation(sources: SourceFile[]): VerifierResult {
  const invocations = sources.flatMap(publishInvocationsIn);
  const failures: string[] = [];
  const counted = new Map<string, { total: number; unflagged: number }>();
  for (const invocation of invocations) {
    const tally = counted.get(invocation.file) ?? { total: 0, unflagged: 0 };
    tally.total += 1;
    if (!attestationEnabled(invocation.command)) {
      tally.unflagged += 1;
      failures.push(
        `${invocation.file}: a publish invocation does not enable ${ATTESTATION_FLAG}, so it would`
        + ` publish an unattested artifact: ${invocation.command.trim().slice(0, 160)}`,
      );
    }
    counted.set(invocation.file, tally);
  }
  if (invocations.length === 0) {
    failures.push("no npm publish invocation was found in any tracked file - the scan is looking in the wrong place");
  }
  const notes: string[] = [];
  for (const [file, tally] of counted) {
    if (tally.unflagged > 0) continue;
    notes.push(`ok - ${file}: ${tally.total} publish invocation(s), each carrying ${ATTESTATION_FLAG}`);
  }
  return { failures, notes };
}

/**
 * List the tracked files that can run a publish.
 *
 * Git is asked rather than the filesystem walked, so an untracked scratch copy
 * of a workflow cannot satisfy or fail the gate.
 *
 * @param root - Repository root.
 * @returns Repository-relative paths of workflow and manifest files.
 */
export function trackedPublishSources(root: string): string[] {
  const listed = execFileSync("git", ["ls-files", ".github/workflows", "package.json"], {
    cwd: root,
    encoding: "utf8",
  });
  return listed.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Read the tracked sources and audit them.
 *
 * @param root - Repository root to verify.
 * @returns Failures and notes for the whole repository.
 */
export function verify(root: string): VerifierResult {
  const sources: SourceFile[] = trackedPublishSources(root).map((file) => ({
    file,
    text: readFileSync(resolve(root, file), "utf8"),
  }));
  return auditPublishAttestation(sources);
}

/**
 * Print a result and set a failing exit code when it failed.
 *
 * @param result - The audit outcome.
 * @param write - Sink for the report lines.
 * @param exit - Called with the process exit code when there were failures.
 */
export function report(
  result: VerifierResult,
  write: (line: string) => void,
  exit: (code: number) => void,
): void {
  for (const note of result.notes) write(note);
  for (const failure of result.failures) write(`FAIL - ${failure}`);
  if (result.failures.length > 0) {
    write(`verify-release-publish-attestation: ${result.failures.length} failure(s).`);
    exit(1);
    return;
  }
  write("verify-release-publish-attestation: every publish invocation is attested.");
}

/**
 * Verify and report, but only when this module is the process entry point.
 *
 * The guard is a function rather than a bare `if` at module scope so the suite
 * can execute both answers. A bare `if` leaves its own body unreachable from any
 * in-process test, which is how an entry point quietly stops running.
 *
 * @param argv - The process argv to judge.
 * @param moduleUrl - This module's `import.meta.url`.
 * @param root - Repository root to verify.
 * @returns True when the verifier ran.
 */
export function runIfMain(argv: string[], moduleUrl: string, root: string): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  report(verify(root), (line) => process.stdout.write(`${line}\n`), (code) => { process.exitCode = code; });
  return true;
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));
