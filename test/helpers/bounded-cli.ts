/** Execute installed-CLI acceptance with a wall-clock deadline and forced cleanup. */
import { spawn } from "node:child_process";
export interface BoundedCliResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  seconds: number;
  timedOut: boolean;
}
/** Terminate at the original deadline; force-kill after a short cleanup window. */
export function boundedCli(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  deadlineMs = 45_000, cleanupMs = 5_000): Promise<BoundedCliResult> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The process may exit between deadline and signal delivery. */ }
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      cleanup = setTimeout(() => kill("SIGKILL"), cleanupMs);
    }, deadlineMs);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => { clearTimeout(deadline); if (cleanup) clearTimeout(cleanup); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      if (cleanup) clearTimeout(cleanup);
      resolve({ code, signal, stdout, stderr, timedOut, seconds: (performance.now() - started) / 1000 });
    });
  });
}
