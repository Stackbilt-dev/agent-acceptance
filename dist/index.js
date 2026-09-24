// src/action.ts
import { execFile as execFile2 } from "node:child_process";
import { appendFile, readFile as readFile2 } from "node:fs/promises";
import { promisify as promisify2 } from "node:util";

// src/spec.ts
var BLOCK_PATTERN = /```acceptance[ \t]*\r?\n([\s\S]*?)```/g;
var SPEC_KEYS = /* @__PURE__ */ new Set([
  "changed_files_only",
  "changed_files_required",
  "max_added_lines",
  "max_deleted_lines",
  "file_contains",
  "file_excludes",
  "tests"
]);
var VITEST_RUN = /^(?:pnpm\s+exec|npx|yarn)\s+vitest\s+run(?:\s|$)/;
function parseAcceptanceSpec(text) {
  const blocks = [...text.matchAll(BLOCK_PATTERN)];
  if (blocks.length === 0) {
    return /```acceptance/.test(text) ? { kind: "invalid", error: "acceptance block is not closed" } : { kind: "absent" };
  }
  if (blocks.length > 1) return { kind: "invalid", error: "more than one acceptance block" };
  let raw;
  try {
    raw = JSON.parse(blocks[0][1]);
  } catch (error) {
    return { kind: "invalid", error: `acceptance block is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { kind: "spec", spec: validateSpec(raw) };
  } catch (error) {
    return { kind: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}
function normalizeRepositoryPath(value) {
  if (typeof value !== "string") throw new Error("path must be a string");
  const path = value.trim().replace(/^\/+/, "").replace(/\\/g, "/");
  if (!path || path.includes("\0") || path.split("/").some((part) => part === "..")) {
    throw new Error("path must stay within the repository");
  }
  return path;
}
function testCommandError(command) {
  if (typeof command !== "string" || !command.trim()) return "tests entries need a command";
  const trimmed = command.trim();
  if (/[;&|><`$\\\n\r'"(){}]/.test(trimmed)) return `test command contains shell syntax: ${trimmed}`;
  if (!VITEST_RUN.test(trimmed)) return "test commands must be `pnpm exec vitest run`, `npx vitest run`, or `yarn vitest run`";
  if (/--(?:reporter|outputFile)\b/.test(trimmed)) return "test commands must not set a reporter or output file; the checker sets them";
  return null;
}
function validateSpec(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("acceptance block must be a JSON object");
  }
  const input2 = raw;
  const unknownKeys = Object.keys(input2).filter((key) => !SPEC_KEYS.has(key));
  if (unknownKeys.length > 0) throw new Error(`unsupported acceptance keys: ${unknownKeys.join(", ")}`);
  if (Object.keys(input2).length === 0) throw new Error("acceptance block declares no checks");
  const spec = {};
  for (const key of ["changed_files_only", "changed_files_required"]) {
    if (input2[key] === void 0) continue;
    const value = input2[key];
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} must be a non-empty array of paths`);
    spec[key] = value.map((path) => normalizeRepositoryPath(path));
  }
  for (const key of ["max_added_lines", "max_deleted_lines"]) {
    if (input2[key] === void 0) continue;
    const value = input2[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer`);
    }
    spec[key] = value;
  }
  for (const key of ["file_contains", "file_excludes"]) {
    if (input2[key] === void 0) continue;
    const value = input2[key];
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} must be a non-empty array`);
    spec[key] = value.map((entry) => {
      const item = entry;
      if (!item || typeof item.text !== "string" || !item.text) {
        throw new Error(`${key} entries need a path and non-empty text`);
      }
      return { path: normalizeRepositoryPath(item.path), text: item.text };
    });
  }
  if (input2.tests !== void 0) {
    if (!Array.isArray(input2.tests) || input2.tests.length === 0) throw new Error("tests must be a non-empty array");
    spec.tests = input2.tests.map((entry) => {
      const item = entry;
      const commandError = testCommandError(item?.command);
      if (!item || commandError) throw new Error(commandError ?? "tests entries need a command");
      if (typeof item.passed !== "number" || !Number.isInteger(item.passed) || item.passed < 1) {
        throw new Error("tests entries need passed as a positive integer");
      }
      const test = { command: item.command.trim(), passed: item.passed };
      if (item.cwd !== void 0) test.cwd = normalizeRepositoryPath(item.cwd);
      return test;
    });
  }
  return spec;
}
function parseVitestJsonReport(report) {
  if (!report) return null;
  try {
    const data = JSON.parse(report);
    if (typeof data.numPassedTests !== "number" || typeof data.numFailedTests !== "number") return null;
    return { passed: data.numPassedTests, failed: data.numFailedTests, success: data.success === true };
  } catch {
    return null;
  }
}
function parseNumstat(output) {
  if (output && !output.endsWith("\0")) {
    throw new Error("numstat output lost its NUL framing; refusing to evaluate changed files");
  }
  return output.split("\0").map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
    const [added, deleted, ...path] = record.split("	");
    return {
      path: path.join("	"),
      added: added === "-" ? 0 : Number(added),
      deleted: deleted === "-" ? 0 : Number(deleted)
    };
  });
}
async function evaluateAcceptance(spec, facts) {
  const changedFiles = await facts.listChangedFiles();
  if (!spec) return { status: "unchecked", checks: [], changedFiles };
  const checks = [];
  const changed = new Set(changedFiles.map((file) => file.path));
  if (spec.changed_files_only) {
    const allowed = new Set(spec.changed_files_only);
    const extra = [...changed].filter((path) => !allowed.has(path));
    checks.push({
      check: "changed_files_only",
      ok: extra.length === 0,
      detail: extra.length === 0 ? `changed: ${[...changed].join(", ") || "(none)"}` : `unexpected changes: ${extra.join(", ")}`
    });
  }
  if (spec.changed_files_required) {
    const missing = spec.changed_files_required.filter((path) => !changed.has(path));
    checks.push({
      check: "changed_files_required",
      ok: missing.length === 0,
      detail: missing.length === 0 ? "all required files changed" : `not changed: ${missing.join(", ")}`
    });
  }
  const added = changedFiles.reduce((sum, file) => sum + file.added, 0);
  const deleted = changedFiles.reduce((sum, file) => sum + file.deleted, 0);
  if (spec.max_added_lines !== void 0) {
    checks.push({
      check: "max_added_lines",
      ok: added <= spec.max_added_lines,
      detail: `${added} added (limit ${spec.max_added_lines})`
    });
  }
  if (spec.max_deleted_lines !== void 0) {
    checks.push({
      check: "max_deleted_lines",
      ok: deleted <= spec.max_deleted_lines,
      detail: `${deleted} deleted (limit ${spec.max_deleted_lines})`
    });
  }
  for (const { path, text } of spec.file_contains ?? []) {
    const content = await facts.readFile(path);
    checks.push({
      check: "file_contains",
      ok: content !== null && content.includes(text),
      detail: content === null ? `${path} does not exist` : `${path} ${content.includes(text) ? "contains" : "lacks"} ${JSON.stringify(text)}`
    });
  }
  for (const { path, text } of spec.file_excludes ?? []) {
    const content = await facts.readFile(path);
    const present = content !== null && content.includes(text);
    checks.push({
      check: "file_excludes",
      ok: !present,
      detail: `${path} ${present ? "still contains" : "does not contain"} ${JSON.stringify(text)}`
    });
  }
  for (const test of spec.tests ?? []) {
    const run3 = await facts.runTests(test);
    const report = parseVitestJsonReport(run3.report);
    const ok = run3.exitCode === 0 && report !== null && report.success && report.failed === 0 && report.passed === test.passed;
    const label = test.cwd ? `${test.command} (in ${test.cwd})` : test.command;
    checks.push({
      check: "tests",
      ok,
      detail: report ? `${label}: exit ${run3.exitCode}, ${report.passed} passed, ${report.failed} failed (expected ${test.passed} passed)` : `${label}: exit ${run3.exitCode}, no JSON test report written`
    });
  }
  return { status: checks.every((check) => check.ok) ? "passed" : "failed", checks, changedFiles };
}
function formatAcceptanceReport(verdict) {
  if (verdict.status === "unchecked") {
    return "Acceptance: **not machine-checked** \u2014 no acceptance contract applies to this change. Verify the diff by hand.";
  }
  const passed = verdict.checks.filter((check) => check.ok).length;
  const lines = verdict.checks.map((check) => `- ${check.ok ? "\u2705" : "\u274C"} \`${check.check}\` \u2014 ${check.detail}`);
  return [`Acceptance: ${passed}/${verdict.checks.length} checks passed (re-run by the checker, not reported by the author).`, "", ...lines].join("\n");
}

