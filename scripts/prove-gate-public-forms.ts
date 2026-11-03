#!/usr/bin/env node
/**
 * Behavioral revert-and-broadening proof for the public technical-forms
 * privacy-gate allowances (gh:unbraind/pm-github#193).
 *
 * The gate's must-allow/must-refuse corpus (test/gate-public-forms-corpus.ts)
 * pins every permitted form and every refusal. This script proves the corpus
 * has teeth: each single allowance, removed from a disposable mutated copy of
 * gate.ts, must flip EXACTLY that allowance's must-allow rows to failing, and
 * each broadened allowance (dropped domain anchors, dropped runner shape,
 * dropped traversal/encoding/embedding checks, dropped bracket lead-ins, a
 * reverted delimiter set, a reverted embedded-identity list, a removed procfs
 * root exception or runner tmp exemption) must flip exactly the must-refuse
 * rows it would have admitted. A mutation whose flipped rows differ from the
 * recorded expectation fails the proof, as does a mutation whose source
 * anchor no longer exists, so the table cannot silently drift away from the
 * scanner it claims to measure.
 *
 * Mutated copies run outside the repository in an operating-system temporary
 * directory and are deleted afterwards; no repository file is modified. The
 * real scanner is imported directly, so coverage receipts measure the shipped
 * source, not the disposable mutations.
 *
 * @example
 * ```bash
 * node scripts/prove-gate-public-forms.ts
 * ```
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { isMainInvocation } from "./main-invocation.ts";
import { PUBLIC_FORMS_MUST_ALLOW, PUBLIC_FORMS_MUST_REFUSE } from "../test/gate-public-forms-corpus.ts";
import { scanLineForRuleHits } from "../gate.ts";

/** The scanner module a mutated gate copy must expose. */
type ScannerModule = { readonly scanLineForRuleHits: typeof scanLineForRuleHits };

/** One exact-text replacement applied to the gate source before importing it. */
export interface MutationReplacement {
  /** Unique source anchor; must occur exactly once in gate.ts. */
  readonly find: string;
  /** Text replacing the anchor, producing the mutated behavior. */
  readonly replace: string;
}

/** One mutation experiment: the change, and the corpus rows it must flip. */
export interface MutationSpec {
  /** Stable mutation name printed in the proof table. */
  readonly name: string;
  /** One-line human explanation of what the mutation removes or broadens. */
  readonly description: string;
  /** Exact-text replacements applied to the gate source. */
  readonly replacements: readonly MutationReplacement[];
  /** Must-allow row ids that must START firing under the mutation. */
  readonly expectFailingAllowRows: readonly string[];
  /** Must-refuse row ids that must STOP firing under the mutation. */
  readonly expectPassingRefuseRows: readonly string[];
}

/** One executed mutation and what it actually flipped. */
export interface MutationOutcome {
  /** The mutation's name. */
  readonly name: string;
  /** Whether the mutation flipped exactly the recorded expectation. */
  readonly ok: boolean;
  /** Must-allow row ids that started firing under the mutation. */
  readonly flippedAllowRows: readonly string[];
  /** Must-refuse row ids that stopped firing under the mutation. */
  readonly flippedRefuseRows: readonly string[];
  /** Failure explanation when the mutation could not run or drifted. */
  readonly error: string;
}

/** Outcome of one proof run, held as plain strings so a test can inspect it. */
export interface MutationProofResult {
  /** Process exit code the run would produce (0 on success; 1 on failure). */
  readonly exitCode: number;
  /** Content the run would write to stdout, without a trailing newline. */
  readonly stdout: string;
  /** Content the run would write to stderr, without a trailing newline. */
  readonly stderr: string;
}

