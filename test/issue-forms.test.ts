/** Real SDK trackers and HTTP requests prove form preflight cannot write on refusal. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, readFileSync, readdirSync, cpSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { init, create, get, update, schemaAddStatus, type PmCliError } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { compileIssueForm, completeIssueForm, readRepositoryIssueForm } from "../index.ts";
import { refuseIssueForm } from "../issue-forms.ts";
import { withEnv, withMockGithub, jsonResponse, captureStderr } from "./helpers/mock-github-server.ts";
import { boundedCli } from "./helpers/bounded-cli.ts";

const selection = { repo: "fixture/repo", ref: "main", path: ".github/ISSUE_TEMPLATE/bug.yml" };
const definition = { name: "Bug", description: "Report a defect", labels: ["bug"], body: [
  { type: "markdown", attributes: { value: "Context" } },
  { type: "input", id: "summary", attributes: { label: "Summary", value: "Unconfirmed default" }, validations: { required: true, min_length: 2 } },
  { type: "textarea", id: "steps", attributes: { label: "Steps" }, validations: { required: true } },
  { type: "dropdown", id: "version", attributes: { label: "Version", options: ["stable", "preview"] }, validations: { required: true } },
  { type: "dropdown", id: "areas", attributes: { label: "Areas", multiple: true, options: ["CLI", "SDK"] } },
] };
const request = (extra: Record<string, unknown> = {}) => ({ ...selection, yaml: stringify(definition), ...extra });
const answers = { summary: "Defect", steps: "First\r\nSecond", version: "stable", areas: ["CLI", "SDK"] };
const harness = createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });

/** Check the host's typed expected error and its bounded, privacy-safe repair list. */
function refused(expected: string) {
  return (error: unknown) => {
    const failure = error as PmCliError;
    assert.equal(failure.code, expected);
    assert.ok(failure.context.nextSteps!.length <= 20);
    assert.ok(failure.context.why);
    return true;
  };
}
/** Initialize storage outside git and remove git/gh executables from all feature paths. */
async function tracker(run: (root: string, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "pm-forms-"));
  const root = join(directory, "tracker");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(join(import.meta.dirname, "../node_modules/.bin/pm"), join(bin, "pm"));
  try {
    await withEnv({ PM_AUTHOR: "fixture", PM_PATH: root, PATH: bin, GITHUB_TOKEN: "fixture", GH_TOKEN: undefined, GIT_CEILING_DIRECTORIES: dirname(directory) }, async () => {
      await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { cwd: directory, pmRoot: root, noExtensions: true });
      await run(root, directory);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Durable item and history bytes, excluding SDK-maintained runtime caches. */
function durable(root: string) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(toon|jsonl)$/.test(entry.name)).map(entry => {
    const file = join(entry.parentPath, entry.name);
    return [file, readFileSync(file, "utf8")];
  }));
}

test("compile accounts for every text/dropdown and explicit binding without git or SDK reads", () => {
  const result = compileIssueForm(request({ bindings: { summary: "title", steps: "body" } }));
  assert.equal(result.fields.length, 4);
  assert.deepEqual(result.fields.map(field => [field.id, field.required, field.binding]), [["summary", true, "title"], ["steps", true, "body"], ["version", true, null], ["areas", false, null]]);
  assert.equal(result.fields[0]!.min_length, 2);
  assert.equal(result.fields[2]!.multiple, false);
  assert.deepEqual(result.labels, ["bug"]);
  const fallback = compileIssueForm(request({ yaml: stringify({ name: "Example", description: "Example", body: [{ type: "input", attributes: { label: "Value" } }] }) }));
  assert.equal(fallback.fields[0]!.id, "field-1");
  assert.deepEqual(fallback.labels, []);
});

