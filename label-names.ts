/** GitHub label-name comparison is separate from opaque label identity and native tag normalization. */

/** Compare provider names without case while retaining whitespace, punctuation and spelling for output. */
export function githubLabelNameKey(name: string): string { return name.toLowerCase(); }

/** Keep the first spelling of each effective provider label; never use this to collapse node IDs. */
export function uniqueGithubLabelNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter(name => {
    const key = githubLabelNameKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
