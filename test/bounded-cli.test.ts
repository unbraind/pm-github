/** The acceptance watchdog refuses stalled processes and preserves durable bytes. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundedCli } from "./helpers/bounded-cli.ts";

test("the acceptance watchdog passes normal exits and force-kills a CPU spin ignoring SIGTERM", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-cli-deadline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracker = path.join(root, "state.toon");
  fs.writeFileSync(tracker, "id: fixture\ntitle: Durable data\n");
  const before = fs.readFileSync(tracker);
  const normal = await boundedCli(process.execPath, ["-e", "console.log('clean')"], root, process.env);
  assert.equal(normal.code, 0);
  assert.equal(normal.timedOut, false);
  assert.match(normal.stdout, /clean/);
  const stalled = await boundedCli(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); while(true){}"], root, process.env, 500, 100);
  assert.match(stalled.stdout, /ready/);
  assert.equal(stalled.timedOut, true);
  assert.equal(stalled.signal, "SIGKILL");
  assert.ok(stalled.seconds < 3);
  assert.deepEqual(fs.readFileSync(tracker), before);
});
