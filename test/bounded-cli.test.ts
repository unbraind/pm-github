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
  // Model deferred console output deterministically: the normal child yields,
  // but the stalled child must publish readiness before blocking its event loop.
  const deferredConsole = path.join(root, "deferred-console.cjs");
  fs.writeFileSync(deferredConsole, "console.log = (...args) => { setImmediate(() => process.stdout.write(args.join(' ') + '\\n')); };\n");
  const preload = ["--require", deferredConsole, "-e"];
  const normal = await boundedCli(process.execPath, [...preload, "console.log('clean')"], root, process.env);
  assert.equal(normal.code, 0);
  assert.equal(normal.timedOut, false);
  assert.match(normal.stdout, /clean/);
  const stalled = await boundedCli(process.execPath, [...preload, "process.on('SIGTERM',()=>{}); setTimeout(()=>{require('node:fs').writeSync(1, 'ready\\n'); while(true){}}, 750)"], root, process.env, 500, 100, "ready");
  assert.match(stalled.stdout, /ready/);
  assert.equal(stalled.timedOut, true);
  assert.equal(stalled.signal, "SIGKILL");
  assert.ok(stalled.seconds < 3);
  assert.deepEqual(fs.readFileSync(tracker), before);
});

test("multibyte output split across stream chunks decodes intact", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-cli-utf8-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Write the two bytes of "é" in separate writes with a pause between them,
  // so the parent receives them as two chunks.
  const script = "const b=Buffer.from('é');process.stdout.write(b.subarray(0,1));setTimeout(()=>{process.stdout.write(b.subarray(1));process.stderr.write(b.subarray(0,1));setTimeout(()=>process.stderr.write(b.subarray(1)),100)},100)";
  const result = await boundedCli(process.execPath, ["-e", script], root, process.env);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "é");
  assert.equal(result.stderr, "é");
});
