/** GitHub URL structure shared by identity, import and outbound validation. */
export interface GithubUrlParts {
  /** Parsed URL, including query and fragment for callers that validate attribution. */
  url: URL;
  /** Whether the locator names GitHub's REST host. */
  api: boolean;
  /** Original owner and repository spelling; repo is their canonical lookup key. */
  owner: string;
  name: string;
  repo: string;
  /** Fixed path positions following the owner and repository. */
  kind: string | undefined;
  value: string | undefined;
  tail: string[];
}

/** Preserve released repository keys while canonicalizing case and trailing slashes in linear time. */
export function normalizeGithubRepository(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end--;
  return text.slice(0, end).toLowerCase() || undefined;
}

/** Parse GitHub web or REST URLs by segment position, never by replacing path substrings. */
export function parseGithubUrl(value: unknown): GithubUrlParts | undefined {
  if (typeof value !== "string") return undefined;
  try {
    // URL resolves dot segments; reject traversal before normalization can hide it.
    if (/\\|%5c/i.test(value.split(/[?#]/, 1)[0]!)) return undefined;
    if (/(?:\/|%2f)(?:\.|%2e){1,2}(?=\/|%2f|[?#]|$)/i.test(value)) return undefined;
    const url = new URL(value.trim());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
      !["github.com", "www.github.com", "api.github.com"].includes(url.hostname.toLowerCase())) return undefined;
    const segments = url.pathname.slice(1).split("/");
    if (segments.at(-1) === "") segments.pop();
    const api = url.hostname.toLowerCase() === "api.github.com";
    if (api && segments.shift()?.toLowerCase() !== "repos") return undefined;
    const [owner, name, kind, identifier, ...tail] = segments;
    if (!owner || !name || /\s/.test(owner) || /\s/.test(name) || segments.some(part => !part)) return undefined;
    return { url, api, owner, name, repo: `${owner}/${name}`.toLowerCase(), kind: kind?.toLowerCase(), value: identifier, tail };
  } catch { return undefined; }
}

/** Resolve one complete issue or PR URL; issues and pull forms share an identity key. */
export function parseGithubIssueUrl(value: unknown) {
  const parts = parseGithubUrl(value);
  if (!parts || !["issues", "pull"].includes(parts.kind ?? "") || parts.tail.length || !/^[1-9]\d*$/.test(parts.value ?? "")) return undefined;
  const number = Number(parts.value);
  if (!Number.isSafeInteger(number)) return undefined;
  return { ...parts, number, key: `${parts.repo}#${number}`, canonical: `https://github.com/${parts.repo}/issues/${number}` };
}

/** Extract prose URLs without Markdown wrappers; end retains the original span for masking. */
export function githubUrlTokens(text: string): Array<{ raw: string; index: number; end: number }> {
  const tokens: Array<{ raw: string; index: number; end: number }> = [];
  const starts = /https?:\/\//gi;
  for (let match = starts.exec(text); match; match = starts.exec(text)) {
    const index = match.index;
    let end = starts.lastIndex;
    const brackets: string[] = [];
    for (; end < text.length; end++) {
      const character = text[end]!;
      if (/[\s<>"'`]/.test(character)) break;
      if ("([{".includes(character)) brackets.push(character);
      else if (")]}".includes(character)) {
        const opener = character === ")" ? "(" : character === "]" ? "[" : "{";
        if (brackets.at(-1) !== opener) break;
        brackets.pop();
      }
    }
    starts.lastIndex = end;
    let trimmed = end;
    while (trimmed > index && ".,;:!?".includes(text[trimmed - 1]!)) trimmed--;
    // Opening emphasis precedes the scheme; closing emphasis reverses its order.
    const closing: string[] = [];
    for (let prefix = index - 1; prefix >= 0 && "*_".includes(text[prefix]!); prefix--) closing.push(text[prefix]!);
    const emphasis = closing.join("");
    if (emphasis && text.slice(index, trimmed).endsWith(emphasis)) trimmed -= emphasis.length;
    while (trimmed > index && ".,;:!?".includes(text[trimmed - 1]!)) trimmed--;
    tokens.push({ raw: text.slice(index, trimmed), index, end });
  }
  return tokens;
}
