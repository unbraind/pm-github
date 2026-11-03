// Shared corpora for the public technical-forms privacy-gate change
// (gh:unbraind/pm-github#193). The two tables are the single source of truth
// for the gate tests (test/gate-public-forms.test.ts) and the mutation-proof
// script (scripts/prove-gate-public-forms.ts): removing or broadening one gate
// allowance must flip exactly the rows tagged for it.
//
// Every row is ASSEMBLED from parts at run time so no tracked blob ever holds
// a complete home-path shape; synthetic identities only (alice, example,
// <user>). The must-allow table covers each permitted form plus the real
// issue-body snippets from the blocked fleet syncs; the must-refuse table
// covers every shape the requirement keeps fail-closed.

/** Allowance a must-allow row depends on (used by the removal mutations). */
export type PublicAllowGroup =
  | "sysfs"
  | "procfs"
  | "reserved-email"
  | "git-transport"
  | "runner-posix"
  | "runner-windows"
  | "toolcache"
  | "placeholder-home-posix"
  | "placeholder-home-windows";

/** Refusal family a must-refuse row guards (used by the broadening mutations). */
export type PublicRefuseGroup =
  | "concrete-home"
  | "root-and-temp"
  | "dot-escape"
  | "encoding-escape"
  | "embedded-identity"
  | "lookalike-email"
  | "contact-address"
  | "runner-shape"
  | "proc-shape"
  | "toolcache-shape"
  | "other-drive";

/** One corpus row: a line of issue-like text plus its group tags. */
export interface PublicFormRow {
  /** Stable row identifier used in failure messages and the mutation table. */
  readonly id: string;
  /** The issue-like line under test, assembled from parts. */
  readonly line: string;
  /** The allowance group a must-allow row depends on. */
  readonly allowGroup?: PublicAllowGroup;
  /** The refusal family a must-refuse row guards. */
  readonly refuseGroup?: PublicRefuseGroup;
}

/**
 * Assemble a POSIX path at run time so tracked blobs never hold a complete
 * home-path shape.
 *
 * @param segments - Path segments after the leading root slash.
 * @returns The assembled absolute path.
 */
const posix = (...segments: readonly string[]): string => ["", ...segments].join("/");

/**
 * Assemble a Windows path with backslash separators.
 *
 * @param drive - The single drive letter.
 * @param segments - Path segments after the drive root.
 * @returns The assembled drive path.
 */
const winBack = (drive: string, ...segments: readonly string[]): string => `${drive}:\\${segments.join("\\")}`;

/**
 * Assemble a Windows path with forward-slash separators.
 *
 * @param drive - The single drive letter.
 * @param segments - Path segments after the drive root.
 * @returns The assembled drive path.
 */
const winFwd = (drive: string, ...segments: readonly string[]): string => `${drive}:/${segments.join("/")}`;

/**
 * Must-allow corpus: every public, non-identifying technical form the gate
 * admits, plus the original public technical issue snippets from the blocked
 * scheduled syncs. Each row must produce ZERO rule hits in every scan mode.
 */
