/** Re-derive the ownership ledger's anchors from TypeScript syntax, preserving reviewed path explanations. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { isMainInvocation } from "./main-invocation.ts";

interface Site { line: number; label: string }
interface Group { file: string; name: string; sites: Site[] }
const document = "docs/identity-ownership-inventory.md";
const fields = new Set(["github_url", "github_repo", "github_number", "external_ref"]);
const additional = new Map([
  ["import-fidelity.ts/legacyGithubDescriptionIdentity", "Legacy native declaration identity: anchored at description start, first complete issue/PR URL, with trailing punctuation removed. No link-only marker or whole-description match is required."],
  ["import-fidelity.ts/githubLinkReferences", "Reference extraction only: supported link fields expose prose and API URL mentions, never owner claims or an import target."],
  ["projects.ts/indexSelectedByIssue", "Build one complete ownership index, then look up selected items only; conflicts between unselected items do not abort a scoped pull."],
]);

/** Minimal syntax shape keeps this tooling independent of the compiler's optional JavaScript API. */
interface SyntaxNode extends Record<string, unknown> { type: string; loc?: { start: { line: number } } }
const syntax = createRequire(import.meta.url)("@babel/parser") as { parse: (source: string, options: { sourceType: "module"; plugins: ["typescript"] }) => SyntaxNode };

/** Narrow parser children without treating arbitrary metadata or comments as syntax nodes. */
function syntaxNode(value: unknown): SyntaxNode | undefined {
  return value !== null && typeof value === "object" && "type" in value && typeof value.type === "string" ? value as SyntaxNode : undefined;
}

/** Collect every inventoried call, raw identity-field read and reference regex with its actual enclosing function. */
function collect(root: string, helpers: ReadonlySet<string>): Group[] {
  const groups = new Map<string, Group>();
  for (const file of readdirSync(root).filter(file => file.endsWith(".ts")).sort()) {
    const source = syntax.parse(readFileSync(join(root, file), "utf8"), { sourceType: "module", plugins: ["typescript"] });
    /** Walk syntax rather than searching comments or stale line offsets. */
    function visit(node: SyntaxNode, enclosing = "<module>", parent?: SyntaxNode): void {
      const id = syntaxNode(node.id), binding = syntaxNode(parent?.id);
      if (node.type === "FunctionDeclaration" && typeof id?.name === "string") enclosing = id.name;
      if (node.type === "ArrowFunctionExpression" && parent?.type === "VariableDeclarator" && typeof binding?.name === "string") enclosing = binding.name;
      const callee = syntaxNode(node.callee), property = syntaxNode(node.property);
      let label: string | undefined;
      if (["CallExpression", "OptionalCallExpression"].includes(node.type) && callee?.type === "Identifier" && typeof callee.name === "string" && helpers.has(callee.name)) label = `${callee.name}()`;
      if (node.type === "RegExpLiteral" && typeof node.pattern === "string" && node.pattern.includes("gh:")) label = "reference tag regex";
      if (["MemberExpression", "OptionalMemberExpression"].includes(node.type) && !node.computed && typeof property?.name === "string" && fields.has(property.name)) label = property.name;
      if (label && node.loc) {
        const key = `${file}/${enclosing}`, group = groups.get(key) ?? { file, name: enclosing, sites: [] };
        group.sites.push({ line: node.loc.start.line, label });
        groups.set(key, group);
      }
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "comments", "leadingComments", "trailingComments"].includes(key)) continue;
        for (const child of Array.isArray(value) ? value : [value]) {
          const parsed = syntaxNode(child); if (parsed) visit(parsed, enclosing, node);
        }
      }
    }
    visit(source);
  }
  return [...groups.values()].sort((a, b) => a.file.localeCompare(b.file) || a.sites[0]!.line - b.sites[0]!.line);
}