// src/contract.ts
var DEFAULT_TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
var CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;
function linkedIssueNumbers(body) {
  const numbers = [...(body ?? "").matchAll(CLOSING_REFERENCE)].map((match) => Number(match[1]));
  return [...new Set(numbers)];
}
async function resolveContract(options) {
  const trusted = new Set((options.trustedAssociations ?? DEFAULT_TRUSTED_ASSOCIATIONS).map((value) => value.toUpperCase()));
  const notes = [];
  const found = [];
  if (/```acceptance/.test(options.prBody ?? "")) {
    notes.push("The PR description contains an acceptance block. It was ignored: contracts are read only from linked issues.");
  }
  for (const number of linkedIssueNumbers(options.prBody)) {
    const issue = await options.fetchIssue(number);
    if (!issue || issue.isPullRequest) {
      notes.push(`#${number} is not an issue in this repository.`);
      continue;
    }
    const parsed = parseAcceptanceSpec(issue.body ?? "");
    if (parsed.kind === "absent") continue;
    if (!trusted.has(issue.authorAssociation.toUpperCase())) {
      notes.push(`The contract in #${number} was ignored: its author @${issue.author} is ${issue.authorAssociation}, not one of ${[...trusted].join(", ")}.`);
      continue;
    }
    if (parsed.kind === "invalid") {
      return { kind: "error", error: `The contract in #${number} is invalid: ${parsed.error}`, notes };
    }
    found.push({ spec: parsed.spec, source: `#${number} by @${issue.author}` });
  }
  if (found.length > 1) {
    return { kind: "error", error: `More than one linked issue carries a contract (${found.map((entry) => entry.source).join(", ")}). Link exactly one.`, notes };
  }
  if (found.length === 0) return { kind: "none", notes };
  return { kind: "found", spec: found[0].spec, source: found[0].source, notes };
}

