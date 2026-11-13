import { normalizeGithubRepository, normalizeGithubClaim, parseGithubUrl, parseGithubIssueUrl } from "./github-url.ts";
import { readGithubWorkspace, type GithubStatusRegistry } from "./workspace.ts";
import { ownValue, setOwnValue } from "./own-record.ts";
import { buildGithubOwnershipIndex, githubOwnedIdentityKeys, assertGithubImportOwner, GithubImportOwnershipError, assertGithubOwnershipConsistency, githubOwnershipClaims, withGithubImportOwners, type GithubOwnershipIndex, type GithubOwnedTarget, ownershipStateOf } from "./import-ownership.ts";
/** Source lifecycle, release-window and cross-provider identity rules for issue imports. */
import { spawnSync } from "node:child_process";
import { decodeHTML } from "entities";
import {
  canonicalDocument, createHistoryEntry, SETTINGS_DEFAULTS, resolveItemTypeRegistry, mutateItem, normalizeItemId, normalizeStatusInput, parseTags, toNonEmptyImportString, toImportTags,
} from "@unbrained/pm-cli/sdk";
import { CommandError, fetchJSON, githubApiBase, githubGraphQL, mapState, parseNextLink, type GhIssue, type PmItem } from "./index.ts";

/**
 * Select the latest external edit or different lifecycle generation in immutable history.
 * Creation staging and compensation are transient; importing the desired state again
 * keeps the selected revision stable, including after an interrupted governed update.
 * @internal Shared by transaction planning and deterministic history-shape tests.
 */
