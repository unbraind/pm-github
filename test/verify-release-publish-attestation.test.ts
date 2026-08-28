/**
 * Executes the publish-attestation verifier's rules against fixtures.
 *
 * The verifier's own repository satisfies its rules, so running it here would
 * only prove that today's tree is fine. What these cases prove is that each
 * rule still FAILS on the defect it exists to catch -- an unattested publish
 * reachable from the release workflow -- and that the two shapes which make a
 * naive substring scan useless are handled: a publish spelled across a line
 * continuation, and a prose mention of the command inside a quoted string.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import {
  ATTESTATION_FLAG,
  attestationEnabled,
  auditPublishAttestation,
  isPublishCommand,
  manifestCommandLines,
  publishInvocationsIn,
  report,
  runIfMain,
  stripQuotedSpans,
  trackedPublishSources,
  verify,
} from "../scripts/verify-release-publish-attestation.ts";

const ATTESTED = `npm publish --access public ${ATTESTATION_FLAG} --ignore-scripts`;
const UNATTESTED = "npm publish --access public --ignore-scripts";

/** Builds a throwaway git repository holding the given tracked files. */
function trackedFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "attestation-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

test("an unattested publish fails, naming the command that would run", () => {
  const result = auditPublishAttestation([{ file: "release.yml", text: `          ${UNATTESTED}` }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /does not enable --provenance/);
  assert.match(result.failures[0]!, /npm publish --access public --ignore-scripts/);
});

test("an attested publish passes and is reported by file", () => {
  const result = auditPublishAttestation([{ file: "release.yml", text: `          ${ATTESTED}` }]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.notes, [`ok - release.yml: 1 publish invocation(s), each carrying ${ATTESTATION_FLAG}`]);
});

test("a file holding both an attested and an unattested publish fails, so one cannot cover for the other", () => {
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          ${ATTESTED}\n          ${UNATTESTED}` },
  ]);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.notes, [], "a file with an unattested publish must not also be reported as ok");
});

test("two publishes chained on one line are judged separately", () => {
  // Judging the line as a whole would let the flag on the first call satisfy
  // the second, which is exactly the shape a line-oriented scan misses.
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          ${ATTESTED} && ${UNATTESTED}` },
  ]);
  assert.equal(result.failures.length, 1);
});

test("every separator and executor the shell honours is judged, not just the spaced forms", () => {
  // Greptile P2: a single `&` (background), a compact pipe `|`, command
  // substitution, and a quoted string handed to `eval` or `bash -c` each form
  // an executable command, so an unattested publish hidden behind one of those
  // shapes would pass both CI and release:check while an attested sibling
  // carries the audit. Judged on the merits, that is precisely the
  // adversarial-edit gap this gate exists to close.
  const forms = [
    ["single ampersand (background)", `          ${ATTESTED} & ${UNATTESTED}`],
    ["compact pipe", `          ${ATTESTED}|${UNATTESTED}`],
    ["compact double pipe", `          ${ATTESTED}||${UNATTESTED}`],
    ["dollar-paren substitution", `          $(${UNATTESTED})`],
    ["backtick substitution", `          \`${UNATTESTED}\``],
    ["eval string", "          eval \"npm publish --access public --ignore-scripts\""],
    ["bash -c string", "          bash -c \"npm publish --access public --ignore-scripts\""],
    ["subshell", `          ( ${UNATTESTED} )`],
  ];
  for (const [name, text] of forms) {
    const result = auditPublishAttestation([{ file: "release.yml", text: text as string }]);
    assert.equal(result.failures.length, 1, name as string);
    assert.match(result.failures[0]!, /does not enable --provenance/, name as string);
  }
  // Executor strings with the flag pass; eval joins all of its arguments, so
  // a quoted flag carried by eval also passes.
  const evalAttested = auditPublishAttestation([
    { file: "release.yml", text: '          bash -c "npm publish --access public --provenance"' },
  ]);
  assert.deepEqual(evalAttested.failures, [], "an attested publish inside bash -c passes");
  // And separator splitting inside quotes is forbidden, so prose with a
  // separator character does not manufacture commands.
  const proseWithSeparator = auditPublishAttestation([
    { file: "release.yml", text: '          echo "note: npm`publish stays prose"' },
  ]);
  assert.equal(proseWithSeparator.failures.length, 1, "no invocation is still the one failure, and prose stays prose");
  assert.match(proseWithSeparator.failures[0]!, /no npm publish invocation was found/);
});

test("a publish spelled across a line continuation is still seen with its flag", () => {
  const result = auditPublishAttestation([
    { file: "release.yml", text: "          npm publish --access public \\\n            --provenance --ignore-scripts" },
  ]);
  assert.deepEqual(result.failures, []);
});

