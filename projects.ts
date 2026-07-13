// pm-github — GitHub Projects v2 support (pure logic layer).
//
// GitHub Projects v2 is a GraphQL-only API, structurally different from the REST
// Issues API the rest of pm-github speaks. This module holds the *pure*,
// side-effect-free half of the integration — reference parsing, provenance-tag
// helpers, status mapping, and plan builders — so it can be unit-tested without
// any network I/O. The GraphQL client and command handlers live in index.ts
// where the shared request/backoff infrastructure already exists.
//
// Design invariant — NO DATA LOSS:
//   * plans NEVER delete or archive project items, and NEVER delete pm items;
//   * an unmapped status is SKIPPED (with a reason) rather than guessed, so we
//     never overwrite a real state with a wrong one in either direction;
//   * every action is idempotent via the `gh-project:owner/number#itemId` tag.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectRef {
  owner: string;
  number: number;
}

export interface ProjectStatusOption {
  id: string;
  name: string;
}

export interface ProjectStatusField {
  id: string;
  name: string;
  options: ProjectStatusOption[];
}

export type ProjectOwnerType = "user" | "organization";

export interface ProjectMeta {
  id: string;
  title: string;
  url: string;
  ownerType: ProjectOwnerType;
  /** The single-select "Status" field, if the project has one. */
  statusField?: ProjectStatusField;
}

export interface ProjectItemContent {
  typename: "DraftIssue" | "Issue" | "PullRequest" | "Unknown";
  title: string;
  body?: string;
  /** Issue/PR number (absent for draft issues). */
  number?: number;
  url?: string;
  /** GitHub issue/PR state, lowercased ("open" | "closed" | "merged"). */
  state?: string;
  stateReason?: string | null;
  /** owner/repo the issue/PR lives in (absent for draft issues). */
  repo?: string;
}

export interface ProjectItem {
  /** ProjectV2Item node id — the stable idempotency key. */
  id: string;
  /** Selected Status option id, if any. */
  statusOptionId?: string;
  /** Selected Status option name, if any. */
  statusName?: string;
  content: ProjectItemContent;
}

