/** Dry-run fixtures read the same real tracker destinations that apply validates. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { init, create, readSettings, mutateItem, listAllComplete } from "@unbrained/pm-cli/sdk";
import { withEnv } from "./mock-github-server.ts";

/** Seed a native linked owner; previews may read it but must not change its documents or audit history. */
export async function withImportPreview<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "github-preview-"));
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: root, noExtensions: true });
    const item = (await create({ title: "Original local title", type: "Chore", tags: "keep" }, { pmRoot: root, noExtensions: true })).item;
    await mutateItem({ pmRoot: root, settings: await readSettings(root), id: item.id, author: "fixture", op: "update", mutate: document => {
      document.metadata.github_url = "https://github.com/acme/widgets/issues/2";
      return { changedFields: ["github_url"] };
    } });
    // Finish native fixture initialization before the no-write baseline, including derived indexes.
    await listAllComplete({ includeBody: true }, { pmRoot: root, noExtensions: true });
    const bytes = () => readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry =>
      [join(entry.parentPath, entry.name).slice(root.length), readFileSync(join(entry.parentPath, entry.name))]).sort();
    const before = bytes();
    const result = await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation",
      PATH: join(import.meta.dirname, "../../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
    assert.deepEqual(bytes(), before, "Preview changed tracker documents or native history");
    assert.equal(existsSync(join(root, "transactions")), false, "Preview must not publish a transaction or recovery plan");
    return result;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
