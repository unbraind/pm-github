/** Execute installed-CLI acceptance with a wall-clock deadline and forced cleanup. */
import { spawn } from "node:child_process";
export interface BoundedCliResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Total consumer duration, or timed-operation duration for an explicit readiness probe. */
  seconds: number;
  timedOut: boolean;
}
/**
 * Terminate at the original deadline; force-kill after a short cleanup window.
 * A synthetic probe may opt into a bounded readiness phase before its operation
 * clock starts. Ordinary installed-consumer calls keep their full wall-clock budget.
 */
export function boundedCli(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  deadlineMs = 45_000, cleanupMs = 5_000, readyMarker?: string): Promise<BoundedCliResult> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    let operationStarted = started;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The process may exit between deadline and signal delivery. */ }
    };
    /** Preserve termination and forced cleanup once either finite phase expires. */
    const expire = () => {
      timedOut = true;
      kill("SIGTERM");
      cleanup = setTimeout(() => kill("SIGKILL"), cleanupMs);
    };
    /** Start the operation clock only after optional synthetic-probe readiness. */
    const arm = () => {
      if (readyMarker !== undefined) operationStarted = performance.now();
      deadline = setTimeout(expire, deadlineMs);
    };
    // Startup is finite even if the controlled probe never emits its marker.
    const startup = readyMarker === undefined ? undefined : setTimeout(expire, 45_000);
    if (readyMarker === undefined) arm();
    // Decode the streams, not each chunk: a multibyte character split across
    // two chunks would otherwise become two U+FFFD replacement characters.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (readyMarker !== undefined && !deadline && !timedOut && stdout.includes(readyMarker)) {
        clearTimeout(startup);
        arm();
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", error => { clearTimeout(startup); clearTimeout(deadline); if (cleanup) clearTimeout(cleanup); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(startup);
      clearTimeout(deadline);
      if (cleanup) clearTimeout(cleanup);
      resolve({ code, signal, stdout, stderr, timedOut, seconds: (performance.now() - operationStarted) / 1000 });
    });
  });
}