/** Injectable seams so the failure paths stay testable without editing source. */
export interface ProofOptions {
  /** Gate source path to mutate; defaults to the shipped gate.ts. */
  readonly gateSourcePath?: string;
  /** Mutation table to execute; defaults to the recorded table. */
  readonly mutations?: readonly MutationSpec[];
  /** Module importer for mutated copies; injectable for failure injection. */
  readonly importModule?: (url: string) => Promise<ScannerModule>;
  /** Scratch directory for mutated copies; defaults to the OS temp dir. */
  readonly scratchDirectory?: string;
  /** Baseline scanner; injectable to prove preflight failures fail closed. */
  readonly baselineScanner?: typeof scanLineForRuleHits;
}

/**
 * The recorded mutation table. Removals prove each allowance independently
 * fails its own must-allow rows; broadenings prove the anchors (domain match,
 * runner shape, traversal/encoding/embedding checks, bracket lead-ins) keep
 * exactly the recorded refusals.
 */
export const PUBLIC_FORM_MUTATIONS: readonly MutationSpec[] = [
  {
    name: "remove-sysfs-allowance",
    description: "sysfs interfaces must fail again",
    replacements: [{ find: 'if (root === "sys") return !embedsIdentityRoot(segments.slice(1));', replace: 'if (root === "sys") return false;' }],
    expectFailingAllowRows: ["sys-bare", "sys-tree"],
    expectPassingRefuseRows: [],
  },
  {
    name: "remove-procfs-allowance",
    description: "procfs interface paths must fail again",
    replacements: [{ find: "if (root === \"proc\") {", replace: "if (root === \"proc\") return false; if (root === \"proc\") {" }],
    expectFailingAllowRows: ["pm-review-title", "pm-review-body-proc-pid", "pm-review-body-proc-bare", "proc-bare", "proc-self", "proc-self-root-only", "proc-digits", "proc-placeholder", "placeholder-home-then-proc", "proc-self-root-entry", "proc-digits-root-entry", "placeholder-home-then-file-url", "proc-colon-chain-at-cap"],
    expectPassingRefuseRows: [],
  },
  {
    name: "remove-reserved-domain-allowance",
    description: "RFC 2606/6761 fixture addresses must fail again",
    replacements: [{ find: "return !isReservedDocumentationDomain(domain!);", replace: "return true;" }],
    expectFailingAllowRows: ["pm-context-fixture", "reserved-example-com", "reserved-example-net", "reserved-example-org", "reserved-sub-example", "reserved-sub-invalid", "reserved-sub-test", "reserved-sub-localhost", "reserved-uppercase", "reserved-ssh-other-local", "reserved-bare-localhost", "reserved-bare-uppercase"],
    expectPassingRefuseRows: [],
  },
  {
    name: "remove-git-transport-allowance",
    description: "the git service identity in SSH transport URLs must fail again",
    replacements: [{
      find: "(?!(?<=ssh:\\/\\/)git@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}(?=\\/|:\\d+\\/))(?!git@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}:[A-Za-z0-9_~./-])",
      replace: "",
    }],
    expectFailingAllowRows: ["pm-jev-ssh-url", "git-transport-ssh-owner", "git-transport-scp", "git-transport-port"],
    expectPassingRefuseRows: [],
  },
  {
    name: "remove-runner-workspace-posix",
    description: "hosted-runner workspaces under either home root must fail again",
    replacements: [{ find: "return first === \"runner\" && segments[2] === \"work\"", replace: "return false && first === \"runner\" && segments[2] === \"work\"" }],
    expectFailingAllowRows: ["runner-posix", "runner-scoped-package", "runner-macos", "runner-workspace-tmp"],
    expectPassingRefuseRows: [],
  },
  {
    name: "remove-runner-workspace-windows",
    description: "the hosted-runner drive workspaces must fail again",
    replacements: [{ find: "return drive.toLowerCase() === \"d:\" && root === \"a\" &&", replace: "return false && drive.toLowerCase() === \"d:\" && root === \"a\" &&" }],
    expectFailingAllowRows: ["pm-rust-runner-fwd", "runner-fwd-angle", "runner-back", "runner-workspace-tmp-win", "placeholder-home-then-runner-win"],
    expectPassingRefuseRows: [],
  },
  {
    name: "remove-toolcache-allowance",
    description: "the hosted tool cache must fail again",
    replacements: [{ find: "if (root === \"opt\") return first === \"hostedtoolcache\"", replace: "if (root === \"opt\") return false && first === \"hostedtoolcache\"" }],
    expectFailingAllowRows: ["toolcache"],
    expectPassingRefuseRows: [],
  },
  {
    name: "remove-placeholder-home-posix",
    description: "placeholder account segments after POSIX home roots must fail again",
    replacements: [{ find: "if (isHomePlaceholderSegment(first)) return !embedsIdentityRoot(segments.slice(2));", replace: "if (isHomePlaceholderSegment(first)) return false;" }],
    expectFailingAllowRows: ["pm-swarm-placeholder-home", "placeholder-home-bare", "placeholder-home-unicode-segment", "placeholder-home-angle", "placeholder-users-curly", "placeholder-home-dollar", "placeholder-home-braced", "placeholder-home-dotted", "placeholder-home-braced-root-subdir", "placeholder-home-percent-root-subdir", "placeholder-home-percent", "placeholder-home-in-markup", "placeholder-home-then-proc", "placeholder-home-then-file-url", "placeholder-home-then-file-notes", "placeholder-home-then-runner-win", "placeholder-home-then-bare-drive", "placeholder-home-then-anonymous-tilde", "placeholder-home-windows-fwd", "placeholder-home-windows-percent-root-subdir"],
    expectPassingRefuseRows: [],
  },
  {
    name: "remove-placeholder-home-windows",
    description: "placeholder account segments after a Windows Users root must fail again",
    replacements: [{ find: "return root === \"Users\" && isHomePlaceholderSegment(first) &&", replace: "return false && root === \"Users\" && isHomePlaceholderSegment(first) &&" }],
    expectFailingAllowRows: ["placeholder-home-windows", "placeholder-home-windows-fwd", "placeholder-home-windows-percent-root-subdir", "placeholder-home-windows-username"],
    expectPassingRefuseRows: [],
  },
  {
    name: "broaden-reserved-domain-anchor",
    description: "substring domain matching would admit registrable look-alikes",
    replacements: [
      { find: "RESERVED_EMAIL_DOMAINS.includes(domain) ||", replace: "RESERVED_EMAIL_DOMAINS.some((entry) => domain.includes(entry)) ||" },
      { find: "RESERVED_EMAIL_DOMAIN_SUFFIXES.some((suffix) => domain.endsWith(suffix));", replace: "RESERVED_EMAIL_DOMAIN_SUFFIXES.some((suffix) => domain.includes(suffix.slice(1)));" },
    ],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["lookalike-suffix", "lookalike-prefix", "lookalike-subdomain", "person-noreply-lookalike", "git-contact-colon-prose", "lookalike-domain-digit", "lookalike-domain-hyphen"],
  },
  {
    name: "broaden-runner-shape-posix",
    description: "dropping the work/<seg>/<seg> shape would admit any runner path",
    replacements: [{
      find: "first === \"runner\" && segments[2] === \"work\" && (segments[3] ?? \"\") !== \"\" && (segments[4] ?? \"\") !== \"\" &&",
      replace: "first === \"runner\" &&",
    }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["runner-other-path", "runner-work-none", "runner-work-short"],
  },
  {
    name: "broaden-runner-shape-windows",
    description: "dropping the drive/root/shape checks would admit any drive path",
    replacements: [{
      find: "drive.toLowerCase() === \"d:\" && root === \"a\" && first !== \"\" && (segments[2] ?? \"\") !== \"\" &&",
      replace: "true &&",
    }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["other-drive", "runner-win-short"],
  },
  {
    name: "broaden-git-transport-local-part",
    description: "allowing other SSH local parts would admit personal identities",
    replacements: [{
      find: "(?!(?<=ssh:\\/\\/)git@",
      replace: "(?!(?<=ssh:\\/\\/)[A-Za-z0-9._%+-]+@",
    }, {
      find: "(?!git@",
      replace: "(?![A-Za-z0-9._%+-]+@",
    }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["ssh-other-local", "git-other-local-part"],
  },
  {
    name: "broaden-placeholder-position-posix",
    description: "a placeholder deeper than the home-root child must not hide an account",
    replacements: [{ find: "if (isHomePlaceholderSegment(first))", replace: "if (segments.some(isHomePlaceholderSegment))" }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["placeholder-wrong-level"],
  },
  {
    name: "broaden-placeholder-position-windows",
    description: "a placeholder deeper than the Users-root child must not hide an account",
    replacements: [{ find: 'root === "Users" && isHomePlaceholderSegment(first)', replace: 'root === "Users" && segments.some(isHomePlaceholderSegment)' }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["placeholder-win-wrong-level"],
  },
  {
    name: "remove-escape-segment-check",
    description: "traversal and encoding escapes would pass inside permitted shapes",
    replacements: [{ find: "function isEscapePathSegment(segment: string, posix: boolean): boolean {", replace: "function isEscapePathSegment(segment: string, posix: boolean): boolean { if (segment.length < 9999) return false;" }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["dot-escape-home", "dot-escape-single", "dot-escape-runner", "percent-escape-home", "percent-escape-win"],
  },
  {
    name: "remove-embedded-identity-check",
    description: "identity roots hidden behind a permitted prefix would pass",
    replacements: [{ find: "function embedsIdentityRoot(segments: readonly string[]): boolean {", replace: "function embedsIdentityRoot(segments: readonly string[]): boolean { if (segments.length < 9999) return false;" }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["embedded-home", "embedded-users-runner", "embedded-drive-win", "embedded-users-win-runner", "embedded-tmp", "embedded-private", "embedded-volumes", "embedded-mnt", "embedded-media", "embedded-srv", "embedded-root-under-placeholder", "proc-placeholder-pid-root"],
  },
  {
    name: "allow-procfs-root-continuation",
    description: "a path continuing past the procfs root entry would pass whenever its next root is not an identity root",
    replacements: [{
      find: "if (exemptRootEntry) return tail.slice(1).every((segment) => segment === \"\");",
      replace: "if (exemptRootEntry) return !embedsIdentityRoot(tail.slice(1));",
    }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["proc-root-then-var-folders", "proc-digits-root-then-data"],
  },
  {
    name: "broaden-proc-shape",
    description: "admitting any first segment would admit arbitrary procfs look-alikes",
    replacements: [{
      find: "first === \"\" || first === \"self\" || /^\\d+$/.test(first) || isBracketedPlaceholder(first, \"<\", \">\")",
      replace: "first !== \"________never________\"",
    }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["proc-root-file", "proc-unclosed", "proc-curly"],
  },
  {
    name: "remove-bracket-leadins",
    description: "without bracket lead-ins, a path hidden directly behind a permitted form escapes",
    replacements: [{ find: "pattern: /(?<=^|[\\s\"'`([=,{<>),;\\]}]", replace: "pattern: /(?<=^|[\\s\"'`([=,{]" }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["hidden-after-proc"],
  },
  {
    name: "remove-bracket-smuggle-check",
    description: "a refused path behind any delimiter inside a non-placeholder segment would pass",
    replacements: [{ find: "function hidesHostPathBehindDelimiter(matched: string): boolean {", replace: "function hidesHostPathBehindDelimiter(matched: string): boolean { if (matched.length < 99999) return false;" }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["smuggled-var-after-bracket", "smuggled-var-after-colon", "smuggled-var-after-equals", "smuggled-var-after-square-bracket", "smuggled-var-after-paren", "smuggled-var-after-pipe", "smuggled-data-after-at-proc", "smuggled-file-url-after-placeholder", "proc-colon-chain-over-cap"],
  },
  {
    name: "revert-delimiter-set",
    description: "without colon and equals as delimiters, a path hidden behind a label or assignment prefix passes",
    replacements: [{ find: "if (PATH_NAME_CHARACTER.test(character)) continue;", replace: "if (!\"<>{}\".includes(character)) continue;" }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["smuggled-var-after-colon", "smuggled-var-after-equals", "smuggled-var-after-square-bracket", "smuggled-var-after-paren", "smuggled-var-after-pipe", "smuggled-data-after-at-proc", "proc-colon-chain-over-cap"],
  },
  {
    name: "revert-to-listed-delimiters",
    description: "with an explicit delimiter list instead of the segment-name class, unlisted punctuation hides a second path",
    replacements: [{ find: "if (PATH_NAME_CHARACTER.test(character)) continue;", replace: "if (!\"<>{}:=\".includes(character)) continue;" }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["smuggled-var-after-square-bracket", "smuggled-var-after-paren", "smuggled-var-after-pipe", "smuggled-data-after-at-proc"],
  },
  {
    name: "bracket-only-placeholder-verdict",
    description: "judging only bracketed segments in place would let the closing brace or percent of an env placeholder start a second path",
    replacements: [{ find: "      judgedPlaceholder = isHomePlaceholderSegment(segment);", replace: "      judgedPlaceholder = isBracketedPlaceholder(segment, \"<\", \">\") || isBracketedPlaceholder(segment, \"{\", \"}\");" }],
    expectFailingAllowRows: ["placeholder-home-braced-root-subdir", "placeholder-home-percent-root-subdir", "placeholder-home-windows-percent-root-subdir"],
    expectPassingRefuseRows: [],
  },
  {
    name: "revert-tilde-lead-in",
    description: "with the old listed lead-in, a tilde path straight after a `]`, `)` or `;` that ends a host-path match passes",
    replacements: [{ find: "pattern: /(?:^|[^\\p{L}\\p{N}._~/\\\\-])~", replace: "pattern: /(?:^|[\\s\"'`([=,])~" }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["tilde-after-square-close", "tilde-after-paren-close", "tilde-after-semicolon"],
  },
  {
    name: "ascii-only-name-class",
    description: "an ASCII-only segment-name class would treat non-ASCII letters as delimiters and refuse a placeholder home's subdirectory",
    replacements: [{ find: "const PATH_NAME_CHARACTER = /[\\p{L}\\p{N}._~-]/u;", replace: "const PATH_NAME_CHARACTER = /[A-Za-z0-9._~-]/;" }],
    expectFailingAllowRows: ["placeholder-home-unicode-segment"],
    expectPassingRefuseRows: [],
  },
  {
    name: "remove-delimiter-judgment-cap",
    description: "without the judgment cap, a match with more delimiter-started paths than the bound passes instead of failing closed",
    replacements: [{ find: "if (judgments > MAX_DELIMITER_PATH_JUDGMENTS) return true;", replace: "" }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["proc-colon-chain-over-cap"],
  },
  {
    name: "revert-embedded-identity-list",
    description: "without the system roots, a refused root inside a permitted tail passes",
    replacements: [{
      find: "const EMBEDDED_IDENTITY_SEGMENTS: readonly string[] = [\"home\", \"Users\", \"tmp\", \"private\", \"Volumes\", \"mnt\", \"media\", \"srv\", \"root\"];",
      replace: "const EMBEDDED_IDENTITY_SEGMENTS: readonly string[] = [\"home\", \"Users\"];",
    }],
    expectFailingAllowRows: [],
    expectPassingRefuseRows: ["embedded-tmp", "embedded-private", "embedded-volumes", "embedded-mnt", "embedded-media", "embedded-srv", "embedded-root-under-placeholder", "proc-placeholder-pid-root"],
  },
  {
    name: "remove-proc-root-exception",
    description: "without the procfs root-entry exception, the real root entry must fail again",
    replacements: [{
      find: "const exemptRootEntry = (first === \"self\" || /^\\d+$/.test(first)) && tail[0] === \"root\";",
      replace: "const exemptRootEntry = false;",
    }],
    expectFailingAllowRows: ["proc-self-root-entry", "proc-digits-root-entry"],
    expectPassingRefuseRows: [],
  },
  {
    name: "remove-runner-tmp-exemption",
    description: "without the runner tmp exemption, the hosted runner's own scratch directory must fail again",
    replacements: [{ find: "return segments.filter((segment) => segment !== \"tmp\");", replace: "return segments;" }],
    expectFailingAllowRows: ["runner-workspace-tmp", "runner-workspace-tmp-win"],
    expectPassingRefuseRows: [],
  },
];

/**
 * Verify the baseline corpus against the shipped scanner.
 *
 * @param scan - Baseline scanner used to validate the corpus.
 * @returns An error message, or "" when every allow row is clean and every
 *          refuse row still fires its listed rule.
 */
function baselineCorpusError(scan = scanLineForRuleHits): string {
  for (const row of PUBLIC_FORMS_MUST_ALLOW) {
    if (scan(row.line).length > 0) return `baseline allow row ${row.id} fires the shipped gate`;
  }
  for (const row of PUBLIC_FORMS_MUST_REFUSE) {
    if (!scan(row.line).some((hit) => hit.rule === row.rule)) {
      return `baseline refuse row ${row.id} no longer fires ${row.rule}`;
    }
  }
  return "";
}

/**
 * Rewrite a mutated gate source's import specifiers to absolute file URLs so
 * the copy can load from an operating-system temporary directory.
 *
 * @param source - Mutated gate source text.
 * @param gateDirectory - Directory of the real gate source.
 * @returns The source with relative and bare specifiers absolutized.
 */
function absolutizeImports(source: string, gateDirectory: string): string {
  return source
    .replace('from "./own-record.ts"', `from "${pathToFileURL(join(gateDirectory, "own-record.ts")).href}"`)
    .replace('from "@unbrained/pm-cli/sdk"', `from "${import.meta.resolve("@unbrained/pm-cli/sdk")}"`);
}

/**
 * Execute one mutation against a disposable copy of the gate source.
 *
 * @param mutation - The mutation to apply.
 * @param source - The pristine gate source text.
 * @param scratchPath - File path for the mutated copy.
 * @param gateDirectory - Directory of the real gate source.
 * @param importModule - Importer for the mutated copy.
 * @returns The mutation's outcome, with a non-empty error when it failed.
 */
async function runMutation(
  mutation: MutationSpec,
  source: string,
  scratchPath: string,
  gateDirectory: string,
  importModule: (url: string) => Promise<ScannerModule>,
): Promise<MutationOutcome> {
  let mutated = source;
  for (const replacement of mutation.replacements) {
    const count = mutated.split(replacement.find).length - 1;
    if (count !== 1) {
      return { name: mutation.name, ok: false, flippedAllowRows: [], flippedRefuseRows: [],
        error: `anchor occurs ${count} time(s); the mutation table drifted from gate.ts` };
    }
    mutated = mutated.replace(replacement.find, replacement.replace);
  }
  try {
    writeFileSync(scratchPath, absolutizeImports(mutated, gateDirectory));
    const scanner = await importModule(pathToFileURL(scratchPath).href);
    const flippedAllowRows = PUBLIC_FORMS_MUST_ALLOW
      .filter((row) => scanner.scanLineForRuleHits(row.line).length > 0)
      .map((row) => row.id);
    const flippedRefuseRows = PUBLIC_FORMS_MUST_REFUSE
      .filter((row) => scanner.scanLineForRuleHits(row.line).length === 0)
      .map((row) => row.id);
    const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));
    if (!same(flippedAllowRows, mutation.expectFailingAllowRows)) {
      return { name: mutation.name, ok: false, flippedAllowRows, flippedRefuseRows,
        error: "flipped allow rows drifted from the recorded expectation" };
    }
    if (!same(flippedRefuseRows, mutation.expectPassingRefuseRows)) {
      return { name: mutation.name, ok: false, flippedAllowRows, flippedRefuseRows,
        error: "flipped refuse rows drifted from the recorded expectation" };
    }
    return { name: mutation.name, ok: true, flippedAllowRows, flippedRefuseRows, error: "" };
  } catch {
    return { name: mutation.name, ok: false, flippedAllowRows: [], flippedRefuseRows: [],
      error: "mutated module failed (details withheld)" };
  }
}

/**
 * Run the full mutation-proof table and return what it would write.
 *
 * Pure with respect to the process: streams and exit codes are decided by
 * {@link main}, so a test can assert on the strings. The baseline is always
 * the directly imported shipped scanner; only the disposable mutations load
 * from scratch copies.
 *
 * @param options - Injectables for path, table, importer and scratch directory.
 * @returns The exit code and the newline-free stdout/stderr content.
 */
export async function runPublicFormMutationProof(
  options: Readonly<ProofOptions> = {},
): Promise<MutationProofResult> {
  const mutations = options.mutations ?? PUBLIC_FORM_MUTATIONS;
  const gateSourcePath = options.gateSourcePath ?? join(import.meta.dirname, "..", "gate.ts");
  // Disposable, uniquely named mutants require runtime imports to test the changed module.
  // eslint-disable-next-line no-restricted-syntax
  const importModule = options.importModule ?? ((url: string) => import(url) as Promise<ScannerModule>);
  let source: string;
  try {
    source = readFileSync(gateSourcePath, "utf8");
  } catch {
    return { exitCode: 1, stdout: "", stderr: "public-forms proof: could not read the gate source." };
  }
  const baselineError = baselineCorpusError(options.baselineScanner);
  if (baselineError !== "") {
    return { exitCode: 1, stdout: "", stderr: `public-forms proof: ${baselineError}.` };
  }
  const scratchDirectory = mkdtempSync(join(options.scratchDirectory ?? tmpdir(), "pm-gate-public-forms-"));
  try {
    const outcomes: MutationOutcome[] = [];
    for (let index = 0; index < mutations.length; index++) {
      const mutation = mutations[index]!;
      outcomes.push(await runMutation(
        mutation,
        source,
        join(scratchDirectory, `mutation-${index}.ts`),
        dirname(gateSourcePath),
        importModule,
      ));
    }
    const lines = outcomes.map((outcome) =>
      `${outcome.ok ? "ok  " : "FAIL"} ${outcome.name}: allow-flips=${outcome.flippedAllowRows.length} ` +
      `refuse-flips=${outcome.flippedRefuseRows.length}${outcome.ok ? "" : ` (${outcome.error})`}`);
    const exitCode = outcomes.every((outcome) => outcome.ok) ? 0 : 1;
    return { exitCode, stdout: lines.join("\n"), stderr: exitCode === 0 ? "" : "public-forms proof: at least one mutation drifted." };
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

/**
 * Execute the proof when this file is the process entry point.
 *
 * @param argv - Process argv to compare with the module URL.
 * @param moduleUrl - `import.meta.url` of this module.
 * @param run - Proof runner; production uses the full mutation table.
 */
export async function main(argv: readonly string[], moduleUrl: string, run: () => Promise<MutationProofResult> = runPublicFormMutationProof): Promise<void> {
  if (isMainInvocation(argv, moduleUrl)) {
    const result = await run();
    if (result.stdout !== "") console.log(result.stdout);
    if (result.stderr !== "") console.error(result.stderr);
    process.exitCode = result.exitCode;
  }
}

await main(process.argv, import.meta.url);
