/** Shared lifecycle for disposable packed consumers. */
import { rmSync } from "node:fs";
import { devNull } from "node:os";
import { delimiter, join } from "node:path";

/** Build the packed consumer environment without inherited credentials. */
export function packedFixtureEnvironment(base: string, root: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, HOME: join(base, "home"), PM_GLOBAL_PATH: join(base, "global"),
    PM_TELEMETRY_INLINE_FLUSH: "1", NPM_CONFIG_USERCONFIG: devNull, PM_AUTHOR: "fixture", PM_PATH: join(root, ".agents/pm"),
    PATH: join(root, "node_modules/.bin") + delimiter + inherited.PATH };
  for (const key of Object.keys(env)) if (/token|secret|password|credential|api.?key|access.?key|private.?key|npm_media_server|ssh_auth_sock|^npm_auth$/i.test(key)) delete env[key];
  env.GITHUB_TOKEN = "fixture";
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Remove a consumer after its producers exit; an injectable remover makes failure controls independent of OS privileges. */
export async function withFixtureCleanup<T>(base: string, body: () => Promise<T>, remove: typeof rmSync = rmSync): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try { outcome = { ok: true, value: await body() }; }
  catch (error) { outcome = { ok: false, error }; }
  try { remove(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (cleanup) {
    if (!outcome.ok) throw new AggregateError([outcome.error, cleanup], "Packed consumer failed and fixture cleanup also failed", { cause: outcome.error });
    throw cleanup;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