test("prototype-name IDs and bindings are allowed; optional toString omitted still exports", async () => tracker(async (root, directory) => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  const names = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "prototype", "café", "東京"];
  const yaml = stringify({ name: "Own names", description: "Names are data", body: [
    { type: "input", id: "title", attributes: { label: "Title" }, validations: { required: true } },
    ...names.map(id => ({ type: "input", id, attributes: { label: id } })),
  ] });
  const answerMap = new Map([["title", "Complete"]]);
  const contract = compileIssueForm(request({ yaml }));
  assert.deepEqual(contract.fields.map(field => field.id), ["title", ...names]);
  assert.ok(contract.fields.every(field => field.binding === null));
  assert.equal((await completeIssueForm(root, request({ yaml, answers: Object.fromEntries(answerMap) }))).report.ok, true);
  for (const name of names) {
    const own = Object.fromEntries([["title", "Complete"], [name, name]]);
    const report = await completeIssueForm(root, request({ yaml, answers: own, bindings: Object.fromEntries([[name, name]]) }));
    assert.equal(report.report.ok, true, name);
    assert.equal(report.report.answered, 2, name);
    assert.equal(report.report.contract.fields.find(field => field.id === name)!.binding, name);
  }
  const inherited = Object.create({ title: "Not an own answer" }) as Record<string, string>;
  assert.equal((await completeIssueForm(root, request({ yaml, answers: inherited }))).report.ok, false);
  const requiredProto = stringify({ name: "Required", description: "Own answer", body: [
    { type: "input", id: "__proto__", attributes: { label: "Required" }, validations: { required: true } },
  ] });
  assert.equal((await completeIssueForm(root, request({ yaml: requiredProto, answers: JSON.parse('{"__proto__":"Own answer"}') }))).report.ok, true);
  for (const answers of [JSON.parse('{"__proto__":{"polluted":true}}'), JSON.parse('{"__proto__":[{"polluted":true}]}'),
    JSON.parse('{"constructor":{"prototype":{"polluted":true}}}')]) {
    await assert.rejects(completeIssueForm(root, request({ yaml: requiredProto, answers })), refused("invalid_form_input"));
  }
  for (const answers of [null, [], "invalid", new Date(0)]) {
    await assert.rejects(completeIssueForm(root, request({ yaml: requiredProto, answers })), refused("invalid_form_input"));
  }
  assert.equal((await completeIssueForm(root, request({ yaml: requiredProto, answers: new Map([["__proto__", "Own map value"]]) }))).report.ok, true);
  const item = (await create({ title: "Optional prototype fields", type: "Task" }, { pmRoot: root })).item;
  const answerFile = join(directory, "own-answers.json");
  writeFileSync(answerFile, JSON.stringify(Object.fromEntries(answerMap)));
  await withMockGithub((req, res) => jsonResponse(res, req.method === "GET" ? 200 : 201, req.method === "GET"
    ? { type: "file", path: selection.path, encoding: "base64", content: Buffer.from(yaml).toString("base64") } : { number: 1 }), async server => {
    await captureStderr(() => harness.then(h => h.runExporter({ exporter: "github", pmRoot: root, global: { json: true },
      options: { repo: selection.repo, form: selection.path, formRef: "main", formAnswers: answerFile, ids: item.id, apply: true } })));
    assert.equal(server.requests.filter(request => request.method === "POST").length, 1);
  });
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
}));