test("a shared bash array holding the flag is expanded rather than read as an absent flag", () => {
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          flags=( --access public ${ATTESTATION_FLAG} )\n          npm publish "\${flags[@]}"` },
  ]);
  assert.deepEqual(result.failures, []);
});

test("a prose mention of the command inside quotes is not treated as an invocation", () => {
  // This repository's own workflow echoes advice naming the command. Reading
  // that echo as a publish makes the gate report a defect that is not there,
  // and a gate that cries wolf gets weakened until it reports nothing.
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          echo "The trusted publisher must have 'npm publish' selected."` },
  ]);
  assert.deepEqual(result.failures, ["no npm publish invocation was found in any tracked file - the scan is looking in the wrong place"]);
});

test("a commented-out publish is not treated as an invocation", () => {
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          # ${UNATTESTED}\n          ${ATTESTED}` },
  ]);
  assert.deepEqual(result.failures, []);
});

test("a trailing unquoted comment cannot supply the flag the command lacks", () => {
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          ${UNATTESTED}  # ${ATTESTATION_FLAG}` },
  ]);
  assert.equal(result.failures.length, 1);
});

test("a disabled attestation is not an attestation, in every spelling npm accepts", () => {
  // Greptile P2: a containment check accepts `--provenance=false`, which is
  // precisely the regression this gate exists to catch, and reports the file
  // as attested while doing it.
  for (const disabled of ["--provenance=false", "--no-provenance", "--provenance --no-provenance", "--provenance=0"]) {
    assert.equal(attestationEnabled(`npm publish --access public ${disabled}`), false, disabled);
    assert.equal(
      auditPublishAttestation([{ file: "release.yml", text: `          npm publish --access public ${disabled}` }]).failures.length,
      1,
      disabled,
    );
  }
  for (const enabled of ["--provenance", "--provenance=true", "--no-provenance --provenance", '"--provenance"', "'--provenance=true'"]) {
    assert.equal(attestationEnabled(`npm publish --access public ${enabled}`), true, enabled);
  }
});

test("a shell-quoted attestation flag still enables the attestation, rather than blocking release:check", () => {
  // CodeRabbit: blanking quoted spans before attestation ran meant a
  // legitimately quoted flag, such as npm publish "--provenance", was
  // reported as unattested and blocked release:check. Detection still blanks
  // quoted spans so prose cannot count as a publish; attestation is judged on
  // the raw segment with per-token quote normalization.
  const quoted = auditPublishAttestation([{ file: "release.yml", text: "          npm publish --access public \"--provenance\"\n" }]);
  assert.deepEqual(quoted.failures, [], "a quoted flag is still the flag");
  const quotedOff = auditPublishAttestation([{ file: "release.yml", text: "          npm publish --access public '--no-provenance'\n" }]);
  assert.equal(quotedOff.failures.length, 1, "quoting a disabling flag does not turn it on");
});

test("a flag that merely starts with the attestation spelling does not enable it", () => {
  assert.equal(attestationEnabled("npm publish --provenance-file x"), false);
});

test("a publish hidden in an npm script is found, because a manifest is JSON and its scripts are quoted", () => {
  // CodeRabbit: quoted spans are erased before a command is judged, which is
  // what stops the workflow's advisory echo reading as an invocation. Applied
  // to a manifest that erases the script bodies themselves, so a publish moved
  // into an npm script would be invisible while being entirely real.
  const manifest = JSON.stringify({ scripts: { release: UNATTESTED, build: "tsc" } });
  const result = auditPublishAttestation([{ file: "package.json", text: manifest }]);
  assert.equal(result.failures.length, 1, "an unattested publish in a script must fail");
  assert.match(result.failures[0]!, /does not enable --provenance/);
  const attested = JSON.stringify({ scripts: { release: ATTESTED } });
  assert.deepEqual(auditPublishAttestation([{ file: "package.json", text: attested }]).failures, []);
});

test("manifestCommandLines survives a manifest that is malformed, empty, or has no scripts", () => {
  // A malformed sibling manifest must not take the gate down; its own tooling
  // reports that far better than a publish audit can.
  assert.equal(manifestCommandLines("{ not json"), "");
  assert.equal(manifestCommandLines("null"), "");
  assert.equal(manifestCommandLines("[]"), "");
  assert.equal(manifestCommandLines("{}"), "");
  assert.equal(manifestCommandLines(JSON.stringify({ scripts: null })), "");
  assert.equal(manifestCommandLines(JSON.stringify({ scripts: "not-an-object" })), "");
  assert.equal(manifestCommandLines(JSON.stringify({ scripts: { a: "x", b: 3, c: "y" } })), "x\ny");
});