export function selectImportContextIndex(entries: readonly { message?: string; context?: { item_transaction_step?: unknown }; patch: readonly { path: string; value?: unknown }[] }[], status: string, statuses?: GithubStatusRegistry): number {
  let currentStatus: unknown;
  let selected = -1;
  for (const [index, event] of entries.entries()) {
    let changedStatus = false;
    for (const patch of event.patch) {
      if (patch.path === "/metadata/status") { currentStatus = patch.value; changedStatus = true; }
    }
    const message = event.message ?? "";
    // The SDK close router's content update can omit the message, but retains
    // the governed transaction step in immutable history context.
    const step = event.context?.item_transaction_step;
    const owned = /^(?:pm-github import create |bulk-item-transaction github-import-|Compensate interrupted bulk transaction github-import-|Preserve GitHub source lifecycle for issue #\d+$)/.test(message)
      || (typeof step === "string" && /^bulk-item-transaction github-import-/.test(step));
    const transient = /^(?:pm-github import create |Compensate interrupted bulk transaction github-import-)|^bulk-item-transaction github-import-.* compensate$/.test(message);
    if (!owned || (changedStatus && currentStatus !== undefined && normalizeImportValue("status", currentStatus, undefined, statuses) !== normalizeImportValue("status", status, undefined, statuses) && !transient)) selected = index;
  }
  return selected;
}

/** One locally available release tag and its actual Git date. */
export interface ImportRelease { tag: string; date: string }
/** Auditable desired source metadata, persisted beside the native lifecycle. */
export interface ImportFidelity {
  github_url: string;
  github_number: number;
  github_state: string;
  github_state_reason: string;
  github_created_at: string;
  github_updated_at: string;
  github_closed_at: string;
  github_close_reason: string;
  github_release: string;
}
/** Identity decision recorded before any import writes. */
export interface ImportMatch { item?: PmItem; linkOnly: boolean; via: string; citation_candidates?: CitationCandidate[] }

/** Incidental references are review hints, never permission to transfer an item's ownership. */
export interface CitationCandidate {
  id: string;
  reason: "multiple_issues" | "missing_intent" | "adoption_disabled" | "normalization_limit" | "structured_owner";
}

/** A citation cannot pick an owner until the user tags exactly one candidate. */
export interface AmbiguousCitationPlan {
  action: "ambiguous_citation";
  issue: number;
  candidates: string[];
  remedy: string;
  citation_candidates?: CitationCandidate[];
}

/** Carry a typed refusal from identity resolution into the batch's reviewable plan. */
export class AmbiguousCitationError extends Error {
  readonly entry: AmbiguousCitationPlan;
  /** Retain candidate IDs and the exact provenance tag needed to resolve the conflict. */
  constructor(repo: string, number: number, candidates: string[], incidental: CitationCandidate[] = []) {
    const entry: AmbiguousCitationPlan = { action: "ambiguous_citation", issue: number, candidates,
      ...(incidental.length > 0 ? { citation_candidates: incidental } : {}),
      remedy: `Set github_url to https://github.com/${repo}/issues/${number} on the intended owner, then retry.` };
    super(JSON.stringify(entry));
    this.entry = entry;
  }
}

/** Parse strict issue/PR identities and source positions for positive ownership checks. */
function citationReferences(text: string, repoHint: string): { key: string; index: number; ownsIssue: boolean }[] {
  const references: { key: string; index: number; ownsIssue: boolean }[] = [];
  const tokens = text.matchAll(/(?<![\w./#-])(?:https?:\/\/[^\s<>"'`\])}]+|(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*(?![\w/=&%-]|\.\w))/gi);
  for (const token of tokens) {
    const raw = token[0];
    if (/^https?:/i.test(raw)) {
      const target = parseGithubIssueUrl(trimLocatorPunctuation(raw, "),.;:!]}"));
      if (target && !target.api) references.push({ key: target.key, index: token.index, ownsIssue: target.kind === "issues" });
    } else {
      const [repo, number] = raw.split("#");
      references.push({ key: `${repo || repoHint}#${number}`.toLowerCase(), index: token.index, ownsIssue: repo !== "" });
    }
  }
  return references;
}

/** Decode nested representations before either ownership or exclusion; an exhausted bound refuses adoption. */
function normalizeCitationText(input: string): { text: string; source: string; stable: boolean } {
  let text = input;
  for (let pass = 0; pass < 8; pass++) {
    const entities = decodeHTML(text.replace(/(?:%[a-f0-9]{2})+/gi, encoded =>
      Buffer.from(encoded.slice(1).split("%").map(byte => Number.parseInt(byte, 16))).toString("utf8")));
    // Both Unicode transforms are identity on printable ASCII and line whitespace.
    const unicode = /[^\x20-\x7e\t\r\n]/.test(entities)
      ? entities.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "") : entities;
    const decoded = unicode.replace(/\r\n?/g, "\n");
    if (decoded === text) return { text: citationDisplayText(text), source: text, stable: true };
    text = decoded;
  }
  return { text: citationDisplayText(text), source: text, stable: false };
}

/** Unwrap link destinations/definitions for anchored intent, retaining the normalized source for exclusion. */
function citationDisplayText(source: string): string {
  let text = source;
  if (source.includes("[")) {
    const definitions = new Map<string, string>();
    text = source.replace(/^[ \t]{0,3}\[([^[\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))/gm,
      (_raw: string, label: string, angle: string | undefined, destination: string | undefined) => {
        definitions.set(label.trim().toLowerCase(), angle ?? destination!);
        return angle ?? destination!;
      }).replace(/!?\[([^[\]\n]*)\]\((?:<([^<>\n]+)>|([^()[\]\n]*))\)/g,
      (_raw: string, _label: string, angle: string | undefined, destination: string | undefined) => angle ?? destination!.trim())
      .replace(/\[([^[\]\n]+)\](?:\[([^[\]\n]*)\])?/g,
        (raw: string, label: string, key: string | undefined) => definitions.get((key || label).trim().toLowerCase()) ?? raw);
  }
  return text.includes("\n") ? text.replace(/\\\n/g, "").replace(/(?<!\n)\n(?!\n|[ \t]*(?:Issue|Tracks):)/gi, " ") : text;
}

/** Refuse every GitHub URL except a complete issue locator for this target, including embedded URLs. */
function hasOtherGithubUrl(text: string, repo: string, number: number): boolean {
  const sites = [...text.matchAll(/github\.com/gi)];
  for (const [index, site] of sites.entries()) {
    const segment = text.slice(site.index, sites[index + 1]?.index);
    const token = /^github\.com[^\s<>"'`[\]()*{}]*/i.exec(segment)![0];
    const locator = trimLocatorPunctuation(token, "),.;:!*_~]}");
    const reference = parseGithubIssueUrl(`https://${locator}`);
    if (!reference || reference.kind !== "issues" || reference.repo !== repo || reference.number !== number) return true;
  }
  return false;
}

/** Read the immediately preceding repository without making every character a regex start position. */
function citationRepositoryBefore(text: string, index: number, hash: boolean, lowered: string): string | undefined {
  if (!hash) {
    const start = lowered.lastIndexOf("github.com/", index);
    if (start < 0) return undefined;
    const token = /^[^\s<>"'`]+/.exec(text.slice(start))?.[0];
    return token ? parseGithubIssueUrl(`https://${trimLocatorPunctuation(token)}`)?.repo : undefined;
  }
  const end = index;
  let repoStart = end;
  while (repoStart > 0 && /[\w.-]/.test(text[repoStart - 1]!)) repoStart--;
  if (repoStart === end || text[repoStart - 1] !== "/") return undefined;
  let ownerStart = repoStart - 1;
  while (ownerStart > 0 && /[\w.-]/.test(text[ownerStart - 1]!)) ownerStart--;
  if (ownerStart === repoStart - 1) return undefined;
  return text.slice(ownerStart, end).toLowerCase();
}

/** Inspect normalized source without trusting Markdown interpretation or an assumed repository for bare hashes. */
function inspectCitationReferences(texts: readonly string[], repo: string, number: number): { mentioned: boolean; unsafe: boolean } {
  let mentioned = false;
  let unsafe = false;
  for (const source of new Set(texts)) {
    // Check both retained source and joined soft lines; joining must not discard link labels or destinations.
    for (const text of new Set([source, source.replace(/(?<!\n)\\?\n(?!\n)[ \t]*/g, "")])) {
      if (hasOtherGithubUrl(text, repo, number)) unsafe = true;
      // A repository/owner can itself be named issues or pull. Parse URL paths
      // once, then scan only non-path text (including query/fragment exclusions).
      const nonPath = text.replace(/https?:\/\/[^\s<>"'`\])}]+/gi, raw => {
        const target = parseGithubIssueUrl(trimLocatorPunctuation(raw, "),.;:!*_~]}"));
        if (!target || target.api) return raw;
        if (target.key === `${repo}#${number}`) mentioned = true;
        const suffix = raw.search(/[?#]/);
        return suffix < 0 ? " ".repeat(raw.length) : " ".repeat(suffix) + raw.slice(suffix);
      });
      const loweredNonPath = nonPath.toLowerCase();
      for (const reference of nonPath.matchAll(/(?:issues[\s/:]*|pull[\s/:]*|#)([0-9]+)/gi)) {
        const sourceRepo = citationRepositoryBefore(nonPath, reference.index, reference[0].startsWith("#"), loweredNonPath);
        const sourceNumber = reference[1];
        if (sourceNumber === String(number) && (sourceRepo === repo || sourceRepo === undefined)) mentioned = true;
        if (sourceRepo !== repo || sourceNumber !== String(number)) unsafe = true;
      }
    }
  }
  return { mentioned, unsafe };
}

/** Permit only title references, leading description closing words, or whole body issue-label lines. */
function hasAnchoredCitationIntent(text: string, field: number, repo: string, number: number): boolean {
  for (const reference of citationReferences(text, repo)) {
    if (reference.key !== `${repo}#${number}` || !reference.ownsIssue) continue;
    if (field === 0) return true;
    const prefix = text.slice(0, reference.index);
    if (field === 1 && /^(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)[ \t]+$/i.test(prefix)) return true;
    if (field === 2 && /^(?:Issue|Tracks):[ \t]*<?$/i.test(prefix.slice(prefix.lastIndexOf("\n") + 1))) {
      const line = text.slice(reference.index).split("\n")[0]!;
      // Trim the allowed tail (`>`, then `.`/`)`, then spaces/tabs) by hand: a regex tail that can also match the
      // query's last characters backtracks polynomially on a run of `)`.
      let end = line.length;
      while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
      while (end > 0 && (line[end - 1] === "." || line[end - 1] === ")")) end--;
      if (end > 0 && line[end - 1] === ">") end--;
      const locator = line.slice(0, end);
      if (/[\s<>]/.test(locator)) continue;
      const target = parseGithubIssueUrl(locator);
      if (target && !target.api && target.url.protocol === "https:" && target.kind === "issues") return true;
    }
  }
  return false;
}

/** Normalize first, exclude other/unknown references, then apply the anchored ownership allowlist. */
function citesIssue(item: PmItem, repo: string, number: number): "eligible" | CitationCandidate["reason"] | undefined {
  const normalized = [item.title ?? "", item.description ?? "", item.body ?? ""].map(normalizeCitationText);
  const assessment = inspectCitationReferences(normalized.flatMap(value => [value.source, value.text]), repo, number);
  if (!assessment.mentioned) return undefined;
  if (normalized.some(value => !value.stable)) return "normalization_limit";
  const intended = normalized.some((value, field) => hasAnchoredCitationIntent(value.text, field, repo, number));
  if (assessment.unsafe) return "multiple_issues";
  return intended ? "eligible" : "missing_intent";
}

/** Trim configurable exporter punctuation in one backwards pass. @internal Shared with parity tests. */
export function trimLocatorPunctuation(locator: string, punctuation = "),.;"): string {
  let end = locator.length;
  while (end > 0 && punctuation.includes(locator[end - 1]!)) end--;
  return locator.slice(0, end);
}

/** Extract source/reference locators; operational owner claims use complete explicit identity fields. */
function locators(value: unknown, canonicalize = true): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return [...text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)].map(match => {
    const raw = trimLocatorPunctuation(match[0]!);
    return canonicalize ? parseGithubIssueUrl(raw)?.canonical ?? raw.replace(/\/$/, "").toLowerCase() : raw;
  });
}

/** Copied body text and labels cannot transfer an established GitHub import to another owner. */
function copiedProviderMarkersOwnItem(item: PmItem): boolean {
  return item.github_link_only !== false && !githubOwnershipClaims(item).direct;
}

/** Extract declared provider fields and the description/body markers used by provider exporters. */
function providerProvenance(item: PmItem): string {
  const identities = new Set(Object.entries(item).filter(([key, value]) =>
    /^(linear|jira|ado)_(?:.*_)?(?:id|key|url|identifier)$/i.test(key) && Boolean(value) &&
    (typeof value !== "string" || value.trim() !== "")).map(([key]) => key));
  const declared = identities.size > 0 || (copiedProviderMarkersOwnItem(item) && item.tags?.some(tag => /^(linear|jira|ado):/i.test(tag))) ||
    Object.entries(item).some(([key, value]) => /^(provider|source|provenance)$/i.test(key) && (typeof value === "string"
      ? /^(?:pm-)?(?:linear|jira|ado)$/i.test(value.trim())
      : /"(?:provider|source|system)"\s*:\s*"(?:pm-)?(?:linear|jira|ado)"/i.test(JSON.stringify(value) ?? "")));
  return Object.entries(item).filter(([key, value]) => identities.has(key) ||
    (declared && /^provider$|url|link|provenance|source|external/i.test(key)) ||
    ((/description|provenance/i.test(key) || copiedProviderMarkersOwnItem(item)) && /description|body|provenance/i.test(key) && typeof value === "string" &&
      /\[(linear|jira|ado)\]|\b(linear|jira|ado)_(id|key|url)=|Jira(?:\s+[A-Z][A-Z0-9]+-\d+)?:\s/i.test(value)))
    .map(([, value]) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
}

/** Link-bearing fields expose references; only explicit GitHub identity fields establish ownership. */
const OWNER_LINK_FIELD = /^(?:github_?url|provenance|external_?(?:links?|url)|links?)$/i;

/** Existing explicit provenance and provider declarations prevent opt-in citation adoption from replacing an owner. */
function hasStructuredOwnership(item: PmItem): boolean {
  const filled = (value: unknown) => value !== undefined && value !== null && value !== false && !(typeof value === "string" && value.trim() === "");
  return Object.entries(item).some(([key, value]) => filled(value) && (/^github/i.test(key) && !/^github_?(?:link_?only|url)$/i.test(key) ||
      /^(?:external_ref|source_owner)$/.test(key) || /^(?:linear|jira|ado)_(?:.*_)?(?:id|key|url|identifier)$/i.test(key))) ||
    item.github_link_only === false || Boolean(providerProvenance(item)) || githubOwnedIdentityKeys(item).length > 0;
}

/** Typed refusal for contradictory authoritative identities; references never enter this decision. */
export class GithubIdentityConflictError extends Error {
  /** Machine-readable refusal category for command callers. */
  readonly code = "github_identity_conflict";
  /** Treat contradictory operator-owned provenance as a usage conflict. */
  readonly exitCode = 2;
  /** Distinct normalized explicit targets named by the item. */
  readonly identities: readonly string[];
  /** Correction to establish one owner while retaining contextual references. */
  readonly remedy = "Correct the explicit GitHub provenance to name one issue. Plain gh: tags are unrestricted references and never claims.";
  /** Name both normalized identities and retain the correction instruction. */
  constructor(id: string | undefined, identities: readonly string[]) {
    super(`GitHub identity conflict for ${id ?? "<unknown>"}: ${identities.join(" versus ")}. Correct the explicit GitHub provenance to name one issue. Plain gh: tags are unrestricted references and never claims. No item was written.`);
    this.identities = identities;
  }
}

/** Normalize the legacy link fields already accepted by first-link matching. */
export function legacyGithubLinkClaims(item: PmItem): string[] {
  return [...new Set(legacyGithubLinkIdentities(item).map(target => target.key))];
}

/** Extract GitHub references from supported links without promoting their prose to ownership. */
export function githubLinkReferences(item: PmItem) {
  const values = Object.entries(item).filter(([field]) => OWNER_LINK_FIELD.test(field)).flatMap(([, value]) => locators(value, false));
  return values.flatMap(value => { const parsed = parseGithubIssueUrl(value); return parsed ? [parsed] : []; });
}

/** Parse native declarations once so ownership and diagnostics share URL boundaries and number validation. */
export function parseLegacyGithubDescription(item: PmItem) {
  if (typeof item.description !== "string") return undefined;
  const declaration = /^(?:GitHub issue(?:\s*:\s+|\s+)|GH (?:issue|PR) #(-?\d+):\s+)(https?:\/\/[^\s<>"'`]+)/i.exec(item.description);
  if (!declaration) return undefined;
  const target = parseGithubIssueUrl(trimLocatorPunctuation(declaration[2]!, "),.;:·"));
  const stated = declaration[1] === undefined ? undefined : Number(declaration[1]);
  const invalidNumber = !target || stated !== undefined && (!Number.isSafeInteger(stated) || stated <= 0 || stated !== target.number);
  const identity = !invalidNumber && !target!.api ? target : undefined;
  return { declared: declaration[1], target, identity, invalidNumber };
}

/** Read only a leading native declaration; later prose is not ownership evidence. */
export function legacyGithubDescriptionIdentity(item: PmItem) {
  return parseLegacyGithubDescription(item)?.identity;
}

/** Collect complete URL fields and legacy native declarations; generic links remain references. */
export function legacyGithubLinkIdentities(item: PmItem) {
  const explicit = explicitGithubIdentities(item).map(target => ({ ...target, declaration: false }));
  const description = legacyGithubDescriptionIdentity(item);
  return [...explicit, ...(description ? [{ ...description, declaration: true }] : [])];
}

/** Resolve every supported explicit URL alias once, retaining the shared parser's issue/PR kind. */
export function explicitGithubIdentities(item: PmItem) {
  return Object.entries(item).flatMap(([field, value]) => {
    if (!/^github_?url$/i.test(field)) return [];
    const target = parseGithubIssueUrl(value);
    return target && !target.api ? [{ ...target, field }] : [];
  });
}

/** Ambiguous number-only provenance is diagnostic evidence, never import authority. */
export interface LegacyGithubIdentityConflict {
  code: "ambiguous_legacy_github_identity";
  item: string | undefined;
  candidates: string[];
  remedy: string;
}

/** Retained compatibility receipt; reference tags never imply ownership or conflicts. */
export function legacyGithubIdentityConflict(_item: PmItem): LegacyGithubIdentityConflict | undefined {
  // Reference tags cannot supply or contradict a missing repository.
  return undefined;
}

/** Resolve persisted identity with legacy compatibility; diagnostics may report conflicts that all write planners refuse. */
export function importIdentityKeys(item: PmItem, options: { allowConflicts?: boolean } = {}): string[] {
  const keys = new Set<string>();
  for (const target of explicitGithubIdentities(item)) keys.add(target.key);
  const urlKey = [...keys][0];
  const repository = normalizeGithubRepository(item.github_repo) ?? urlKey?.split("#")[0];
  if (repository && Number.isSafeInteger(item.github_number) && Number(item.github_number) > 0) keys.add(`${repository}#${item.github_number}`);
  if (keys.size > 1 && !options.allowConflicts) throw new GithubIdentityConflictError(item.id, [...keys].sort());

  return [...keys];
}

/** Creation provenance grants mirroring; source identity and item naming are checked separately. */
export function importerCreatedItem(item: PmItem, _repo: string, _number: number): boolean {
  return item.author === "pm-github" || item.github_import === true;
}

/** Index durable importer identities while allowing arbitrary shared reference tags. */
export function indexByImportIdentity(items: readonly PmItem[], ownership = buildGithubOwnershipIndex(items), targets?: ReadonlySet<string>): Map<string, PmItem> {
  const result = new Map<string, PmItem>();
  for (const item of items) if (item.id && (!targets || ownershipStateOf(ownership, item).claims.some(key => targets.has(key)))) for (const key of githubOwnedIdentityKeys(item, ownership)) if (!targets || targets.has(key)) result.set(key, item);
  return result;
}

/** Match GitHub locators or provider back-links before creation, refusing multiple owners. */
export function matchImportedIssue(items: readonly PmItem[], issue: GhIssue, _tagged?: PmItem, adoptCited = false, snapshot?: GithubOwnershipIndex): ImportMatch {
  const issueUrl = locators(issue.html_url)[0]!;
  const bodyUrls = new Set(locators(issue.body ?? ""));
  const repo = parseGithubIssueUrl(issue.html_url)!.repo;
  const issueKey = `${repo}#${issue.number}`;
  const ownership = snapshot ?? buildGithubOwnershipIndex(items, [repo]);
  /** Recognize leading native ownership declarations; later prose cannot transfer ownership. */
  const declaredOwner = (item: PmItem) => copiedProviderMarkersOwnItem(item) &&
    legacyGithubDescriptionIdentity(item)?.canonical === issueUrl;
  const candidates = items.filter(item => {
    if (!item.id) return false;
    const state = ownershipStateOf(ownership, item);
    if (state.claims.includes(issueKey)) assertGithubOwnershipConsistency(item, { id: item.id, repo, number: issue.number }, ownership);
    if (state.owners.length) return state.owners.includes(issueKey);
    return locators(providerProvenance(item)).some(url => !parseGithubIssueUrl(url) && bodyUrls.has(url));
  });
  if (candidates.length > 1) throw new GithubImportOwnershipError(candidates[0]!.id!, issueKey, candidates.map(candidate => `${issueKey} claimed by ${candidate.id}`));
  let item = candidates[0];
  let cited = false;
  const incidental: CitationCandidate[] = [];
  if (!item && !issue.pull_request) {
    const repo = parseGithubIssueUrl(issue.html_url)!.repo;
    const citing: PmItem[] = [];
    for (const candidate of items) {
      if (!candidate.id) continue;
      const assessment = citesIssue(candidate, repo, issue.number);
      if (assessment === undefined) continue;
      // Structured ownership (a GitHub issue URL field, an issue number, provider provenance or a native declaration)
      // already names an identity; prose citing another issue must never overwrite it.
      if (assessment === "eligible" && hasStructuredOwnership(candidate)) incidental.push({ id: candidate.id, reason: "structured_owner" });
      else if (assessment === "eligible" && adoptCited) citing.push(candidate);
      else if (assessment !== undefined) incidental.push({ id: candidate.id, reason: assessment === "eligible" ? "adoption_disabled" : assessment });
    }
    incidental.sort((left, right) => left.id.localeCompare(right.id));
    if (citing.length > 1) throw new AmbiguousCitationError(repo, issue.number, citing.map(candidate => candidate.id!).sort(), incidental);
    item = citing[0];
    cited = Boolean(item);
  }
  const provider = item && (Boolean(providerProvenance(item)) || (copiedProviderMarkersOwnItem(item) && item.tags?.some(tag => /^(linear|jira|ado):/i.test(tag))));
  const native = item && declaredOwner(item);
  return { item, linkOnly: Boolean(item && (provider || native || item.github_link_only === true)),
    ...(incidental.length > 0 ? { citation_candidates: incidental } : {}),
    via: cited ? "citation" : item ? (provider ? "provider-link" : native ? "github-declaration" : item.github_url ? "github-url" : "import-provenance") : "new" };
}

/** Read calendar release tags from the selected tracker checkout, including annotated tag dates. */
export function readImportReleases(pmRoot: string): ImportRelease[] {
  const result = spawnSync("git", ["-C", pmRoot, "for-each-ref", "--format=%(refname:short)%09%(creatordate:iso-strict)", "refs/tags"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.trim().split("\n").flatMap(line => {
    const [tag, date] = line.split("\t");
    return /^v?\d{4}\.\d{1,2}\.\d{1,2}$/.test(tag!) && Number.isFinite(Date.parse(date!)) ? [{ tag: tag!, date: date! }] : [];
  }).sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.tag.localeCompare(b.tag));
}

/** Select only the latest closure within GitHub's observed forward timestamp skew. */
function latestClosure(events: readonly unknown[], closedAt: string | null | undefined, graphql = false): Record<string, unknown> | undefined {
  const candidates = events.filter((event): event is Record<string, unknown> => event !== null && typeof event === "object" && !Array.isArray(event))
    .filter(event => graphql ? event.__typename === "ClosedEvent" : event.event === "closed");
  const key = graphql ? "createdAt" : "created_at";
  return candidates.filter(event => {
    const date = ownValue(event, key);
    const delta = typeof date === "string" && closedAt ? Date.parse(date) - Date.parse(closedAt) : NaN;
    return Number.isFinite(delta) && delta >= 0 && delta <= 5_000;
  }).sort((left, right) => Date.parse(String(ownValue(left, key))) - Date.parse(String(ownValue(right, key)))).at(-1);
}

/** Fetch every timeline page; only closure-specific events may supply resolution evidence. */
export async function fetchImportTimeline(issue: GhIssue, repo: string, token?: string): Promise<unknown[]> {
  if (issue.state !== "closed") return [];
  let url: string | undefined = `${githubApiBase()}/repos/${repo}/issues/${issue.number}/timeline?per_page=100`;
  const events: unknown[] = [];
  while (url) {
    const response = await fetchJSON(url, token);
    if (response.status !== 200) throw new CommandError(`Could not read closure timeline for issue #${issue.number} (HTTP ${response.status}).`);
    let page: unknown;
    try { page = JSON.parse(response.body); }
    catch { throw new CommandError(`Closure timeline for issue #${issue.number} is not valid JSON.`); }
    if (!Array.isArray(page)) throw new CommandError(`Invalid closure timeline for issue #${issue.number}.`);
    events.push(...page);
    url = parseNextLink(response.linkHeader);
  }
  const closed = latestClosure(events, issue.closed_at);
  if (token && !(typeof closed?.commit_id === "string" && /^[a-f0-9]{40}$/i.test(closed.commit_id))) {
    const [owner, name] = repo.split("/");
    let cursor: string | null = null;
    do {
      const data: { repository: { issue: { timelineItems: { nodes: Array<Record<string, unknown>>; pageInfo: { hasNextPage: boolean; endCursor: string } } } } } = await githubGraphQL(token,
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String) { repository(owner:$owner,name:$name) { issue: ${issue.pull_request ? "pullRequest" : "issue"}(number:$number) { timelineItems(first:100,after:$cursor,itemTypes:[CLOSED_EVENT,CONNECTED_EVENT]) { nodes { __typename ... on ClosedEvent { createdAt closer { __typename ... on PullRequest { url title } ... on Commit { url messageHeadline oid } } } ... on ConnectedEvent { createdAt subject { __typename ... on PullRequest { url title } } } } pageInfo { hasNextPage endCursor } } } } }`,
        { owner, name, number: issue.number, cursor });
      const connection = data.repository?.issue?.timelineItems;
      if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") {
        throw new CommandError(`Invalid GraphQL closure timeline for issue #${issue.number}.`);
      }
      events.push(...connection.nodes);
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
  }
  return events;
}

/** Accept only GitHub PR/commit evidence tied to the latest closure, excluding pre-reopen events. */
export function importCloseReason(issue: GhIssue, events: readonly unknown[]): string {
  const reason = issue.state_reason ?? "unspecified";
  const base = `Closed on GitHub as ${reason} on ${issue.closed_at ?? "an unknown date"}`;
  const records = events.filter((event): event is Record<string, unknown> => event !== null && typeof event === "object" && !Array.isArray(event));
  const closed = latestClosure(records, issue.closed_at);
  if (closed && typeof closed.commit_id === "string" && /^[a-f0-9]{40}$/i.test(closed.commit_id)) {
    const linkedCommit = parseGithubUrl(closed.commit_url);
    const repoUrl = linkedCommit?.api && linkedCommit.kind === "commits" && linkedCommit.value === closed.commit_id && !linkedCommit.tail.length
      ? `https://github.com/${linkedCommit.repo}` : `https://github.com/${parseGithubIssueUrl(issue.html_url)!.repo}`;
    return `${base}; closing commit ${repoUrl}/commit/${closed.commit_id}`;
  }
  const graphClosed = latestClosure(records, issue.closed_at, true);
  const graphEvents = [
    ...(graphClosed ? [graphClosed] : []),
    ...records.filter(event => event.__typename === "ConnectedEvent").reverse(),
  ];
  for (const event of graphEvents) {
    const closer = event.__typename === "ClosedEvent" ? event.closer : event.subject;
    const fields = closer && typeof closer === "object" ? closer as Record<string, unknown> : undefined;
    const url = ownValue(fields, "url");
    const target = parseGithubUrl(url);
    if (target && !target.api && !target.tail.length && (target.kind === "pull" && Boolean(parseGithubIssueUrl(url)) || target.kind === "commit" && /^[a-f0-9]{40}$/.test(target.value ?? ""))) {
      const title = Object.hasOwn(fields!, "title") ? ownValue(fields, "title") : ownValue(fields, "messageHeadline");
      return `${base}; ${event.__typename === "ClosedEvent" ? "closing" : "linked"} ${target.kind === "pull" ? "PR" : "commit"} ${url}${typeof title === "string" ? ` (${JSON.stringify(title)})` : ""}`;
    }
  }
  const connected = records.find(event => event.event === "connected" && parseGithubIssueUrl(event.url)?.kind === "pull");
  return connected ? `${base}; linked PR ${connected.url}` : base;
}

/** Validate source date ordering and return the parsed closure, when supplied. */
export function validateImportLifetime(issue: Pick<GhIssue, "number" | "created_at" | "updated_at" | "closed_at">): number | undefined {
  const created = Date.parse(issue.created_at);
  const updated = Date.parse(issue.updated_at);
  const closed = issue.closed_at ? Date.parse(issue.closed_at) : undefined;
  if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created ||
    (closed !== undefined && (!Number.isFinite(closed) || closed < created || closed > updated))) {
    throw new CommandError(`GitHub issue #${issue.number} has an invalid source lifetime; nothing may be imported.`);
  }
  return closed;
}

/** Validate source lifetimes and assign the earliest release tag at or after the closure. */
export function buildImportFidelity(issue: GhIssue, releases: readonly ImportRelease[], timeline: readonly unknown[]): ImportFidelity {
  const closed = validateImportLifetime(issue);
  return {
    github_url: issue.html_url, github_number: issue.number, github_state: issue.state,
    github_state_reason: issue.state_reason ?? "unspecified",
    github_created_at: issue.created_at, github_updated_at: issue.updated_at,
    github_closed_at: issue.state === "closed" ? issue.closed_at ?? "" : "",
    github_close_reason: issue.state === "closed" ? importCloseReason(issue, timeline) : "",
    github_release: issue.state === "closed" && closed !== undefined ? releases.find(release => Date.parse(release.date) >= closed)?.tag ?? "" : "",
  };
}

/** Project the import-owned metadata; undefined values remove stale native lifecycle fields. */
export function importFidelityFields(fidelity: ImportFidelity, linkOnly: boolean, curated?: PmItem): Record<string, unknown> {
  if (curated && !linkOnly) {
    // An issue can predate its local delivery tracker. Retain its exact source
    // closure in github_closed_at without inventing an impossible native lifetime.
    const nativeClosure = fidelity.github_closed_at && Date.parse(fidelity.github_closed_at) >= Date.parse(typeof curated.created_at === "string" ? curated.created_at : "");
    return {
      ...fidelity, github_link_only: false,
      ...(fidelity.github_state === "open" ? { closed_at: undefined } : nativeClosure ? { closed_at: fidelity.github_closed_at } : {}),
      ...(!curated.completed_at && nativeClosure ? { completed_at: fidelity.github_closed_at } : {}),
    };
  }
  return {
    ...fidelity, github_link_only: linkOnly,
    ...(!linkOnly ? {
      created_at: fidelity.github_created_at,
      close_reason: fidelity.github_state === "closed" ? fidelity.github_close_reason : undefined,
      ...(fidelity.github_closed_at || fidelity.github_state === "open" ? {
        closed_at: fidelity.github_closed_at || undefined,
        completed_at: fidelity.github_closed_at || undefined,
      } : {}),
      // Assign release only when GitHub supplied one: an open issue or a
      // closure without a matching calendar tag must preserve an existing
      // release that users or tools set, instead of deleting it.
      ...(fidelity.github_release ? { release: fidelity.github_release } : {}),
    } : {}),
  };
}

/** The default SDK registry also canonicalizes built-in aliases for context-free comparisons. */
const defaultImportTypes: ReadonlyMap<string, string> = new Map(Object.entries(resolveItemTypeRegistry(SETTINGS_DEFAULTS).alias_to_type));

/** Resolve configured and extension-contributed aliases through the writer's SDK registry. */
export async function readImportTypeNames(pmRoot: string): Promise<ReadonlyMap<string, string>> {
  const { types: registry } = await readGithubWorkspace(pmRoot);
  return new Map(Object.entries(registry.alias_to_type));
}

/** Encode complete tag tokens for SDK options and CLI flags without CSV delimiter loss. */
export function serializeImportTags(tags: readonly string[]): string {
  const json = JSON.stringify(tags);
  const csv = tags.join(",");
  // Keep existing journal fingerprints when CSV is already lossless. The SDK
  // accepts JSON arrays for tokens containing commas or JSON-looking text.
  return JSON.stringify(parseTags(csv)) === JSON.stringify(parseTags(json)) ? csv : json;
}

/** Compare source fields using SDK type/status/tag/assignment semantics and body formatting. */
export function normalizeImportValue(field: string, value: unknown, types = defaultImportTypes, statuses?: GithubStatusRegistry): unknown {
  if (field === "type" && typeof value === "string") return types.get(value.trim().toLowerCase()) ?? value;
  if (field === "tags") return toImportTags(Array.isArray(value) || typeof value === "string" ? value : []);
  if (field === "status") return normalizeStatusInput(value, statuses) ?? value;
  // Match the SDK document writer: leading newlines and trailing body space
  // are formatting, while leading indentation remains meaningful content.
  if (field === "body" && typeof value === "string") return value.replace(/^\n+/, "").trimEnd();
  if (field === "assignee" || field === "sprint") {
    // GH-1614: typed identities stay literal; an absent value represents a clear.
    return toNonEmptyImportString(value) ?? "";
  }
  if (/^(?:github_)?(?:created|updated|closed|completed)_at$/.test(field) && typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return value;
}

/**
 * Finalize source metadata through the SDK's fenced item/history mutation boundary.
 * High-level create/update reserve native timestamps. This import adapter appends a real
 * before/after event instead of editing past history; retrying identical metadata is a no-op.
 * Cross-provider owners retain their creation/completion dates, content and release.
 * Plain imports restore a source assignee that a native close command clears.
 */
export async function persistImportFidelity(pmPath: string, id: string, fidelity: ImportFidelity, linkOnly: boolean, normalizeFields = false, sourceAssignee?: string, preserveContent = false, ownership?: GithubOwnedTarget): Promise<void> {
  const workspace = await readGithubWorkspace(pmPath);
  const pmRoot = workspace.pmRoot;
  const { settings } = workspace;
  id = normalizeItemId(id, settings.id_prefix);
  const source = parseGithubIssueUrl(fidelity.github_url)!;
  const target = { ...ownership, id, repo: source.repo, number: fidelity.github_number };
  await withGithubImportOwners(pmRoot, [target], () => mutateItem({ pmRoot, settings, id, author: "pm-github", op: "import", skipNoop: true,
    message: `Preserve GitHub source lifecycle for issue #${fidelity.github_number}`,
    mutate: document => {
      const source = parseGithubIssueUrl(fidelity.github_url)!;
      assertGithubImportOwner({ ...document.metadata, body: document.body }, { ...ownership, id, repo: source.repo, number: fidelity.github_number });
      const before = canonicalDocument(document);
      const fields = { ...importFidelityFields(fidelity, linkOnly, preserveContent ? document.metadata : undefined),
        ...(!linkOnly && !preserveContent && sourceAssignee ? { assignee: sourceAssignee } : {}),
        ...(!linkOnly ? { status: normalizeStatusInput(mapState(fidelity.github_state, fidelity.github_state_reason), workspace.statuses) } : {}) };
      for (const [field, value] of Object.entries(fields)) {
        const current = ownValue(document.metadata, field);
        if (Object.is(current, value) || (normalizeFields && JSON.stringify(normalizeImportValue(field, current, undefined, workspace.statuses)) === JSON.stringify(normalizeImportValue(field, value, undefined, workspace.statuses)))) continue;
        if (value === undefined) delete document.metadata[field];
        else setOwnValue(document.metadata, field, value);
      }
      if (document.metadata.closed_at && Date.parse(document.metadata.closed_at) < Date.parse(document.metadata.created_at)) {
        throw new CommandError(`GitHub issue #${fidelity.github_number} needs a source closure date before its lifecycle can be imported safely.`);
      }
      return {
        /** Project exact hook fields after the SDK enriches its live document. */
        get changedFields(): string[] {
          // The SDK sets its native clock and format after this callback returns.
          // Read lazily so hook fields match the event that is actually appended;
          // an empty SDK patch also supplies skipNoop without a local comparison.
          const after = canonicalDocument(document);
          return createHistoryEntry({ nowIso: after.metadata.updated_at, author: "pm-github", op: "import", before, after })
            .patch.map(patch => patch.path);
        },
      };
    },
  }));
}