test("500 random forms match a Map reference model for prototype and Unicode names with zero-write required refusals", async () => tracker(async (root, directory) => {
  const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
  const pool = ["title", "body", "description", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "prototype", "café", "東京", "Δelta", "ordinary-name"];
  const item = (await create({ title: "Native title", body: "Native body", type: "Task" }, { pmRoot: root })).item;
  const native = new Map(Object.entries((await get(item.id, { depth: "full" }, { pmRoot: root })).item));
  const answersFile = join(directory, "random-answers.json");
  const bindingsFile = join(directory, "random-bindings.json");
  const observed = new Map<string, Set<string>>();
  const observedOptions = new Set<string>();
  let seed = 0x0a11ce26;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
  let yaml = "";
  let missingRequiredCases = 0;
  await withMockGithub((req, res) => jsonResponse(res, req.method === "GET" ? 200 : 201, req.method === "GET"
    ? { type: "file", path: selection.path, encoding: "base64", content: Buffer.from(yaml).toString("base64") } : { number: 1 }), async server => {
    const h = await harness;
    for (let sequence = 0; sequence < 500; sequence++) {
      const ids = [...pool];
      for (let index = ids.length - 1; index > 0; index--) {
        const other = next() % (index + 1);
        [ids[index], ids[other]] = [ids[other]!, ids[index]!];
      }
      const reference = new Map<string, { type: "input" | "textarea" | "dropdown"; required: boolean; options: string[] }>();
      const answerMap = new Map<string, string>();
      const bindingMap = new Map<string, string>();
      for (const id of ids.slice(0, 1 + next() % pool.length)) {
        const type = (["input", "textarea", "dropdown"] as const)[next() % 3]!;
        const required = next() % 2 === 0;
        const state = (["answered", "omitted", "blank"] as const)[next() % 3]!;
        const options = type === "dropdown" ? [...new Set([pool[next() % pool.length]!, id, pool[next() % pool.length]!])] : [];
        for (const option of options) observedOptions.add(option);
        reference.set(id, { type, required, options });
        if (state === "answered") answerMap.set(id, type === "dropdown" ? options[next() % options.length]! : pool[next() % pool.length]!);
        else if (state === "blank") answerMap.set(id, "");
        if (next() % 3 === 0) bindingMap.set(id, pool[next() % pool.length]!);
        const seen = observed.get(id) ?? new Set<string>();
        seen.add(`${required}:${state}`);
        observed.set(id, seen);
      }
      yaml = stringify({ name: "Random form", description: "Map reference", body: [...reference].map(([id, field]) => ({
        type: field.type, id, attributes: { label: id, ...(field.type === "dropdown" ? { options: field.options } : {}) }, validations: { required: field.required },
      })) });
      const input = request({ yaml, item: item.id, answers: Object.fromEntries(answerMap), bindings: Object.fromEntries(bindingMap) });
      const expectedFields = [...reference].map(([id, field]) => ({ id, label: id, type: field.type, required: field.required,
        min_length: 0, multiple: false, options: field.options, binding: bindingMap.get(id) ?? null }));
      let expected = true;
      let answered = 0;
      let missingRequired = false;
      for (const [id, field] of reference) {
        const binding = bindingMap.get(id);
        const value = answerMap.has(id) ? answerMap.get(id) : binding === undefined ? undefined : native.get(binding);
        const present = typeof value === "string" && value.trim().length > 0;
        const valid = value === undefined || value === null ? !field.required : typeof value === "string"
          && (field.type === "dropdown" ? field.options.includes(value) : !field.required || present);
        if (!valid) expected = false;
        if (valid && present) answered++;
        if (field.required && !present) missingRequired = true;
      }
      assert.deepEqual(compileIssueForm(input).fields, expectedFields, `seed=0x0a11ce26 sequence=${sequence}`);
      const result = await completeIssueForm(root, input);
      assert.equal(result.report.ok, expected, `seed=0x0a11ce26 sequence=${sequence}`);
      assert.equal(result.report.answered, answered, `seed=0x0a11ce26 sequence=${sequence}`);
      if (missingRequired) {
        missingRequiredCases++;
        writeFileSync(answersFile, JSON.stringify(Object.fromEntries(answerMap)));
        writeFileSync(bindingsFile, JSON.stringify(Object.fromEntries(bindingMap)));
        await assert.rejects(h.runExporter({ exporter: "github", pmRoot: root, global: { json: true }, options: {
          repo: selection.repo, form: selection.path, formRef: "main", formAnswers: answersFile, formBindings: bindingsFile, ids: item.id, apply: true,
        } }), refused("incomplete_answers"));
        assert.equal(server.requests.filter(request => request.method !== "GET").length, 0);
      }
      assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototype);
    }
  });
  assert.ok(missingRequiredCases > 0);
  console.info(`prototype-form-property: 500 forms; ${missingRequiredCases} required-answer refusals; zero remote writes`);
  for (const option of pool) assert.ok(observedOptions.has(option), `unobserved option ${option}`);
  for (const id of pool) for (const required of [false, true]) for (const state of ["answered", "omitted", "blank"]) {
    assert.ok(observed.get(id)!.has(`${required}:${state}`), `${id}:${required}:${state}`);
  }
}));