/** Render every root anchor and non-root audit anchor from the current files; ledger prose is not used as a source location. */
export function renderIdentityInventory(root: string, ledger = readFileSync(join(root, document), "utf8")): string {
  const explanations = new Map<string, string>(), helpers = new Set<string>(["githubLinkReferences", "indexSelectedByIssue", "legacyGithubDescriptionIdentity"]);
  for (const row of ledger.matchAll(/^\| `([^`]+)` \/ `([^`]+)` \| (.*?) \| (.*?) \|$/gm)) {
    explanations.set(`${row[1]}/${row[2]}`, row[4]!);
    for (const call of row[3]!.matchAll(/\b([A-Za-z_$][\w$]*)\(\)/g)) helpers.add(call[1]!);
  }
  for (const [key, value] of additional) explanations.set(key, value);
  const groups = collect(root, helpers), total = groups.reduce((sum, group) => sum + group.sites.length, 0);
  const start = ledger.indexOf("| File / enclosing function |"), end = ledger.indexOf("\n## Scripts and workflow audit");
  if (start < 0 || end < start || groups.length < 80) throw new Error("Ownership inventory template or source corpus is incomplete.");
  let intro = ledger.slice(0, start).replace(/Initial inventory:[^\n]+/, "Initial inventory: reviewed head `d9d9bc7`. Anchors are regenerated from the merged source with `node scripts/identity-inventory.ts --write` and checked by the same command with `--check`.")
    .replace(/\d+ function groups; \d+ helper-call\/field\/parser sites\./, `${groups.length} function groups; ${total} helper-call/field/parser sites.`);
  intro = intro.replace(/(?:Only the raw-collector implementation|Owner claims come from)[^\n]+/, "Owner claims come from whole-value explicit identity fields, external_ref, or a proven importer ID. A leading native GitHub issue or GH issue/PR declaration retains legacy ownership without a link-only marker or whole-description match; direct provenance still protects against copied provider markers. Generic link fields and their prose produce references only. Operational selectors consume the shared ownership index; provider backlinks and explicit opt-in citation adoption keep their separate first-link authorization.");
  const missing = groups.filter(group => !explanations.has(`${group.file}/${group.name}`));
  if (missing.length) throw new Error(`Classify ownership groups: ${missing.map(group => `${group.file}/${group.name}`).join(", ")}`);
  const rows = groups.map(group => {
    const reason = explanations.get(`${group.file}/${group.name}`);
    if (!reason) throw new Error(`Classify new ownership group ${group.file}/${group.name} before publishing its inventory.`);
    return `| \`${group.file}\` / \`${group.name}\` | ${group.sites.map(site => `\`${group.file}:${site.line}\` ${site.label}`).join("; ")} | ${reason} |`;
  });
  const auxiliary: string[] = [];
  for (const folder of ["scripts", ".github/workflows"]) for (const file of readdirSync(join(root, folder)).sort()) {
    if (!/\.(?:ts|ya?ml)$/.test(file) || file === "identity-inventory.ts") continue;
    readFileSync(join(root, folder, file), "utf8").split("\n").forEach((line, index) => {
      if (!/gh:|github_url|github_repo|github_number|external_ref/.test(line)) return;
      const treatment = file === "dependabot-merge.ts" ? "Explicit GitHub CLI transport parameter; targets come from repository/PR arguments."
        : file === "prove-gate-public-forms.ts" ? "Privacy-gate documentation reference; no target lookup."
        : file === "pm-github-sync.yml" ? "Importer option documentation or typed diagnostic rendering; no independent target lookup."
        : undefined;
      if (!treatment) throw new Error(`Classify new auxiliary identity use in ${folder}/${file}.`);
      auxiliary.push(`| \`${folder}/${file}:${index + 1}\` | ${treatment} |`);
    });
  }
  return intro + ["| File / enclosing function | Call sites and field accesses | Path / ownership treatment |", "| --- | --- | --- |", ...rows, "", "## Scripts and workflow audit", "", `The identity-field/tag scan finds ${auxiliary.length} auxiliary locations. The inventory generator itself names these fields to document them; it selects no GitHub target. All anchors below are derived from the current file contents.`, "", "| Location | Treatment |", "| --- | --- |", ...auxiliary, ""].join("\n");
}

if (isMainInvocation(process.argv, import.meta.url)) {
  const root = process.cwd(), current = readFileSync(join(root, document), "utf8"), generated = renderIdentityInventory(root, current);
  if (process.argv.includes("--write")) writeFileSync(join(root, document), generated);
  else if (current !== generated) throw new Error("Ownership inventory is stale; run node scripts/identity-inventory.ts --write.");
  console.log("Ownership inventory: all syntax-derived and auxiliary anchors verified.");
}
