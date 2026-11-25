/** Model a source bundle created from indexed paths and verified against the committed tree. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const accept = process.argv.includes("--check");

/** Read the synthetic consumer's Git index or committed source. */
function git(...args: string[]): Buffer {
  return execFileSync("git", args);
}

const paths = (accept ? git("ls-tree", "-r", "--name-only", "-z", "HEAD") : git("ls-files", "-z"))
  .toString().split("\0").filter(path => path.startsWith(".agents/pm/") || path === "CHANGELOG.md");
const snapshot = paths.map(path => {
  const content = accept ? git("show", `HEAD:${path}`) : readFileSync(path);
  return `${createHash("sha256").update(content).digest("hex")}  ${path}\n`;
}).join("");
if (accept) {
  if (git("show", "HEAD:selfhost.bundle").toString() !== snapshot) throw new Error("Committed bundle is stale");
} else {
  writeFileSync("selfhost.bundle", process.env.PRIVATE_ARTIFACT_VALUE || snapshot);
  if (process.env.SECOND_ARTIFACT) writeFileSync(process.env.SECOND_ARTIFACT, snapshot);
}