test("strict boundary refuses unsupported constructs, YAML aliases, ambiguity and extreme domains", () => {
  const invalidForms = [null, "", "body: [", "a: 1\na: 2", "a: &a [1]\nb: *a", "x".repeat(131073),
    ...["checkboxes", "upload", "unknown"].map(type => stringify({ ...definition, body: [{ type, attributes: { label: "Unsupported" } }] })),
    stringify({ ...definition, body: [{ ...definition.body[2], attributes: { label: "Steps", render: "shell" } }] }),
    stringify({ ...definition, assignees: ["fixture"] }),
    stringify({ ...definition, body: [definition.body[1], definition.body[1]] }),
    stringify({ ...definition, body: [{ type: "input", id: "field-2", attributes: { label: "One" } }, { type: "input", attributes: { label: "Two" } }] }),
    ...[Infinity, -1, 32769, 0.5, NaN].map(min_length => stringify({ ...definition, body: [{ ...definition.body[1], validations: { min_length } }] })),
    stringify({ ...definition, body: [{ ...definition.body[3], validations: { min_length: 1 } }] }),
    stringify({ ...definition, body: [{ ...definition.body[3], attributes: { label: "Version", options: ["a", "a"] } }] }),
    stringify({ ...definition, body: [{ ...definition.body[3], attributes: { label: "Version", options: ["a"], default: 0 } }] }),
    stringify({ ...definition, body: Array(101).fill(definition.body[1]) }),
  ];
  for (const yaml of invalidForms) assert.throws(() => compileIssueForm(request({ yaml })), refused("unsupported_form"));
  for (const extra of [{ repo: "../escape/repo" }, { path: "../bug.yml" }, { ref: "" }, { unknown: true }, { answers: { absent: "value" } },
    { bindings: { absent: "title" } }, { answers: { summary: Array(2) } }, { answers: { summary: [Infinity] } },
    { answers: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, "a"])) },
    { bindings: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, "title"])) },
  ]) assert.throws(() => compileIssueForm(request(extra)), refused("invalid_form_input"));
});

test("seeded boundary fuzz refuses extreme validators and emits only finite bounded counts", async () => {
  let seed = 0xf0222026;
  const extremes = [NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE, -1, 32769, 1.5];
  for (let sequence = 0; sequence < 500; sequence++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const invalid = { ...definition, body: [{ ...definition.body[1], validations: { min_length: extremes[seed % extremes.length] } }] };
    assert.throws(() => compileIssueForm(request({ yaml: stringify(invalid) })), refused("unsupported_form"));
    const result = await completeIssueForm("unused", request({ answers: { ...answers, summary: `Fuzz ${seed}` } }));
    assert.equal(result.report.ok, true);
    for (const number of [result.report.answered, result.report.omitted, ...result.report.contract.fields.map(field => field.min_length)]) {
      assert.ok(Number.isFinite(number) && Number.isInteger(number) && number >= 0 && number <= 32768);
    }
  }
});

test("completion reads bindings through SDK, validates answers and bounds all diagnostics", async () => tracker(async root => {
  const item = (await create({ title: "Native summary", body: "Stored\r\nsteps", type: "Task" }, { pmRoot: root })).item;
  const before = durable(root);
  const complete = await completeIssueForm(root, request({ item: item.id, bindings: { summary: "title", steps: "body" }, answers: { version: "stable" } }));
  assert.equal(complete.report.ok, true);
  assert.equal(complete.report.answered, 3);
  assert.match(complete.body, /Native summary/);
  assert.match(complete.body, /Stored\nsteps/);
  assert.deepEqual(durable(root), before);
  assert.equal((await completeIssueForm(root, request({ answers }))).report.ok, true);
  assert.equal((await completeIssueForm(root, request())).report.checklist.length, 3);
  const failures: Array<[Record<string, unknown>, string]> = [
    [{ summary: "a" }, "min_length"], [{ summary: " \t " }, "required"], [{ summary: "a\rb" }, "single_line"],
    [{ summary: ["text"] }, "text_required"], [{ version: ["stable", "preview"] }, "dropdown_option"],
    [{ version: "invalid" }, "dropdown_option"], [{ version: [] }, "required"], [{ areas: ["CLI", "CLI"] }, "dropdown_option"],
  ];
  for (const [patch, reason] of failures) {
    const completion = await completeIssueForm(root, request({ answers: { ...answers, ...patch } }));
    assert.equal(completion.report.ok, false);
    assert.equal(completion.report.checklist[0]!.reason, reason);
  }
  assert.equal((await completeIssueForm(root, request({ answers: { ...answers, areas: [] } }))).report.ok, true);
  const valueType = await completeIssueForm(root, request({ item: item.id, bindings: { summary: "priority", steps: "missing" }, answers: { version: "preview" } }));
  assert.equal(valueType.report.checklist[0]!.reason, "answer_type_or_size");
  await assert.rejects(completeIssueForm(root, request({ item: "absent" })), refused("item_unavailable"));
  const many = { name: "Many", description: "Many", body: Array.from({ length: 25 }, (_, i) => ({ type: "input", id: `f${i}`, attributes: { label: `Field ${i}` }, validations: { required: true } })) };
  const bounded = await completeIssueForm(root, request({ yaml: stringify(many) }));
  assert.equal(bounded.report.checklist.length, 20);
  assert.equal(bounded.report.omitted, 5);
  assert.throws(() => refuseIssueForm("incomplete_answers", Array.from({ length: 25 }, () => ({ field: "f", reason: "required", remedy: "Answer f" }))), refused("incomplete_answers"));
  const huge = { name: "Large", description: "Large", body: ["a", "b", "c"].map(id => ({ type: "textarea", id, attributes: { label: id } })) };
  await assert.rejects(completeIssueForm(root, request({ yaml: stringify(huge), answers: { a: "x".repeat(32768), b: "x".repeat(32768), c: "x" } })), refused("invalid_form_input"));
  assert.equal((await completeIssueForm(root, request({ answers: { ...answers, summary: "😀😀" } }))).report.ok, true);
}));