test("a publish with configuration flags before the subcommand is still a publish", () => {
  // Greptile: npm accepts its flags anywhere on the line, so requiring `publish`
  // to follow `npm` immediately discards a real unattested publish silently --
  // and an attested sibling elsewhere in the file then carries the audit to a
  // pass.
  const spread = "npm --access public publish --ignore-scripts";
  assert.equal(isPublishCommand(spread), true);
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          ${ATTESTED}\n          ${spread}` },
  ]);
  assert.equal(result.failures.length, 1, "the unattested sibling must be counted and failed");
});

test("npm run publish is a script runner, not a publish", () => {
  // The script's own body is scanned from the manifest, so requiring the flag
  // on the runner would report a defect that is not there.
  assert.equal(isPublishCommand("npm run publish"), false);
  assert.equal(isPublishCommand("npm run-script publish"), false);
  assert.equal(isPublishCommand("npm publish"), true);
  assert.equal(isPublishCommand("npm ci"), false);
  assert.equal(isPublishCommand("bun publish"), false);
});

test("only an invoked npm command is a publish command, so prose cannot block release:check", () => {
  // CodeRabbit: accepting `npm` and `publish` at any token positions means
  // prose such as `echo npm then publish later` reads as an unflagged publish
  // and blocks release:check for a defect that is not there, and a gate that
  // cries wolf gets weakened until it reports nothing.
  assert.equal(isPublishCommand("echo npm then publish later"), false);
  assert.equal(isPublishCommand("printf npm publish"), false);
  // A publish reached through a command runner is still a publish, while
  // runner words, options, and preceding assignments must not decide it.
  assert.equal(isPublishCommand("sudo npm publish"), true);
  assert.equal(isPublishCommand("env CI=true npm publish"), true);
  assert.equal(isPublishCommand("command npm publish"), true);
});

test("finding no publish at all fails, because an empty scan and a clean tree look identical", () => {
  const result = auditPublishAttestation([{ file: "release.yml", text: "          npm ci\n" }]);
  assert.deepEqual(result.failures, ["no npm publish invocation was found in any tracked file - the scan is looking in the wrong place"]);
});

test("a word ending in npm does not start a publish invocation", () => {
  // CodeRabbit: the earlier audit-level assertion passed only because the
  // regression asserted loosely. Assert the word `notnpm` records NO
  // invocation rather than leaving the no-publish failure to stand in for it.
  const notnpm = publishInvocationsIn({ file: "release.yml", text: "          notnpm publish --access public\n" });
  assert.deepEqual(notnpm, [], "npm must be a separate token, not a suffix");
  const bare = publishInvocationsIn({ file: "release.yml", text: "          xnpm publish --access public\n" });
  assert.deepEqual(bare, [], "npm must be a separate token, not a suffix");
});

test("stripQuotedSpans blanks quoted spans and keeps an escaped character outside quotes", () => {
  assert.equal(stripQuotedSpans(`a "b c" d`), "a       d");
  assert.equal(stripQuotedSpans("a 'b' c"), "a     c");
  assert.equal(stripQuotedSpans("a\\ b"), "a\\ b");
  assert.equal(stripQuotedSpans('"a\\"b"'), "      ", "an escape inside quotes stays inside the span");
  assert.equal(stripQuotedSpans("a\\"), "a\\", "a trailing backslash does not read past the end");
});

test("trackedPublishSources asks git, so an untracked workflow copy cannot satisfy the gate", () => {
  const root = trackedFixture({
    ".github/workflows/release.yml": `          ${ATTESTED}`,
    "package.json": "{}",
  });
  try {
    writeFileSync(join(root, ".github/workflows/scratch.yml"), `          ${UNATTESTED}`);
    assert.deepEqual(trackedPublishSources(root).sort(), [".github/workflows/release.yml", "package.json"]);
    assert.deepEqual(verify(root).failures, [], "the untracked scratch copy must not be judged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify reads the tracked files and fails on an unattested one", () => {
  const root = trackedFixture({ ".github/workflows/release.yml": `          ${UNATTESTED}`, "package.json": "{}" });
  try {
    assert.equal(verify(root).failures.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report prints notes then failures and asks for a failing exit code", () => {
  const lines: string[] = [];
  const codes: number[] = [];
  report({ failures: ["bad"], notes: ["fine"] }, (line) => lines.push(line), (code) => codes.push(code));
  assert.deepEqual(lines, ["fine", "FAIL - bad", "verify-release-publish-attestation: 1 failure(s)."]);
  assert.deepEqual(codes, [1]);
});

test("report on a clean result says so and asks for no exit code", () => {
  const lines: string[] = [];
  const codes: number[] = [];
  report({ failures: [], notes: [] }, (line) => lines.push(line), (code) => codes.push(code));
  assert.deepEqual(lines, ["verify-release-publish-attestation: every publish invocation is attested."]);
  assert.deepEqual(codes, []);
});

test("runIfMain runs only as the entry point, and reports when it does", () => {
  const root = trackedFixture({ ".github/workflows/release.yml": `          ${ATTESTED}`, "package.json": "{}" });
  const previous = process.exitCode;
  try {
    assert.equal(runIfMain(["node", "other.ts"], pathToFileURL(resolve("scripts/verify-release-publish-attestation.ts")).href, root), false);
    assert.equal(
      runIfMain(
        ["node", "scripts/verify-release-publish-attestation.ts"],
        pathToFileURL(resolve("scripts/verify-release-publish-attestation.ts")).href,
        root,
      ),
      true,
    );
    assert.equal(process.exitCode, previous, "an attested tree must not set a failing exit code");
    const failing = trackedFixture({ ".github/workflows/release.yml": `          ${UNATTESTED}`, "package.json": "{}" });
    try {
      runIfMain(
        ["node", "scripts/verify-release-publish-attestation.ts"],
        pathToFileURL(resolve("scripts/verify-release-publish-attestation.ts")).href,
        failing,
      );
      assert.equal(process.exitCode, 1, "an unattested tree must set a failing exit code");
    } finally {
      rmSync(failing, { recursive: true, force: true });
    }
  } finally {
    process.exitCode = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a publish run through a package runner is still a publish", () => {
  // `npx npm publish` publishes exactly as `npm publish` does. Tokenising the
  // segment without skipping the runner makes the executable `npx`, so the
  // segment is not recognised as a publish at all - and an unrecognised publish
  // is never checked for the attestation flag. The failure mode is worse than a
  // missed flag: the workflow's ordinary attested publish still satisfies the
  // non-vacuity guard, so the gate reports clean while an unattested publish
  // sits in the same file. Each runner spelling is asserted separately because
  // they are separate entries in the skip list, and a single example would let
  // the others rot back into a bypass.
  for (const runner of ["npx", "bunx", "pnpx", "npx -y", "pnpm dlx", "yarn dlx", "npm exec", "bun x"]) {
    const result = auditPublishAttestation([
      { file: "release.yml", text: `          ${ATTESTED}\n          ${runner} ${UNATTESTED}` },
    ]);
    assert.equal(result.failures.length, 1, `${runner} ${UNATTESTED} must be judged as an unattested publish`);
    assert.match(result.failures[0]!, /does not enable --provenance/);
  }
});

test("a package runner carrying the attestation flag passes", () => {
  // The mirror of the case above: skipping the runner must not also lose the
  // flag that follows it, or every runner-spelled publish would fail closed and
  // the gate would be unusable for a workflow that legitimately uses one.
  const result = auditPublishAttestation([{ file: "release.yml", text: `          npx ${ATTESTED}` }]);
  assert.deepEqual(result.failures, []);
});

test("a two-word runner is consumed only when its second word matches", () => {
  // `npm exec` is a runner; `npm publish` is not. Consuming the pair on the
  // first word alone would skip `publish` and stop recognising the plainest
  // publish there is.
  const result = auditPublishAttestation([{ file: "release.yml", text: `          ${UNATTESTED}` }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /does not enable --provenance/);
});

test("a shell string handed over through a combined short-option cluster is still inspected", () => {
  // POSIX shells accept `bash -ec "..."` and `bash -euc "..."`, which run the
  // string exactly as `bash -c "..."` does. Matching `-c` as a whole token let
  // those spellings hand a string to an interpreter the scan then declined to
  // look inside: the unattested publish in the string was never examined, while
  // the ordinary attested publish still satisfied the non-vacuity guard, so the
  // gate reported clean over an unattested publish.
  for (const handoff of ["bash -ec", "bash -euc", "sh -ec", "bash -eu -c", "bash -c", "sh -xc"]) {
    const result = auditPublishAttestation([
      { file: "release.yml", text: `          ${ATTESTED}\n          ${handoff} "${UNATTESTED}"` },
    ]);
    assert.equal(result.failures.length, 1, `${handoff} must hand its string to the scan`);
    assert.match(result.failures[0]!, /does not enable --provenance/);
  }
});

test("a combined short-option cluster carrying an attested publish still passes", () => {
  const result = auditPublishAttestation([{ file: "release.yml", text: `          bash -ec "${ATTESTED}"` }]);
  assert.deepEqual(result.failures, []);
});

test("a long option is not read as a cluster of short flags", () => {
  // `--command` contains a `c`, but it is not `-c`. Treating a `--`-prefixed
  // token as a short-flag cluster would make any long option hand its quoted
  // arguments to the scan as if they were shell commands.
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          ${ATTESTED}\n          echo --command "${UNATTESTED}"` },
  ]);
  assert.deepEqual(result.failures, [], "prose behind a long option is not an invocation");
});
