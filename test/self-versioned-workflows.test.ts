/** Execute manifest-based resolution and real package installation from workflow bash. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { decideDailyRelease } from "../scripts/daily-release-plan.ts";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "node_modules/.bin/pm");
const files = [".github/workflows/pm-github-sync.yml", ".github/workflows/pm-github-closeout.yml"];
const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const workflowSha = "a".repeat(40);
const version = "2027.1.2-3";
const template = mkdtempSync(join(tmpdir(), "workflow-tracker-template-"));

/** Extract one named step's real bash without executing adjacent steps. */
function shell(source: string, name: string): string {
  const step = source.split("      - name: ").find(part => part.startsWith(name + "\n"));
  assert.ok(step, name);
  const block = /        run: \|\n([\s\S]*)/.exec(step);
  assert.ok(block, name);
  return block[1].split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
}

/** Dispose isolated caller files even when a contract assertion fails. */
function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-version-"));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

/** Execute real bash steps with isolated pm configuration and bounded runtime. */
function bash(cwd: string, script: string, env: NodeJS.ProcessEnv = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, PM_AUTHOR: "fixture", PM_TELEMETRY_INLINE_FLUSH: "1",
    PM_GLOBAL_PATH: join(cwd, "global"), PM_PATH: join(cwd, ".agents/pm"), NPM_CONFIG_USERCONFIG: "/dev/null" };
  for (const key of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_MEDIA_SERVER"]) delete childEnv[key];
  return spawnSync("bash", ["-c", script], { cwd, env: childEnv, encoding: "utf8", timeout: 30_000 });
}

test.before(() => {
  const init = bash(template, '"$REAL_PM" init fixture --defaults --agent-guidance skip', { REAL_PM: cli });
  assert.equal(init.status, 0, init.stderr + init.stdout);
  const seed = bash(template, '"$REAL_PM" create task "Existing curated item" --id curated --description "Curated content"', { REAL_PM: cli });
  assert.equal(seed.status, 0, seed.stderr + seed.stdout);
});
test.after(() => rmSync(template, { recursive: true, force: true }));

/** Snapshot every durable tracker byte, including native append-only history. */
function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory()
      ? Object.entries(snapshot(join(directory, entry.name))).map(([key, value]) => [entry.name + "/" + key, value])
      : [[entry.name, readFileSync(join(directory, entry.name)).toString("base64")]]));
}

/** Replace external HTTP transport only; local fixture installation uses the real pinned pm. */
function setup(cwd: string): NodeJS.ProcessEnv {
  cpSync(join(template, ".agents"), join(cwd, ".agents"), { recursive: true });
  mkdirSync(join(cwd, "bin"));
  mkdirSync(join(cwd, "packages"));
  // Deliberately unrelated caller metadata must never determine the installed version.
  writeFileSync(join(cwd, "package.json"), '{"name":"caller","version":"1999.1.1"}');
  writeFileSync(join(cwd, "bin/curl"), `#!/usr/bin/env bash
set -euo pipefail
url="\${@: -1}"
printf '%s\\n' "$url" >> http-receipt
case "$url" in
  "https://raw.githubusercontent.com/unbraind/pm-github/$WORKFLOW_SHA/package.json")
    printf '%s' "$WORKFLOW_MANIFEST"; exit "\${MANIFEST_STATUS:-0}" ;;
  "https://registry.npmjs.org/pm-github/"*)
    selected="\${url##*/}"
    [[ "$selected" != "\${MISSING_VERSION:-}" ]] || exit 22
    [[ "\${REGISTRY_STATUS:-0}" == 0 ]] || exit "$REGISTRY_STATUS"
    if [[ -n "\${REGISTRY_METADATA:-}" ]]; then printf '%s' "$REGISTRY_METADATA"; else
      printf '{"name":"pm-github","version":"%s"}' "$selected"
    fi ;;
  *) exit 95 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(cwd, "bin/pm"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == 'package install' ]]; then
  [[ "$3" == npm:pm-github@* && "$4" == --project ]] || exit 95
  printf '%s\\n' "$3" > receipt
  exec "$REAL_PM" package install "$FIXTURE_PACKAGES/\${3#npm:pm-github@}" --project
fi
exec "$REAL_PM" "$@"
`, { mode: 0o755 });
  return { WORKFLOW_SHA: workflowSha, WORKFLOW_MANIFEST: JSON.stringify({ name: "pm-github", version }),
    REQUESTED_PM_GITHUB_VERSION: "", GITHUB_ENV: join(cwd, "github-env"), REAL_PM: cli,
    PM_SYNC_TRACKER: ".agents/pm", FIXTURE_PACKAGES: join(cwd, "packages"), RUNNER_TEMP: cwd,
    PATH: join(cwd, "bin") + ":" + process.env.PATH };
}