export const PUBLIC_FORMS_MUST_ALLOW: readonly PublicFormRow[] = [
  // --- procfs and sysfs interfaces -------------------------------------
  { id: "pm-review-title", line: "Detached-descendant deadline test rejects ESRCH from a disappearing " + posix("proc") + " process", allowGroup: "procfs" },
  { id: "pm-review-body-proc-pid", line: "polls the descendant's `" + posix("proc", "<pid>", "stat") + "`", allowGroup: "procfs" },
  { id: "pm-review-body-proc-bare", line: "without creating processes, reading " + posix("proc") + ", or sending signals", allowGroup: "procfs" },
  { id: "proc-bare", line: "inspect " + posix("proc"), allowGroup: "procfs" },
  { id: "proc-self", line: "check " + posix("proc", "self", "status"), allowGroup: "procfs" },
  { id: "proc-self-root-only", line: "resolve " + posix("proc", "self"), allowGroup: "procfs" },
  { id: "proc-digits", line: "cat " + posix("proc", "1234", "stat"), allowGroup: "procfs" },
  { id: "proc-placeholder", line: "read " + posix("proc", "<proc-id>", "maps"), allowGroup: "procfs" },
  // 65 public procfs paths joined by colons: 64 delimiter-started judgments, exactly the cap.
  { id: "proc-colon-chain-at-cap", line: "search " + Array.from({ length: 65 }, () => posix("proc", "self", "status")).join(":"), allowGroup: "procfs" },
  { id: "proc-self-root-entry", line: "resolve " + posix("proc", "self", "root"), allowGroup: "procfs" },
  { id: "proc-digits-root-entry", line: "readlink " + posix("proc", "1234", "root"), allowGroup: "procfs" },
  { id: "sys-bare", line: "enumerate " + posix("sys"), allowGroup: "sysfs" },
  { id: "sys-tree", line: "read " + posix("sys", "class", "net", "eth0", "type"), allowGroup: "sysfs" },
  // --- reserved-domain fixture emails -----------------------------------
  { id: "pm-context-fixture", line: "user.email=fixture@example.invalid", allowGroup: "reserved-email" },
  { id: "reserved-example-com", line: "contact user@example.com", allowGroup: "reserved-email" },
  { id: "reserved-example-net", line: "contact user@example.net", allowGroup: "reserved-email" },
  { id: "reserved-example-org", line: "contact user@example.org", allowGroup: "reserved-email" },
  { id: "reserved-sub-example", line: "contact user@mail.example", allowGroup: "reserved-email" },
  { id: "reserved-sub-invalid", line: "contact user@host.invalid", allowGroup: "reserved-email" },
  { id: "reserved-sub-test", line: "contact user@qa.test", allowGroup: "reserved-email" },
  { id: "reserved-sub-localhost", line: "contact user@service.localhost", allowGroup: "reserved-email" },
  { id: "reserved-bare-localhost", line: "contact user@localhost", allowGroup: "reserved-email" },
  { id: "reserved-uppercase", line: "contact USER@EXAMPLE.COM", allowGroup: "reserved-email" },
  { id: "reserved-ssh-other-local", line: "clone ssh://person@example.invalid/repo.git", allowGroup: "reserved-email" },
  { id: "reserved-bare-uppercase", line: "contact USER@LOCALHOST", allowGroup: "reserved-email" },
  // --- SSH git transport identity ----------------------------------------
  { id: "pm-jev-ssh-url", line: "hence the `git ls-remote ssh://git@github.com/release-artifact/package.tgz.git` calls", allowGroup: "git-transport" },
  { id: "git-transport-ssh-owner", line: "clone ssh://git@github.com/owner/repo.git", allowGroup: "git-transport" },
  { id: "git-transport-scp", line: "git clone git@github.com:unbraind/pm-github.git", allowGroup: "git-transport" },
  { id: "git-transport-port", line: "ls-remote ssh://git@github.com:22/unbraind/pm-github.git", allowGroup: "git-transport" },
  // --- GitHub-hosted runner workspaces ------------------------------------
  { id: "pm-rust-runner-fwd", line: "from D:/a/pm-rust/pm-rust/tests/oracle/suite.ts on the Windows runner", allowGroup: "runner-windows" },
  { id: "runner-fwd-angle", line: "at D:/a/<repo>/<repo>/tests/unit.test.ts", allowGroup: "runner-windows" },
  { id: "runner-back", line: "at D:\\a\\pm-rust\\pm-rust\\tests\\oracle\\suite.ts", allowGroup: "runner-windows" },
  { id: "runner-posix", line: "see " + posix("home", "runner", "work", "repo", "repo", "attribution.txt"), allowGroup: "runner-posix" },
  { id: "runner-macos", line: "see " + posix("Users", "runner", "work", "repo", "repo", "attribution.txt"), allowGroup: "runner-posix" },
  { id: "runner-workspace-tmp", line: "see " + posix("home", "runner", "work", "repo", "repo", "tmp", "build.log"), allowGroup: "runner-posix" },
  { id: "runner-workspace-tmp-win", line: "at " + winFwd("D", "a", "repo", "repo", "tmp", "build.log"), allowGroup: "runner-windows" },
  // --- hosted tool cache ---------------------------------------------------
  { id: "toolcache", line: "using " + posix("opt", "hostedtoolcache", "node", "20.5.0", "x64", "bin", "node"), allowGroup: "toolcache" },
  // --- placeholder home segments -------------------------------------------
  { id: "pm-swarm-placeholder-home", line: "fixture paths " + posix("home", "example", "file") + " and " + posix("Users", "example", "file"), allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-bare", line: "resolve " + posix("home", "example"), allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-angle", line: "open " + posix("home", "<user>", "project"), allowGroup: "placeholder-home-posix" },
  { id: "placeholder-users-curly", line: "open " + posix("Users", "{user}", "config"), allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-dollar", line: "cache at " + posix("home", "$USER", ".cache"), allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-braced", line: "cache at " + posix("home", "${USER}", ".cache"), allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-dotted", line: "open " + posix("home", "<user.name>", "project"), allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-percent", line: "open " + posix("home", "%USERNAME%", "project"), allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-in-markup", line: "see <code>" + posix("home", "<user>", "repo") + "</code>", allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-then-proc", line: "compare " + posix("home", "<user>", "notes") + ">" + posix("proc", "self", "status"), allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-then-file-url", line: "compare " + posix("home", "<user>", "notes") + ">file://" + posix("proc", "self", "status"), allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-then-file-notes", line: "compare " + posix("home", "example", "x") + ">file:///notes", allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-then-runner-win", line: "compare " + posix("home", "example", "x") + ">" + winFwd("D", "a", "repo", "repo", "build.log"), allowGroup: "runner-windows" },
  { id: "placeholder-home-then-bare-drive", line: "compare " + posix("home", "example", "x") + ">" + "D:/", allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-then-anonymous-tilde", line: "compare " + posix("home", "example", "x") + ">~/notes", allowGroup: "placeholder-home-posix" },
  { id: "placeholder-home-windows", line: "config at " + winBack("C", "Users", "example", "file"), allowGroup: "placeholder-home-windows" },
  { id: "placeholder-home-windows-fwd", line: "config at " + winFwd("C", "Users", "<user>", "file"), allowGroup: "placeholder-home-windows" },
  { id: "placeholder-home-windows-username", line: "config at " + winBack("C", "Users", "%USERNAME%", "settings.json"), allowGroup: "placeholder-home-windows" },
];

/** The rule each must-refuse row expects, narrowed for callers. */
export interface PublicFormRefuseRow extends PublicFormRow {
  /** The rule identifier the row must produce. */
  readonly rule: string;
}

/**
 * Must-refuse corpus: every shape the requirement keeps fail-closed — concrete
 * home directories, /root and temp trees, dot-segment and encoding escapes,
 * embedded identity roots, real and look-alike contact addresses, and the
 * runner/proc/drive shapes outside the permitted forms. Each row must produce
 * the listed rule hit in every scan mode.
 */
export const PUBLIC_FORMS_MUST_REFUSE: readonly PublicFormRefuseRow[] = [
  // --- concrete home directories and identities --------------------------
  { id: "home-alice", line: "crash at " + posix("home", "alice", "report.txt"), rule: "absolute-host-path", refuseGroup: "concrete-home" },
  { id: "home-alice-bare", line: "resolve " + posix("home", "alice"), rule: "absolute-host-path", refuseGroup: "concrete-home" },
  { id: "users-alice", line: "crash at " + posix("Users", "alice", "report.txt"), rule: "absolute-host-path", refuseGroup: "concrete-home" },
  { id: "win-users-alice", line: "crash at " + winBack("C", "Users", "alice", "debug.log"), rule: "windows-host-path", refuseGroup: "concrete-home" },
  { id: "win-users-alice-fwd", line: "crash at " + winFwd("C", "Users", "alice", "debug.log"), rule: "windows-host-path", refuseGroup: "concrete-home" },
  { id: "tilde-alice", line: "see ~alice/report.txt", rule: "home-username", refuseGroup: "concrete-home" },
  // --- root and temp trees (temp paths can embed home paths) --------------
  { id: "pm-ops-root-file", line: "reproduce by reading " + posix("root", "file"), rule: "absolute-host-path", refuseGroup: "root-and-temp" },
  { id: "pm-ops-tmp-fence", line: "run mkdir " + posix("tmp", "fence"), rule: "absolute-host-path", refuseGroup: "root-and-temp" },
  { id: "root-bare", line: "under " + posix("root"), rule: "absolute-host-path", refuseGroup: "root-and-temp" },
  { id: "tmp-bare", line: "clean " + posix("tmp"), rule: "absolute-host-path", refuseGroup: "root-and-temp" },
  { id: "var-folders", line: "cache under " + posix("var", "folders", "xy", "abc123", "T"), rule: "absolute-host-path", refuseGroup: "root-and-temp" },
  // --- dot-segment escapes -------------------------------------------------
  { id: "dot-escape-home", line: "read " + posix("home", "example", "..", "alice"), rule: "absolute-host-path", refuseGroup: "dot-escape" },
  { id: "dot-escape-single", line: "read " + posix("home", "example", ".", "alice"), rule: "absolute-host-path", refuseGroup: "dot-escape" },
  { id: "dot-escape-runner", line: "read " + posix("home", "runner", "work", "a", "a", "..", "..", "..", "alice"), rule: "absolute-host-path", refuseGroup: "dot-escape" },
  { id: "dot-escape-win", line: "at D:/a/x/x/../../Users/alice", rule: "windows-host-path", refuseGroup: "dot-escape" },
  { id: "dot-escape-win-back", line: "at " + winBack("D", "a", "x", "x", "..", "Users", "alice"), rule: "windows-host-path", refuseGroup: "dot-escape" },
  // --- percent- and backslash-encoded variants ------------------------------
  { id: "percent-escape-home", line: "read " + posix("home", "example", "%2e%2e", "alice"), rule: "absolute-host-path", refuseGroup: "encoding-escape" },
  { id: "percent-escape-win", line: "read " + winFwd("C", "Users", "example", "%2e%2e", "config"), rule: "windows-host-path", refuseGroup: "encoding-escape" },
  { id: "backslash-segment", line: "scan " + posix("home", "example") + "\\.hidden", rule: "absolute-host-path", refuseGroup: "encoding-escape" },
  // --- identity roots embedded behind a permitted prefix --------------------
  { id: "embedded-home", line: "link " + posix("home", "example", "x", "home", "alice"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "embedded-users-runner", line: "link " + posix("Users", "runner", "work", "a", "a", "Users", "alice"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "embedded-drive-win", line: "link " + winBack("C", "Users", "example", "C:", "Users", "alice"), rule: "windows-host-path", refuseGroup: "embedded-identity" },
  { id: "embedded-users-win-runner", line: "link " + winFwd("D", "a", "x", "x", "Users", "alice"), rule: "windows-host-path", refuseGroup: "embedded-identity" },
  // --- account- or machine-bearing system roots inside a permitted tail ------
  { id: "embedded-tmp", line: "leak " + posix("home", "example", "x", "tmp", "alice-notes"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "embedded-private", line: "leak " + posix("home", "example", "x", "private", "id_rsa"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "embedded-volumes", line: "leak " + posix("home", "example", "x", "Volumes", "backup"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "embedded-mnt", line: "leak " + posix("home", "example", "x", "mnt", "backup"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "embedded-media", line: "leak " + posix("home", "example", "x", "media", "usb"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "embedded-srv", line: "leak " + posix("home", "example", "x", "srv", "www"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "embedded-root-under-placeholder", line: "leak " + posix("home", "example", "x", "root", ".ssh", "id_rsa"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  // --- the procfs root entry continuing into a real filesystem path ----------
  { id: "proc-root-then-tmp", line: "leak " + posix("proc", "self", "root", "tmp", "alice-notes"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "proc-root-then-root", line: "leak " + posix("proc", "self", "root", "root", ".ssh", "id_rsa"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "proc-root-then-var-folders", line: "leak " + posix("proc", "self", "root", "var", "folders", "xy", "abc123", "T"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "proc-digits-root-then-data", line: "leak " + posix("proc", "1234", "root", "data", "alice"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "proc-placeholder-pid-root", line: "leak " + posix("proc", "<pid>", "root", "tmp", "alice"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  // --- a path hidden directly behind a permitted form ------------------------
  { id: "hidden-after-proc", line: "see " + posix("proc") + "<" + posix("home", "alice") + "> end", rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "hidden-after-placeholder", line: "ok " + posix("home", "example") + ">" + posix("home", "alice"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  // --- a refused path behind a delimiter inside a non-placeholder segment ----
  { id: "smuggled-root-after-placeholder", line: "ok " + posix("home", "<user>", "x") + ">" + posix("root", ".ssh", "id_rsa"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "smuggled-temp-after-proc", line: "read " + posix("proc", "self", "x") + "}" + posix("tmp", "alice-notes"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "smuggled-tilde-after-runner", line: "log " + posix("home", "runner", "work", "a", "b") + ">~alice/notes", rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "smuggled-drive-after-win-placeholder", line: "ok " + winBack("C", "Users", "<user>", "x") + ">" + winBack("D", "private", "alice"), rule: "windows-host-path", refuseGroup: "embedded-identity" },
  { id: "smuggled-root-key-after-colon", line: "ok " + posix("home", "<user>", "notes:") + posix("root", ".ssh", "id_rsa"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "smuggled-var-after-colon", line: "ok " + posix("home", "<user>", "notes:") + posix("var", "log", "syslog"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "smuggled-var-after-equals", line: "ok " + posix("home", "<user>", "notes=") + posix("var", "log", "syslog"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "smuggled-var-after-bracket", line: "ok " + posix("home", "<user>", "x>") + posix("var", "log", "syslog"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "smuggled-file-url-after-placeholder", line: "ok " + posix("home", "<user>", "x>") + "file://" + posix("var", "log", "syslog"), rule: "absolute-host-path", refuseGroup: "embedded-identity" },
  { id: "sys-dot-escape", line: "read " + posix("sys", "..", "home", "alice"), rule: "absolute-host-path", refuseGroup: "dot-escape" },
  { id: "placeholder-wrong-level", line: "read " + posix("home", "alice", "<user>", "file"), rule: "absolute-host-path", refuseGroup: "concrete-home" },
  { id: "placeholder-win-wrong-level", line: "read " + winBack("C", "Users", "alice", "{user}", "file"), rule: "windows-host-path", refuseGroup: "concrete-home" },
  { id: "lookalike-domain-digit", line: "contact user@example.com2", rule: "email-address", refuseGroup: "lookalike-email" },
  { id: "lookalike-domain-hyphen", line: "contact user@host.test-other", rule: "email-address", refuseGroup: "lookalike-email" },
  { id: "ssh-other-local", line: "clone ssh://alice@github.com/owner/repo.git", rule: "email-address", refuseGroup: "contact-address" },
  // --- real and look-alike contact addresses ----------------------------------
  { id: "lookalike-suffix", line: "contact user@example.com.evil.io", rule: "email-address", refuseGroup: "lookalike-email" },
  { id: "lookalike-prefix", line: "contact user@notexample.com", rule: "email-address", refuseGroup: "lookalike-email" },
  { id: "lookalike-subdomain", line: "contact user@sub.example.com", rule: "email-address", refuseGroup: "lookalike-email" },
  { id: "real-person-host", line: "contact alice@github.com", rule: "email-address", refuseGroup: "lookalike-email" },
  { id: "person-noreply-lookalike", line: "contact person-noreply@example.dev", rule: "email-address", refuseGroup: "lookalike-email" },
  { id: "git-contact-bare", line: "Contact git@github.com", rule: "email-address", refuseGroup: "contact-address" },
  { id: "git-contact-colon-prose", line: "write to git@example.dev: thanks", rule: "email-address", refuseGroup: "contact-address" },
  { id: "git-other-local-part", line: "clone as agit@github.com:x", rule: "email-address", refuseGroup: "contact-address" },
  { id: "git-log-line", line: "error: git@github.com: Permission denied (publickey)", rule: "email-address", refuseGroup: "contact-address" },
  // --- runner shapes outside the permitted form -------------------------------
  { id: "runner-other-path", line: "scratch at " + posix("home", "runner", "scratch"), rule: "absolute-host-path", refuseGroup: "runner-shape" },
  { id: "runner-work-none", line: "scratch at " + posix("home", "runner", "work"), rule: "absolute-host-path", refuseGroup: "runner-shape" },
  { id: "runner-work-short", line: "scratch at " + posix("home", "runner", "work", "a"), rule: "absolute-host-path", refuseGroup: "runner-shape" },
  { id: "runner-win-short", line: "at " + winFwd("D", "a", "x"), rule: "windows-host-path", refuseGroup: "runner-shape" },
  { id: "other-drive", line: "at " + winFwd("E", "a", "x", "x"), rule: "windows-host-path", refuseGroup: "other-drive" },
  { id: "c-other-root", line: "at " + winFwd("C", "Work", "example"), rule: "windows-host-path", refuseGroup: "other-drive" },
  // --- proc shapes outside the permitted form ----------------------------------
  // 66 public procfs paths: one judgment past the cap, which fails closed.
  { id: "proc-colon-chain-over-cap", line: "search " + Array.from({ length: 66 }, () => posix("proc", "self", "status")).join(":"), rule: "absolute-host-path", refuseGroup: "proc-shape" },
  { id: "proc-root-file", line: "read " + posix("proc", "uptime"), rule: "absolute-host-path", refuseGroup: "proc-shape" },
  { id: "proc-unclosed", line: "read " + posix("proc", "<pid", "x"), rule: "absolute-host-path", refuseGroup: "proc-shape" },
  { id: "proc-curly", line: "read " + posix("proc", "{pid}", "x"), rule: "absolute-host-path", refuseGroup: "proc-shape" },
  // --- toolcache and opt shapes outside the permitted form ---------------------
  { id: "opt-other", line: "read " + posix("opt", "other", "config"), rule: "absolute-host-path", refuseGroup: "toolcache-shape" },
];