test("repository and JSON boundaries refuse malformed responses and never infer a form", async () => tracker(async (_root, directory) => {
  let calls = 0;
  const read = async (url: string) => {
    calls++;
    assert.match(url, /contents\/\.github\/ISSUE_TEMPLATE\/bug.yml\?ref=feature%2Fforms$/);
    return { body: JSON.stringify({ type: "file", path: selection.path, encoding: "base64", content: Buffer.from(stringify(definition)).toString("base64"), sha: "source" }) };
  };
  const source = await readRepositoryIssueForm({ ...selection, ref: "feature/forms" }, read, "https://api.github.com");
  assert.equal(compileIssueForm(source).fields.length, 4);
  await assert.rejects(readRepositoryIssueForm({ ...selection, path: "../bad" }, read, "https://api.github.com"), refused("invalid_form_input"));
  assert.equal(calls, 1);
  for (const body of ["[", "null", "[]", "x".repeat(200001), JSON.stringify({ type: "dir" }), JSON.stringify({ type: "file", path: selection.path, encoding: "base64", content: "x".repeat(180001) })]) {
    await assert.rejects(readRepositoryIssueForm(selection, async () => ({ body }), "https://api.github.com"), refused("form_unavailable"));
  }
  await assert.rejects(readRepositoryIssueForm(selection, async () => { throw new Error("private detail"); }, "https://api.github.com"), refused("form_unavailable"));
  const file = join(directory, "answers.json");
  await assert.rejects(readRepositoryIssueForm({ ...selection, ref: "feature/forms" }, read, "https://api.github.com", { answers: directory }), refused("invalid_form_input"));
  for (const bytes of ["[", "x".repeat(131073)]) {
    writeFileSync(file, bytes);
    await assert.rejects(readRepositoryIssueForm({ ...selection, ref: "feature/forms" }, read, "https://api.github.com", { answers: file }), refused("invalid_form_input"));
  }
  await assert.rejects(readRepositoryIssueForm({ ...selection, ref: "feature/forms" }, read, "https://api.github.com", { bindings: join(directory, "missing") }), refused("invalid_form_input"));
  writeFileSync(file, JSON.stringify(answers));
  assert.equal((await completeIssueForm("unused", await readRepositoryIssueForm({ ...selection, ref: "feature/forms" }, read, "https://api.github.com", { answers: file }))).report.ok, true);
}));