/** Supply a minimal real local extension, avoiding npm downloads while retaining pm installation. */
function packageFixture(cwd: string, selected: string): void {
  const directory = join(cwd, "packages", selected);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "pm-github", version: selected, type: "module" }));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ name: "pm-github", version: selected,
    description: "Synthetic workflow installation fixture", entry: "./index.js", capabilities: [] }));
  writeFileSync(join(directory, "index.js"), "export default function () {}\n");
}

interface Scenario {
  name: string;
  manifest?: string;
  input?: string;
  expected?: string;
  warning?: boolean;
  env?: NodeJS.ProcessEnv;
  error?: RegExp;
}

for (const file of files) {
  const source = readFileSync(join(root, file), "utf8");
  const kind = file.includes("closeout") ? "closeout" : "sync";
  const scenarios: Scenario[] = [
    { name: "omitted input follows manifest at SHA without release tags", expected: version },
    { name: "zero-padded release normalizes", manifest: "2026.11.04", expected: "2026.11.4" },
    { name: "zero-padded suffix release normalizes", manifest: "2027.01.01-2", expected: "2027.1.1-2" },
    { name: "large numeric component normalizes without arithmetic overflow", manifest: "18446744073709551616.11.02", expected: "18446744073709551616.11.2" },
    { name: "all-zero component stays zero", manifest: "2026.00.000", expected: "2026.0.0" },
    { name: "older explicit hold installs the hold and warns with both versions", input: "2026.10.16", expected: "2026.10.16", warning: true },
    { name: "newer explicit hold remains explicit", input: "2028.1.1", expected: "2028.1.1", warning: true },
    { name: "matching explicit hold needs no warning", input: version, expected: version },
    { name: "both sides normalize before comparison", manifest: "2026.11.04", input: "2026.011.004", expected: "2026.11.4" },
    { name: "non-existent version fails before tracker write", input: "2099.1.1", env: { MISSING_VERSION: "2099.1.1" }, error: /unavailable; refusing tracker writes/ },
    { name: "non-existent derived release fails before tracker write", env: { MISSING_VERSION: version }, error: /unavailable; refusing tracker writes/ },
    { name: "registry outage fails closed", env: { REGISTRY_STATUS: "28" }, error: /unavailable; refusing tracker writes/ },
    { name: "registry wrong version fails closed", env: { REGISTRY_METADATA: '{"name":"pm-github","version":"1999.1.1"}' }, error: /Registry metadata/ },
    { name: "registry wrong package fails closed", env: { REGISTRY_METADATA: `{"name":"other","version":"${version}"}` }, error: /Registry metadata/ },
    { name: "registry malformed JSON fails closed", env: { REGISTRY_METADATA: 'invalid"private-metadata' }, error: /Registry metadata/ },
    { name: "manifest transport failure cannot use explicit fallback", input: "2026.10.16", env: { MANIFEST_STATUS: "22" }, error: /Cannot read pm-github package.json/ },
    { name: "manifest malformed JSON fails closed", env: { WORKFLOW_MANIFEST: 'invalid"private-metadata' }, error: /Invalid pm-github workflow package metadata/ },
    { name: "manifest wrong package fails closed", env: { WORKFLOW_MANIFEST: '{"name":"caller","version":"1999.1.1"}' }, error: /Invalid pm-github workflow package metadata/ },
    { name: "manifest missing version fails closed", env: { WORKFLOW_MANIFEST: '{"name":"pm-github"}' }, error: /Invalid pm-github workflow package metadata/ },
    { name: "manifest version with a trailing newline refused", manifest: "2026.11.4\n", error: /Invalid pm-github workflow package metadata/ },
    { name: "manifest JSON stream refused", env: { WORKFLOW_MANIFEST: '{"name":"pm-github","version":"2026.11.4"} {"name":"other"}' }, error: /Invalid pm-github workflow package metadata/ },
    { name: "registry JSON stream refused", env: { REGISTRY_METADATA: '{"name":"other"} {"name":"pm-github","version":"2027.1.2-3"}' }, error: /Registry metadata/ },
    { name: "manifest floating version refused", manifest: "latest", error: /Workflow package version/ },
    { name: "missing job workflow SHA refused", env: { WORKFLOW_SHA: "" }, error: /job.workflow_sha/ },
    { name: "tag ref cannot substitute for resolved SHA", env: { WORKFLOW_SHA: "refs/tags/v2026.11.04" }, error: /job.workflow_sha/ },
    { name: "floating explicit input refused", input: "latest", error: /exact numeric version/ },
    { name: "multiline explicit input refused as a whole", input: "2026.11.4\n2026.11.5", error: /exact numeric version/ },
    { name: "malicious explicit input refused without execution or disclosure", input: "$(touch injected)\n::error::injected", error: /exact numeric version/ },
  ];
  for (const scenario of scenarios) {
    test(`${kind} resolves ${scenario.name}`, () => fixture(cwd => {
      const env: NodeJS.ProcessEnv = { ...setup(cwd), WORKFLOW_MANIFEST: JSON.stringify({ name: "pm-github", version: scenario.manifest ?? version }),
        REQUESTED_PM_GITHUB_VERSION: scenario.input ?? "", ...scenario.env };
      const before = snapshot(join(cwd, ".agents/pm"));
      // A real tracker mutation immediately after the resolver must remain unreachable on refusal.
      const result = bash(cwd, 'set -euo pipefail\n' + shell(source, "Resolve pm-github release version")
        + '\npm update fixture-curated --description "Reached tracker write"', env);
      const output = result.stdout + result.stderr;
      assert.doesNotMatch(output, /::error::injected|private-metadata/);
      assert.equal(existsSync(join(cwd, "injected")), false);
      if (scenario.error) {
        assert.notEqual(result.status, 0, output);
        assert.match(output, scenario.error);
        assert.equal(existsSync(env.GITHUB_ENV!), false);
        assert.deepEqual(snapshot(join(cwd, ".agents/pm")), before, "all real tracker bytes must remain unchanged");
        assert.equal(existsSync(join(cwd, "receipt")), false);
      } else {
        assert.equal(result.status, 0, output);
        assert.notDeepEqual(snapshot(join(cwd, ".agents/pm")), before, "control mutation proves the real tracker write is reachable");
        assert.equal(readFileSync(env.GITHUB_ENV!, "utf8"), `PM_GITHUB_VERSION=${scenario.expected}\n`);
        assert.equal(output.includes("::warning::pm-github-version is deprecated"), !!scenario.warning, output);
        if (scenario.warning) assert.match(output, new RegExp(`workflow ${version} installs extension ${scenario.expected}`.replaceAll(".", "\\.")));
        assert.match(readFileSync(join(cwd, "http-receipt"), "utf8"), new RegExp(`/pm-github/${scenario.expected}\\n$`.replaceAll(".", "\\.")));
        packageFixture(cwd, scenario.expected!);
        const scope = shell(source, "Resolve sync commit scope").split("<<'SCOPE'\n")[1]!.split("\nSCOPE")[0]!;
        writeFileSync(join(cwd, "pm-github-sync-scope.sh"), scope);
        const installed = bash(cwd, 'set -a; source "$GITHUB_ENV"; set +a\n' + shell(source, "Install pinned pm-github extension"), env);
        assert.equal(installed.status, 0, installed.stderr + installed.stdout);
        assert.equal(readFileSync(join(cwd, "receipt"), "utf8").trim(), `npm:pm-github@${scenario.expected}`);
        const metadata = JSON.parse(readFileSync(join(cwd, ".agents/pm/extensions/pm-github/package.json"), "utf8")) as { version: string };
        assert.equal(metadata.version, scenario.expected);
      }
    }));
  }
  test(`${kind} install verification explains invalid metadata without disclosure`, () => fixture(cwd => {
    const env = { ...setup(cwd), PM_GITHUB_VERSION: version };
    const scope = shell(source, "Resolve sync commit scope").split("<<'SCOPE'\n")[1]!.split("\nSCOPE")[0]!;
    writeFileSync(join(cwd, "pm-github-sync-scope.sh"), scope);
    const secret = "ghp_" + "A".repeat(36);
    for (const installed of ["1999.1.1", secret, 'invalid"metadata', 'broken"source\\suffix']) {
      // Model damaged installed metadata at the transport boundary, retaining the real verifier.
      mkdirSync(join(cwd, ".agents/pm/extensions/pm-github"), { recursive: true });
      writeFileSync(join(cwd, ".agents/pm/extensions/pm-github/package.json"), `{"version":"${installed}"}`);
      writeFileSync(join(cwd, "bin/pm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      const result = bash(cwd, shell(source, "Install pinned pm-github extension"), env);
      assert.notEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert.ok(output.includes(installed === "1999.1.1"
        ? `::error::Installed pm-github version 1999.1.1 differs from resolved workflow version ${version}.`
        : installed === secret ? `::error::Installed pm-github version <invalid> differs from resolved workflow version ${version}.`
          : "::error::Cannot read installed pm-github version"));
      assert.ok(!output.includes(secret));
      assert.ok(!output.includes(cwd), "parser diagnostics must not expose the tracker path");
    }
  }));
  test(`${kind} binds job identity, preflights before writes, and omits template input`, () => {
    assert.match(source, /WORKFLOW_SHA: \$\{\{ job.workflow_sha \}\}/);
    assert.match(source, /REQUESTED_PM_GITHUB_VERSION: \$\{\{ inputs.pm-github-version \}\}/);
    assert.match(source, /pm-github-version:\n        description: [^\n]+\n        type: string\n        required: false\n        default: ""/);
    assert.ok(source.indexOf("- name: Resolve pm-github release version") < source.indexOf("- name: Checkout caller default branch"));
    assert.doesNotMatch(shell(source, "Resolve pm-github release version"), /\$\{\{/);
    const caller = readFileSync(join(root, `docs/${kind}-workflow-caller.yml`), "utf8");
    assert.doesNotMatch(caller, /pm-github-version/);
    assert.match(caller, /@RELEASE_COMMIT_SHA # vRELEASE_VERSION/);
  });
}

test("both reusable workflows execute identical version resolution", () => {
  assert.equal(shell(readFileSync(join(root, files[0]), "utf8"), "Resolve pm-github release version"),
    shell(readFileSync(join(root, files[1]), "utf8"), "Resolve pm-github release version"));
});

test("workflow manifest normalization equals the release plan npm version", () => {
  for (const today of ["2026.11.04", "2026.09.01", "2026.10.19", "2027.01.01-2"]) {
    const plan = decideDailyRelease({ existingPrs: [], mainSha: "new-main", lastRelease: null, today });
    for (const file of files) fixture(cwd => {
      const env: NodeJS.ProcessEnv = { ...setup(cwd), WORKFLOW_MANIFEST: JSON.stringify({ name: "pm-github", version: plan.tag.slice(1) }) };
      const result = bash(cwd, shell(readFileSync(join(root, file), "utf8"), "Resolve pm-github release version"), env);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(env.GITHUB_ENV!, "utf8"), `PM_GITHUB_VERSION=${plan.npm_version}\n`);
    });
  }
});

test("release retains token behavior and never stamps or commits reusable workflows", () => {
  assert.doesNotMatch(release, /release_token|RELEASE_APP_|release-stamped|Stamp the workflow/);
  assert.match(release, /GH_TOKEN: \$\{\{ github.token \}\}/);
  for (const step of ["Update release version", "Commit release files", "Verify merged release"]) {
    assert.doesNotMatch(shell(release, step), /pm-github-(?:sync|closeout)\.yml/);
  }
});

test("version discovery documents App-free lookup and no release-time stamping", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8").replace(/\s+/g, " ");
  assert.match(readme, /Release version discovery needs no GitHub App, and no release-time workflow stamping is required\./);
  assert.match(readme, /The release workflow keeps its existing token behavior\./);
});