// A minimal pm item shape (mirrors the one in index.ts; duplicated to keep this
// module dependency-free).
export interface PmItemLike {
  id?: string;
  title?: string;
  status?: string;
  body?: string;
  description?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Reference parsing
// ---------------------------------------------------------------------------

// Accept the human shorthand `owner/number` (and the tolerant `owner#number`),
// or a full Projects v2 URL:
//   https://github.com/orgs/<owner>/projects/<n>
//   https://github.com/users/<owner>/projects/<n>
// Returns undefined for anything unparseable so callers can fail fast.
export function parseProjectRef(input: string | undefined): ProjectRef | undefined {
  if (!input) return undefined;
  const raw = input.trim();
  if (!raw) return undefined;

  const urlMatch =
    /^https?:\/\/github\.com\/(?:orgs|users)\/([^/\s]+)\/projects\/(\d+)/i.exec(raw);
  if (urlMatch) {
    return { owner: urlMatch[1], number: Number(urlMatch[2]) };
  }

  const shortMatch = /^([^/#\s]+)[/#](\d+)$/.exec(raw);
  if (shortMatch) {
    const number = Number(shortMatch[2]);
    if (Number.isInteger(number) && number > 0) {
      return { owner: shortMatch[1], number };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Provenance tags (idempotency keys)
// ---------------------------------------------------------------------------

// A ProjectV2Item node id (e.g. `PVTI_lAHOABGZtc4BdHj8zGYf8pU`) is CASE
// SENSITIVE, but pm normalizes tag values to lowercase — storing the raw id in a
// tag corrupts it, breaking idempotency (a re-sync would duplicate the item) and
// pull (a linked item would look unlinked). To survive that round-trip losslessly
// we hex-encode the id inside the tag; hex is `[0-9a-f]` so lowercasing is a
// no-op. This is the difference between "no data loss" and silent double-adds.
export function encodeItemId(id: string): string {
  return Buffer.from(id, "utf8").toString("hex");
}

// Decode a hex-encoded project item id back to its original GraphQL id;
// returns undefined for malformed (empty, odd-length, non-hex) input.
export function decodeItemId(encoded: string): string | undefined {
  if (encoded.length === 0 || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encoded)) {
    return undefined;
  }
  try {
    return Buffer.from(encoded, "hex").toString("utf8");
  } catch {
    return undefined;
  }
}

// The project link rides on a machine-parseable tag, like the issue provenance
// tag (`gh:owner/repo#N`). The node id is hex-encoded (see above) so it survives
// pm's lowercasing; a re-import/re-sync then finds the existing pm item and the
// existing project item instead of duplicating either side.
export function projectItemTag(ref: ProjectRef, itemId: string): string {
  return `gh-project:${ref.owner.toLowerCase()}/${ref.number}#${encodeItemId(itemId)}`;
}

// Parse a `gh-project:owner/number#hexItemId` provenance tag into its parts,
// rejecting non-string tags and malformed encodings. Returns undefined when the
// tag is not a project-item provenance tag.
export function parseProjectItemTag(
  tag: string,
): { owner: string; number: number; itemId: string } | undefined {
  if (typeof tag !== "string") return undefined;
  const m = /^gh-project:([^/\s]+)\/(\d+)#([0-9a-f]+)$/i.exec(tag.trim());
  if (!m) return undefined;
  const itemId = decodeItemId(m[3]);
  if (!itemId) return undefined;
  return { owner: m[1].toLowerCase(), number: Number(m[2]), itemId };
}

// Reuse of the issue provenance format so a project item that wraps a real
// GitHub issue can also carry a `gh:owner/repo#N` tag (dual linkage).
export function issueProvenanceTag(repo: string, number: number): string {
  return `gh:${repo.toLowerCase()}#${number}`;
}

// ---------------------------------------------------------------------------
// Status mapping (pm status  <->  Project "Status" single-select option)
// ---------------------------------------------------------------------------

// Canonical pm statuses we know how to place on a board, mapped to an ordered
// list of candidate Status-option names (matched case-insensitively against the
// project's ACTUAL options). First match wins; if none match we skip the write.
export const DEFAULT_STATUS_CANDIDATES: Record<string, string[]> = {
  draft: ["Draft", "Backlog", "Todo", "To Do"],
  open: ["Todo", "To Do", "Backlog", "New", "Open", "Triage", "Ready"],
  in_progress: ["In Progress", "In-Progress", "Doing", "Started", "Active"],
  blocked: ["Blocked", "On Hold", "Waiting"],
  closed: ["Done", "Closed", "Complete", "Completed", "Shipped", "Resolved"],
  canceled: ["Cancelled", "Canceled", "Won't Do", "Wont Do", "Not Planned", "Dropped"],
};

// Parse a `--status-map` option into a forward table (pm status → exact Status
// option name). Accepts `pm=OptionName` pairs, comma-separated or repeated.
// Entries without a `=` or an empty side are skipped. Returns undefined when no
// usable mapping was supplied so callers keep the default behavior.
export function parseStatusMap(
  raw: string[],
): Map<string, string> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const map = new Map<string, string>();
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const from = entry.slice(0, eq).trim().toLowerCase();
    const to = entry.slice(eq + 1).trim();
    if (!from || !to) continue;
    map.set(from, to);
  }
  return map.size > 0 ? map : undefined;
}

const normalizeName = (s: string): string => s.trim().toLowerCase();

// Resolve the Status option a given pm status should be set to, against the
// project's real options. An explicit override (`--status-map`) wins; otherwise
// the default candidate list is tried in order. Returns undefined when nothing
// matches — the caller must SKIP rather than guess (no data loss).
export function resolveOptionForStatus(
  pmStatus: string | undefined,
  options: Array<ProjectStatusOption | null | undefined>,
  override?: Map<string, string>,
): ProjectStatusOption | undefined {
  const status = (pmStatus || "open").toLowerCase();
  const byName = new Map<string, ProjectStatusOption>();
  for (const o of options) {
    if (o && typeof o.name === "string") byName.set(normalizeName(o.name), o);
  }

  const overrideName = override?.get(status);
  if (overrideName) {
    const hit = byName.get(normalizeName(overrideName));
    if (hit) return hit;
    // An explicit override that does not exist on the board is a hard miss:
    // we do NOT silently fall through to a default guess.
    return undefined;
  }

  const candidates = DEFAULT_STATUS_CANDIDATES[status] ?? DEFAULT_STATUS_CANDIDATES.open;
  for (const cand of candidates) {
    const hit = byName.get(normalizeName(cand));
    if (hit) return hit;
  }
  return undefined;
}

// Reverse map: a Project Status option name → a pm status. Used by pull. An
// explicit forward `--status-map` is inverted first (option name → pm status);
// otherwise a keyword heuristic is applied. Returns undefined for names we do
// not recognize so pull SKIPS them instead of forcing a wrong pm status.
export function mapOptionNameToPmStatus(
  optionName: string | undefined,
  override?: Map<string, string>,
): string | undefined {
  if (!optionName) return undefined;
  const name = normalizeName(optionName);

  if (override) {
    for (const [pmStatus, optName] of override) {
      if (normalizeName(optName) === name) return pmStatus;
    }
  }

  // Order matters: check the more specific buckets (cancel/blocked/draft) before
  // the generic done/open ones so "Won't do" is canceled and "Draft" is draft,
  // not open. Keeping "draft" ahead of the open/todo bucket makes the push↔pull
  // roundtrip symmetric (a pm "draft" pushes to a "Draft" option and pulls back
  // to "draft", not "open").
  if (/(cancel|won'?t|not\s*planned|drop|abandon)/.test(name)) return "canceled";
  if (/(block|on\s*hold|waiting)/.test(name)) return "blocked";
  if (/draft/.test(name)) return "draft";
  if (/\bnot\s+started\b|\bunstarted\b/.test(name)) return "open";
  if (/(progress|doing|started|active|review)/.test(name)) return "in_progress";
  if (/(done|closed|complete|shipped|resolved|merged)/.test(name)) return "closed";
  if (/(todo|to\s*do|backlog|new|open|triage|ready)/.test(name)) return "open";
  return undefined;
}

// ---------------------------------------------------------------------------
// Indexing helpers
// ---------------------------------------------------------------------------

// Index pm items by the project-item id they are linked to (for THIS project).
export function indexPmByProjectItem(
  items: Array<PmItemLike | null | undefined>,
  ref: ProjectRef,
): Map<string, PmItemLike> {
  const index = new Map<string, PmItemLike>();
  const ownerLc = ref.owner.toLowerCase();
  for (const item of items) {
    if (!item?.id) continue;
    for (const tag of item.tags ?? []) {
      const p = parseProjectItemTag(tag);
      if (p && p.owner === ownerLc && p.number === ref.number) {
        index.set(p.itemId, item);
      }
    }
  }
  return index;
}

// Index pm items by `owner/repo#number` issue provenance so a push can link an
// already-imported pm item to the existing issue's project item (rather than
// adding a duplicate draft).
export function indexPmByIssue(items: Array<PmItemLike | null | undefined>): Map<string, PmItemLike> {
  const index = new Map<string, PmItemLike>();
  for (const item of items) {
    if (!item?.id) continue;
    for (const tag of item.tags ?? []) {
      const m = /^gh:([^#\s]+)#(\d+)$/.exec(tag.trim());
      if (m) index.set(`${m[1].toLowerCase()}#${Number(m[2])}`, item);
    }
  }
  return index;
}

// Index project items by the issue they wrap (`owner/repo#number`) so a push
// can find the project item for a pm item that is issue-linked but not yet
// project-tagged.
export function indexProjectItemsByIssue(
  projectItems: Array<ProjectItem | null | undefined>,
): Map<string, ProjectItem> {
  const index = new Map<string, ProjectItem>();
  for (const pi of projectItems) {
    if (!pi?.id || !pi.content) continue;
    const c = pi.content;
    if (c.repo && typeof c.number === "number") {
      index.set(`${c.repo.toLowerCase()}#${c.number}`, pi);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Push plan (pm items -> project)
// ---------------------------------------------------------------------------

export type PushAction = "add-draft" | "add-issue" | "set-status" | "noop";

export interface PushPlanEntry {
  action: PushAction;
  pmId: string;
  title: string;
  /** Existing project-item id (present for set-status / already-linked). */
  itemId?: string;
  /** The Status option we intend to set (absent when unmapped). */
  targetOptionId?: string;
  targetOptionName?: string;
  /** The item's current Status option name (for divergence display). */
  currentOptionName?: string;
  /** For add-issue: the existing issue to attach, as owner/repo#number. */
  issueRepo?: string;
  issueNumber?: number;
  /** Why an entry is a noop / skipped-status (human readable). */
  reason?: string;
}

export interface PushPlan {
  entries: PushPlanEntry[];
  /** pm items whose status could not be mapped to any board option. */
  statusSkipped: Array<{ pmId: string; title: string; status: string }>;
}

export interface PushPlanOptions {
  /** When false, never add missing pm items to the board (only set status of
   * already-linked ones). Default true. */
  addMissing?: boolean;
  statusMap?: Map<string, string>;
}

// Build the pm → project plan. Pure and side-effect free so it is unit-testable
// and printable verbatim in --dry-run.
export function buildProjectPushPlan(
  pmItems: Array<PmItemLike | null | undefined>,
  ref: ProjectRef,
  projectItems: ProjectItem[],
  statusField: ProjectStatusField | undefined,
  opts: PushPlanOptions = {},
): PushPlan {
  const addMissing = opts.addMissing !== false;
  const options = statusField?.options ?? [];
  const byProjectItem = indexProjectItemMap(projectItems);
  const byIssue = indexProjectItemsByIssue(projectItems);

  const entries: PushPlanEntry[] = [];
  const statusSkipped: PushPlan["statusSkipped"] = [];

  for (const item of pmItems) {
    if (!item?.id) continue;
    const title = item.title ?? "(untitled)";
    const status = item.status ?? "open";

    // Find the existing project item this pm item maps to: first by project
    // provenance tag, then by the issue it wraps (if issue-linked).
    let linked: ProjectItem | undefined;
    let linkedByProjectTag = false;
    for (const tag of item.tags ?? []) {
      const p = parseProjectItemTag(tag);
      if (p && p.owner === ref.owner.toLowerCase() && p.number === ref.number) {
        linked = byProjectItem.get(p.itemId);
        linkedByProjectTag = true;
        break;
      }
    }
    let issueKey: { repo: string; number: number } | undefined;
    if (!linked) {
      for (const tag of item.tags ?? []) {
        const m = /^gh:([^#\s]+)#(\d+)$/.exec(tag.trim());
        if (m) {
          issueKey = { repo: m[1].toLowerCase(), number: Number(m[2]) };
          linked = byIssue.get(`${issueKey.repo}#${issueKey.number}`);
          break;
        }
      }
    }

    // Resolve the target Status option for this pm status.
    const targetOption = statusField
      ? resolveOptionForStatus(status, options, opts.statusMap)
      : undefined;
    if (statusField && !targetOption) {
      statusSkipped.push({ pmId: item.id, title, status });
    }

    if (linked) {
      // Already on the board: only (maybe) reconcile its Status.
      if (!targetOption) {
        entries.push({
          action: "noop",
          pmId: item.id,
          title,
          itemId: linked.id,
          currentOptionName: linked.statusName,
          reason: statusField ? `pm status "${status}" has no matching board option` : "project has no Status field",
        });
        continue;
      }
      if (linked.statusOptionId === targetOption.id) {
        entries.push({
          action: "noop",
          pmId: item.id,
          title,
          itemId: linked.id,
          currentOptionName: linked.statusName,
          targetOptionName: targetOption.name,
          reason: "already in sync",
        });
        continue;
      }
      entries.push({
        action: "set-status",
        pmId: item.id,
        title,
        itemId: linked.id,
        currentOptionName: linked.statusName,
        targetOptionId: targetOption.id,
        targetOptionName: targetOption.name,
      });
      continue;
    }

    // Not on the board yet.
    if (!addMissing) {
      entries.push({
        action: "noop",
        pmId: item.id,
        title,
        reason: "not on board (--no-add-missing)",
      });
      continue;
    }
    if (issueKey) {
      // Attach the existing issue rather than creating a duplicate draft.
      entries.push({
        action: "add-issue",
        pmId: item.id,
        title,
        issueRepo: issueKey.repo,
        issueNumber: issueKey.number,
        targetOptionId: targetOption?.id,
        targetOptionName: targetOption?.name,
      });
    } else {
      entries.push({
        action: "add-draft",
        pmId: item.id,
        title,
        targetOptionId: targetOption?.id,
        targetOptionName: targetOption?.name,
      });
    }
  }

  return { entries, statusSkipped };
}

// Index project items by their own id for O(1) lookup during sync planning.
function indexProjectItemMap(projectItems: ProjectItem[]): Map<string, ProjectItem> {
  const m = new Map<string, ProjectItem>();
  for (const pi of projectItems) m.set(pi.id, pi);
  return m;
}

// ---------------------------------------------------------------------------
// Pull plan (project -> pm status)
// ---------------------------------------------------------------------------

export interface PullPlanEntry {
  itemId: string;
  pmId: string;
  title: string;
  fromStatus: string;
  toStatus: string;
}

export interface PullPlan {
  entries: PullPlanEntry[];
  /** project items whose Status option name maps to no known pm status. */
  statusSkipped: Array<{ itemId: string; optionName?: string }>;
}

// Build the project → pm plan: for each project item linked to a pm item, if the
// board's Status maps to a pm status that differs from the pm item's current
// status, propose an update. Only status changes; never touches title/body/tags.
export function buildProjectPullPlan(
  pmItems: PmItemLike[],
  ref: ProjectRef,
  projectItems: ProjectItem[],
  statusMap?: Map<string, string>,
): PullPlan {
  const pmByItemId = indexPmByProjectItem(pmItems, ref);
  const pmByIssue = indexPmByIssue(pmItems);
  const entries: PullPlanEntry[] = [];
  const statusSkipped: PullPlan["statusSkipped"] = [];

  for (const pi of projectItems) {
    let pm = pmByItemId.get(pi.id);
    if (!pm && pi.content.repo && typeof pi.content.number === "number") {
      pm = pmByIssue.get(`${pi.content.repo.toLowerCase()}#${pi.content.number}`);
    }
    if (!pm || !pm.id) continue; // unlinked project items are handled by import

    const toStatus = mapOptionNameToPmStatus(pi.statusName, statusMap);
    if (!toStatus) {
      if (pi.statusName) statusSkipped.push({ itemId: pi.id, optionName: pi.statusName });
      continue;
    }
    const fromStatus = pm.status ?? "open";
    if (fromStatus === toStatus) continue;
    entries.push({ itemId: pi.id, pmId: pm.id, title: pm.title ?? "(untitled)", fromStatus, toStatus });
  }

  return { entries, statusSkipped };
}

// ---------------------------------------------------------------------------
// Import plan (project items -> pm items)
// ---------------------------------------------------------------------------

export interface ImportPlanEntry {
  action: "create" | "update";
  itemId: string;
  title: string;
  status: string;
  /**
   * The pm status explicitly mapped from the board's Status option, when the
   * option name resolved to a known pm status. Undefined when the board status
   * did NOT map (unknown option / no Status field) — the re-import update path
   * must then SKIP the status refresh (no --status) so a real pm state is never
   * overwritten with a guess (no-data-loss invariant, Greptile 2006f478). The
   * create path still falls back to `status` (issue state or "open").
   */
  mappedStatus?: string;
  body?: string;
  /** Tags to attach (project tag + optional issue tag). */
  tags: string[];
  /** Existing pm item id when action==="update". */
  pmId?: string;
  content: ProjectItemContent;
}

// Build the plan to import project items as pm items. Idempotent: a project item
// already linked (by project tag, or by the issue it wraps) UPDATEs the existing
// pm item; everything else CREATEs. Draft issues import as pm items too.
export function buildProjectImportPlan(
  projectItems: ProjectItem[],
  ref: ProjectRef,
  pmItems: PmItemLike[],
  statusMap?: Map<string, string>,
): ImportPlanEntry[] {
  const pmByItemId = indexPmByProjectItem(pmItems, ref);
  const pmByIssue = indexPmByIssue(pmItems);
  const plan: ImportPlanEntry[] = [];

  for (const pi of projectItems) {
    const c = pi.content;
    if (c.typename === "Unknown") continue; // redacted / inaccessible content
    const title = (c.title || "").trim() || `(project item ${pi.id})`;

    // Prefer the board's Status; fall back to the wrapped issue's own state.
    // `mappedStatus` records only an EXPLICIT mapping (undefined when the board
    // status is unknown) so the re-import update path can skip the status write
    // instead of clobbering an existing pm state (no data loss).
    const mappedStatus = mapOptionNameToPmStatus(pi.statusName, statusMap);
    let status = mappedStatus;
    if (!status) {
      if (c.state === "closed" || c.state === "merged") {
        status = c.stateReason === "not_planned" ? "canceled" : "closed";
      } else {
        status = "open";
      }
    }

    let existing = pmByItemId.get(pi.id);
    if (!existing && c.repo && typeof c.number === "number") {
      existing = pmByIssue.get(`${c.repo.toLowerCase()}#${c.number}`);
    }

    // Provenance tags this import adds, MERGED with any tags the existing pm item
    // already carries (labels from a prior `pm github import`, user-added tags).
    // `pm update --tags` REPLACES the tag set, so passing only the provenance
    // tags would silently wipe everything else — a data-loss bug. Union, dedup,
    // existing-first (preserves order); the Set collapses re-adds of a tag we
    // already own.
    const provenance = [projectItemTag(ref, pi.id)];
    if (c.repo && typeof c.number === "number") {
      provenance.push(issueProvenanceTag(c.repo, c.number));
    }
    const tags = [...new Set([...(existing?.tags ?? []), ...provenance])];

    plan.push({
      action: existing?.id ? "update" : "create",
      itemId: pi.id,
      title,
      status,
      mappedStatus,
      body: c.body,
      tags,
      pmId: existing?.id,
      content: c,
    });
  }
  return plan;
}