test("registered command and exporter enforce one batch checklist before any POST/PATCH", async () => tracker(async (root, directory) => {
  const first = (await create({ title: "First form item", body: "Reproduction", type: "Task" }, { pmRoot: root })).item;
  const second = (await create({ title: "Second form item", type: "Task" }, { pmRoot: root })).item;
  const bindings = join(directory, "bindings.json");
  const answerFile = join(directory, "answers.json");
  writeFileSync(bindings, JSON.stringify({ summary: "title", steps: "body" }));
  writeFileSync(answerFile, JSON.stringify({ version: "stable" }));
  const options = { repo: selection.repo, form: selection.path, "form-ref": "main", "form-bindings": bindings, "form-answers": answerFile };
  await withMockGithub((req, res) => {
    if (req.method === "GET") jsonResponse(res, 200, { type: "file", path: selection.path, encoding: "base64", content: Buffer.from(stringify(definition)).toString("base64") });
    else jsonResponse(res, 201, { number: 42 });
  }, async server => {
    const h = await harness;
    h.assertCommandContract({ name: "github form", flags: ["--repo", "--form", "--form-ref", "--form-answers", "--form-bindings", "--item", "--compile"] });
    const before = durable(root);
    await assert.rejects(h.runCommand({ command: "github form", pmRoot: root }), refused("invalid_form_input"));
    assert.ok(await h.runCommand({ command: "github form", pmRoot: root, options: { ...options, compile: true } }));
    const checked = await h.runCommand({ command: "github form", pmRoot: root, options: { ...options, item: first.id } });
    assert.equal((checked.result as { ok: boolean }).ok, true);
    await assert.rejects(h.runCommand({ command: "github form", pmRoot: root, options: { ...options, item: second.id } }), refused("incomplete_answers"));
    for (const apply of [false, true]) await assert.rejects(h.runExporter({ exporter: "github", pmRoot: root, options: { ...options, ids: `${first.id},${second.id}`, apply }, global: { json: true } }), refused("incomplete_answers"));
    for (const flag of ["form-ref", "form-answers", "form-bindings"]) await assert.rejects(h.runExporter({ exporter: "github", pmRoot: root, options: { [flag]: "value" }, global: { json: true } }), refused("invalid_form_input"));
    assert.equal(server.requests.filter(req => req.method !== "GET").length, 0);
    assert.deepEqual(durable(root), before);
    const preview = (await h.runExporter({ exporter: "github", pmRoot: root, options: { ...options, ids: first.id }, global: { json: true } })).result as { plan: Array<{ payload: { body: string; labels: string[] } }> };
    assert.match(preview.plan[0]!.payload.body, /### Steps\n\nReproduction/);
    assert.deepEqual(preview.plan[0]!.payload.labels, ["bug"]);
    await captureStderr(() => h.runExporter({ exporter: "github", pmRoot: root, options: { ...options, ids: first.id, apply: true }, global: { json: true } }));
    assert.equal(server.requests.filter(req => req.method === "POST").length, 1);
    assert.deepEqual(durable(root), before);
  });
}));

test("installed CLI emits compact TOON/JSON and typed incomplete-answer refusals without git", async () => tracker(async (root, directory) => {
  const packageRoot = join(import.meta.dirname, "..");
  const installed = join(root, "extensions/pm-github");
  mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  for (const file of ["manifest.json", "package.json"]) copyFileSync(join(packageRoot, file), join(installed, file));
  symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const item = (await create({ title: "Installed CLI input", body: "Native steps", type: "Task" }, { pmRoot: root, noExtensions: true })).item;
  const bindingsFile = join(directory, "bindings.json");
  const answersFile = join(directory, "answers.json");
  writeFileSync(bindingsFile, JSON.stringify({ summary: "title", steps: "body" }));
  writeFileSync(answersFile, JSON.stringify({ version: "stable" }));
  await withMockGithub((_req, res) => jsonResponse(res, 200, { type: "file", path: selection.path, encoding: "base64", content: Buffer.from(stringify(definition)).toString("base64") }), async server => {
    const cli = join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js");
    const args = [cli, "--path", root, "github", "form", "--repo", selection.repo, "--form", selection.path, "--form-ref", selection.ref];
    for (const format of ["toon", "json"]) {
      const result = await boundedCli(process.execPath, [...args, "--compile", ...(format === "json" ? ["--json"] : [])], directory, process.env);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /summary/);
      if (format === "json") assert.equal((JSON.parse(result.stdout) as { fields: unknown[] }).fields.length, 4);
    }
    const checked = await boundedCli(process.execPath, [...args, "--item", item.id, "--form-bindings", bindingsFile, "--form-answers", answersFile, "--json"], directory, process.env);
    assert.equal(checked.code, 0, checked.stderr);
    assert.equal((JSON.parse(checked.stdout) as { answered: number }).answered, 3);
    assert.doesNotMatch(checked.stdout, /Native steps/);
    await update(item.id, { body: "" }, { pmRoot: root, noExtensions: true });
    const exportArgs = args.map(value => value === "form" ? "export" : value);
    const blocked = await boundedCli(process.execPath, [...exportArgs, "--ids", item.id, "--form-bindings", bindingsFile, "--form-answers", answersFile, "--apply", "--json"], directory, process.env);
    assert.equal(blocked.code, 2, blocked.stderr);
    assert.match(blocked.stderr, /incomplete_answers/);
    const missing = await boundedCli(process.execPath, [...args, "--json"], directory, process.env);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /incomplete_answers/);
    assert.match(missing.stderr, /summary/);
    assert.equal(server.requests.filter(req => req.method !== "GET").length, 0);
  });
}));