// src/facts.ts
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
var run = promisify(execFile);
var TEST_TIMEOUT_MS = 15 * 6e4;
async function git(root, args) {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}
async function within(root, path) {
  const realRoot = await realpath(root);
  const target = resolve(realRoot, path);
  let real;
  try {
    real = await realpath(target);
  } catch {
    return null;
  }
  return real === realRoot || real.startsWith(realRoot + sep) ? real : null;
}
function commandArgv(command) {
  return command.trim().split(/\s+/);
}
function checkoutFacts(options) {
  const { root, base, head } = options;
  return {
    // Three-dot diff: changes on the PR side since the merge base, so a stale
    // branch is not blamed for what landed on the base in the meantime.
    listChangedFiles: async () => parseNumstat(await git(root, ["diff", "--numstat", "--no-renames", "-z", `${base}...${head}`])),
    readFile: async (path) => {
      const target = await within(root, path);
      if (!target) return null;
      try {
        return await readFile(target, "utf8");
      } catch {
        return null;
      }
    },
    runTests: async (test) => {
      const cwd = test.cwd ? await within(root, test.cwd) : root;
      if (!cwd) return { exitCode: 1, report: null };
      const reportPath = join(tmpdir(), `agent-acceptance-${randomUUID()}.json`);
      const [bin, ...args] = commandArgv(test.command);
      let exitCode = 0;
      try {
        await run(bin, [...args, "--reporter=json", `--outputFile=${reportPath}`], {
          cwd,
          timeout: TEST_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024
        });
      } catch (error) {
        const code = error.code;
        exitCode = typeof code === "number" ? code : 1;
      }
      try {
        return { exitCode, report: await readFile(reportPath, "utf8") };
      } catch {
        return { exitCode, report: null };
      } finally {
        await rm(reportPath, { force: true });
      }
    }
  };
}

// src/action.ts
var run2 = promisify2(execFile2);
function input(name, fallback = "") {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? fallback).trim() || fallback;
}
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}
`);
}
async function summary(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}
`);
}
async function main() {
  const token = input("github-token");
  const requireContract = input("require-contract", "false") === "true";
  const trustedAssociations = input("trusted-associations", DEFAULT_TRUSTED_ASSOCIATIONS.join(",")).split(",").map((value) => value.trim()).filter(Boolean);
  const root = input("working-directory", process.env.GITHUB_WORKSPACE ?? process.cwd());
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const event = JSON.parse(await readFile2(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const pr = event.pull_request;
  if (!pr) {
    await summary("agent-acceptance runs on `pull_request` events only; nothing to check.");
    return 0;
  }
  const checkedOut = (await run2("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  if (checkedOut !== pr.head.sha) {
    await summary(`\u274C The working tree is at \`${checkedOut.slice(0, 12)}\`, not the PR head \`${pr.head.sha.slice(0, 12)}\`. Check out with \`ref: \${{ github.event.pull_request.head.sha }}\` and \`fetch-depth: 0\`.`);
    return 1;
  }
  const fetchIssue = async (number) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/issues/${number}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "stackbilt-agent-acceptance",
        ...token ? { Authorization: `Bearer ${token}` } : {}
      }
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`issue #${number} lookup failed (${response.status})`);
    const data = await response.json();
    return {
      number: data.number,
      body: data.body,
      author: data.user?.login ?? "unknown",
      authorAssociation: data.author_association ?? "NONE",
      isPullRequest: data.pull_request !== void 0
    };
  };
  const contract = await resolveContract({ prBody: pr.body, fetchIssue, trustedAssociations });
  const notes = contract.notes.map((note) => `> ${note}`).join("\n");
  if (contract.kind === "error") {
    await setOutput("status", "failed");
    await summary(`### Agent acceptance

\u274C ${contract.error}${notes ? `

${notes}` : ""}`);
    return 1;
  }
  const facts = checkoutFacts({ root, base: pr.base.sha, head: pr.head.sha });
  const verdict = await evaluateAcceptance(contract.kind === "found" ? contract.spec : null, facts);
  const source = contract.kind === "found" ? `Contract: ${contract.source}

` : "";
  await setOutput("status", verdict.status);
  await summary(`### Agent acceptance

${source}${formatAcceptanceReport(verdict)}${notes ? `

${notes}` : ""}`);
  if (verdict.status === "failed") return 1;
  if (verdict.status === "unchecked" && requireContract) {
    await summary("\n\u274C `require-contract` is on and this PR closes no issue with a trusted acceptance contract.");
    return 1;
  }
  return 0;
}
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`agent-acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
);
