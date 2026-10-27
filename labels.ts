/** Read-only label policy plans. Provider identities never follow display-name inference. */
import { createHash } from "node:crypto";
import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { z } from "zod";
import { createPmCliExpectedError, toImportTags } from "@unbrained/pm-cli/sdk";
import { readRefreshItems } from "./refresh.ts";
import { githubLabelNameKey } from "./label-names.ts";
import { fetchJSON, githubApiBase, parseNextLink, parseProvenanceTag, resolveGitHubToken } from "./index.ts";

/** Stable expected refusals; every failure supplies an actionable remedy. */
export type LabelMigrationRefusalCode = "invalid_input" | "catalog_unavailable" | "stale_labels" | "incomplete_read" | "stale_plan" | "unresolved_choices" | "invalid_output";
/** Fail without echoing source documents, provider payloads or local paths. */
function refuse(code: LabelMigrationRefusalCode, remedy: string): never {
  throw createPmCliExpectedError(`GitHub label migration: ${code}. ${remedy}`, { exitCode: 2, context: { code, required: remedy } });
}

const atom = z.string().min(1).max(200).regex(/^[^\r\n\u0000]+$/).refine(value => value.trim().length > 0);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const label = z.strictObject({ id: atom, name: atom });
const choice = z.enum(["review", "keep", "replace"]);
const requestSchema = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  sources: z.array(label).min(1).max(20),
  change: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("rename"), name: atom }),
    z.strictObject({ kind: z.literal("consolidate"), target: label }),
  ]),
  filters: z.array(z.strictObject({ id: atom, labels: z.array(atom).max(100) })).max(1000),
  mappings: z.array(z.strictObject({ id: atom, from: atom, to: atom })).max(1000),
  choices: z.strictObject({ tags: choice, filters: choice, mappings: choice }),
});
const catalogSchema = z.strictObject({ complete: z.literal(true), labels: z.array(label).max(10000) });
const pageSchema = z.strictObject({ limit: z.number().int().min(1).max(100).default(20), offset: count.default(0) });
const boundarySchema = z.strictObject({ request: requestSchema, page: pageSchema,
  approval: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const rowSchema = z.strictObject({ kind: z.enum(["tags", "filters", "mappings"]), id: atom, source: atom,
  before: atom, after: atom, local_tag: atom.nullable(), choice, evidence: z.enum(["unverified_name", "declared_policy"]),
  identities: z.array(z.string().min(1).max(240)).max(100), identities_omitted: count });
const reportSchema = z.strictObject({ ok: z.literal(true), repo: requestSchema.shape.repo, approval: z.string().regex(/^[a-f0-9]{64}$/),
  checked: z.boolean(), sources: z.array(label).max(20), destination: label,
  counts: z.strictObject({ scanned: count, items: count, tags: count, filters: count, mappings: count, review: count, total: count }),
  offset: count, next: count.nullable(), rows: z.array(rowSchema).max(100) });

/** Explicit source IDs and expected names; filters and mappings are caller-declared policy inventories. */
export type GithubLabelMigrationInput = z.infer<typeof requestSchema>;
/** A complete, repository-scoped provider catalog; IDs are GitHub node_id values. */
export type GithubLabelCatalog = z.infer<typeof catalogSchema>;
/** Adapters must return a fresh complete catalog, or throw; no persistent cache is maintained. */
export type GithubLabelCatalogReader = (repo: string) => Promise<unknown>;
/** Compact output carries complete counts and bounded rows; approval is independent of pagination. */
export type GithubLabelMigrationReport = z.infer<typeof reportSchema>;

/** Parse producers and consumers with exactly the same strict contract. */
export function validateGithubLabelMigrationReport(value: unknown): GithubLabelMigrationReport {
  const result = reportSchema.safeParse(value);
  if (!result.success) refuse("invalid_output", "Discard this report and regenerate it with a supported package version.");
  const report = result.data;
  const c = report.counts;
  const end = BigInt(report.offset) + BigInt(report.rows.length);
  const expectedNext = end < BigInt(c.total) ? Number(end) : null;
  if (BigInt(c.total) !== BigInt(c.tags) + BigInt(c.filters) + BigInt(c.mappings) || c.items > c.scanned || c.review > c.total ||
    end > BigInt(c.total) && report.rows.length > 0 || report.next !== expectedNext ||
    report.next !== null && report.rows.length === 0) {
    refuse("invalid_output", "Regenerate a report with consistent complete counts and continuation.");
  }
  return report;
}

/** Hash complete evidence rather than displayed pages; revisions prevent content-only replay approvals. */
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Canonical order is bytewise and independent of the host's locale. */
function order(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** Refuse duplicate identities instead of silently collapsing user policy or provider labels. */
function unique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) refuse("invalid_input", "Use distinct source, catalog, filter and mapping IDs; remove duplicate identities.");
}

/** Drain every provider page with the existing authenticated HTTP client and constrained pagination. */
export async function readGithubLabelCatalog(repo: string): Promise<GithubLabelCatalog> {
  if (!requestSchema.shape.repo.safeParse(repo).success) refuse("invalid_input", "Supply an explicit owner/repo.");
  const base = `${githubApiBase()}/repos/${repo}/labels`;
  let next: string | undefined = `${base}?per_page=100`;
  const seen = new Set<string>();
  const labels: unknown[] = [];
  try {
    while (next) {
      const url = new URL(next);
      if (url.origin !== new URL(base).origin || url.pathname !== new URL(base).pathname || seen.has(next) || seen.size >= 100) throw new Error("incomplete pagination");
      seen.add(next);
      const response = await fetchJSON(next, resolveGitHubToken());
      const page: unknown = JSON.parse(response.body);
      if (!Array.isArray(page) || page.length > 100) throw new Error("invalid label page");
      for (const entry of page) {
        const node = entry as { node_id?: unknown; name?: unknown } | null;
        labels.push({ id: node?.node_id, name: node?.name });
      }
      next = parseNextLink(response.linkHeader);
    }
    const catalog = catalogSchema.parse({ complete: true, labels });
    unique(catalog.labels.map(entry => entry.id));
    return catalog;
  } catch { refuse("catalog_unavailable", "Restore read access to the complete repository label catalog and retry; partial catalogs cannot authorize a plan."); }
}

/** Read bounded JSON using a descriptor, refusing linked/special files before consuming bytes. */
export function readLabelMigrationJson(file: string): unknown {
  try {
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) throw new Error("special input");
      const buffer = Buffer.alloc(1048577);
      const size = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (size > 1048576) throw new Error("unbounded input");
      return JSON.parse(buffer.subarray(0, size).toString("utf8")) as unknown;
    } finally { closeSync(descriptor); }
  } catch { refuse("invalid_input", "Supply a regular JSON file of at most 1 MiB with the documented label migration contract."); }
}