test("500 seeded model sequences preserve SDK state across checks, old-input replays and whitespace variants", async () => tracker(async (root, directory) => {
  const sdk = { pmRoot: root, noExtensions: true };
  const referenceRoot = join(directory, "reference");
  const reference = { pmRoot: referenceRoot, noExtensions: true };
  await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { ...reference, cwd: directory });
  const seed = { id: "form-model", title: "Model seed", type: "Task", body: "Seed", tags: "CLI", acceptanceCriteria: "Initial" };
  const actualId = (await create(seed, sdk)).item.id;
  const referenceId = (await create(seed, reference)).item.id;
  const parent = { id: "model-parent", title: "Model parent", type: "Epic" };
  const parentId = (await create(parent, sdk)).item.id;
  await create(parent, reference);
  let random = 0x5eed2026;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  const names = Array.from({ length: 5 }, () => `active-${next().toString(36)}`);
  for (const name of names) for (const client of [sdk, reference]) await schemaAddStatus(name, { role: ["active"], author: "fixture" }, client);
  const native = ["title", "description", "body", "tags", "acceptance_criteria", "parent", "status"];
  const modelForm = { name: "Model", description: "Native fields", body: native.map(field => ({ type: field === "body" ? "textarea" : field === "tags" ? "dropdown" : "input", id: field, attributes: { label: field, ...(field === "tags" ? { options: ["cli", "sdk"], multiple: true } : {}) }, validations: { required: true } })) };
  const bindings = Object.fromEntries(native.map(field => [field, field]));
  const history: Record<string, unknown>[] = [];
  /** Compare the package's entire touched native projection, using SDK reads on both stores. */
  const state = async (id: string, pmRoot: string) => {
    const item = (await get(id, { depth: "full" }, { pmRoot })).item;
    return Object.fromEntries([...native, "deps"].map(field => [field, item[field]]));
  };
  for (let sequence = 0; sequence < 500; sequence++) {
    const patch = { title: `Model ${next()}`, description: `  Context ${next()}  `, body: sequence % 2 ? `  One\r\nTwo ${next()}  ` : `One\nTwo ${next()}`,
      tags: sequence % 3 ? "CLI,SDK" : "CLI", acceptanceCriteria: `Criteria ${next()}`, parent: parentId, status: names[next() % names.length] };
    // The reference state machine applies only authoritative host operations.
    await update(actualId, patch, sdk);
    await update(referenceId, patch, reference);
    const current = request({ yaml: sequence % 2 ? stringify(modelForm).replace(/\n/g, "\r\n") : stringify(modelForm), item: actualId, bindings, answers: { description: `Source ${next()}` } });
    history.push(current);
    const replay = history[next() % history.length]!;
    assert.equal(compileIssueForm(replay).fields.length, native.length);
    const result = await completeIssueForm(root, replay);
    assert.equal(result.report.ok, true, `seed=0x5eed2026 sequence=${sequence} ${JSON.stringify(result.report.checklist)}`);
    assert.equal(result.report.answered, native.length);
    assert.match(result.body, new RegExp(`Model ${patch.title.split(" ")[1]}`));
    const incomplete = await completeIssueForm(root, { ...current, answers: { title: "  \r\n " } });
    assert.equal(incomplete.report.ok, false);
    assert.deepEqual(await state(actualId, root), await state(referenceId, referenceRoot));
  }
}));