/** Preview or revalidate a plan through complete isolated SDK reads, without creating a journal or writing targets. */
export async function planGithubLabelMigration(pmRoot: string, input: GithubLabelMigrationInput,
  options: { page?: { limit?: number; offset?: number }; approval?: string; readCatalog?: GithubLabelCatalogReader } = {}): Promise<GithubLabelMigrationReport> {
  const parsed = boundarySchema.safeParse({ request: input, page: options.page ?? {}, approval: options.approval });
  if (!parsed.success) refuse("invalid_input", "Use the strict contract with dense bounded arrays, exact IDs/names, explicit choices, limit 1..100, a safe offset and full approval digest.");
  const { request, page, approval } = parsed.data;
  let catalog: unknown;
  try { catalog = await (options.readCatalog ?? readGithubLabelCatalog)(request.repo); }
  catch { refuse("catalog_unavailable", "Fetch a fresh complete label catalog with repository read access, then retry."); }
  const catalogResult = catalogSchema.safeParse(catalog);
  if (!catalogResult.success) refuse("invalid_input", "Supply the strict complete catalog shape with dense bounded label records.");
  const labels = catalogResult.data.labels.sort((a, b) => order(a.id, b.id));
  for (const entries of [request.sources, labels, request.filters, request.mappings]) unique(entries.map(entry => entry.id));
  const selected = request.change.kind === "rename" ? request.sources : [...request.sources, request.change.target];
  for (const source of selected) if (!labels.some(current => current.id === source.id && current.name === source.name)) {
    refuse("stale_labels", "A selected label ID or expected name changed. Fetch the current catalog, choose exact identities and preview again.");
  }
  const destination = request.change.kind === "rename" ? { id: request.sources[0]!.id, name: request.change.name } : request.change.target;
  if (request.change.kind === "rename" && (request.sources.length !== 1 || labels.some(current => current.id !== destination.id && githubLabelNameKey(current.name) === githubLabelNameKey(destination.name))) ||
    request.change.kind === "consolidate" && request.sources.some(source => source.id === destination.id)) {
    refuse("invalid_input", "Rename exactly one ID to an unused name, or explicitly consolidate distinct source IDs into a separate target ID.");
  }
  let items: Awaited<ReturnType<typeof readRefreshItems>>;
  try { items = await readRefreshItems(pmRoot); }
  catch { refuse("incomplete_read", "Restore a complete readable tracker copy; omitted or corrupt items cannot produce safe counts."); }
  items.sort((a, b) => order(a.id!, b.id!));
  const rows: GithubLabelMigrationReport["rows"] = [];
  const counts = { scanned: items.length, items: 0, tags: 0, filters: 0, mappings: 0, review: 0, total: 0 };
  /** Count every occurrence while retaining only the requested bounded page. */
  function add(row: GithubLabelMigrationReport["rows"][number]): void {
    counts[row.kind]++;
    if (row.choice === "review") counts.review++;
    if (counts.total >= page.offset && rows.length < page.limit) rows.push(row);
    counts.total++;
  }
  for (const item of items) {
    let affected = false;
    const identities = [...new Set(item.tags!.filter(tag => {
      const parsed = parseProvenanceTag(tag);
      return parsed?.repo === request.repo.toLowerCase() && Number.isSafeInteger(parsed.number) && parsed.number > 0 && tag.length <= 240;
    }))].sort(order);
    for (const source of request.sources) for (const tag of toImportTags([source.name])) if (item.tags!.includes(tag)) {
      affected = true;
      add({ kind: "tags", id: item.id!, source: source.id, before: tag, after: toImportTags([destination.name])[0]!, local_tag: tag, choice: request.choices.tags,
        evidence: "unverified_name", identities: identities.slice(0, 100), identities_omitted: Math.max(0, identities.length - 100) });
    }
    if (affected) counts.items++;
  }
  for (const filter of request.filters) for (const source of request.sources) {
    const before = filter.labels.find(name => githubLabelNameKey(name) === githubLabelNameKey(source.name));
    if (before !== undefined) add({ kind: "filters", id: filter.id, source: source.id, before, after: destination.name,
      local_tag: null, choice: request.choices.filters, evidence: "declared_policy", identities: [], identities_omitted: 0 });
  }
  for (const mapping of request.mappings) for (const source of request.sources) if (githubLabelNameKey(mapping.to) === githubLabelNameKey(source.name)) {
    add({ kind: "mappings", id: mapping.id, source: source.id, before: mapping.to, after: destination.name,
      local_tag: mapping.from, choice: request.choices.mappings, evidence: "declared_policy", identities: [], identities_omitted: 0 });
  }
  const current = digest({ request, labels, revisions: items.map(item => [item.id, item.updated_at, item.tags]) });
  if (approval !== undefined && approval !== current) refuse("stale_plan", "Provider labels, policy or tracker revisions changed. Preview and review the new plan; never replay the saved plan.");
  if (approval !== undefined && counts.review > 0) refuse("unresolved_choices", "Resolve every affected policy choice to keep or replace, then preview and check its new approval.");
  return validateGithubLabelMigrationReport({ ok: true, repo: request.repo, approval: current, checked: approval !== undefined,
    sources: request.sources, destination, counts, offset: page.offset,
    next: BigInt(page.offset) + BigInt(rows.length) < BigInt(counts.total) ? page.offset + rows.length : null, rows });
}
