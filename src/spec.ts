// Acceptance contracts for AI agent changes.
//
// A contract is one fenced block, written by a human before the agent runs:
//
//   ```acceptance
//   { "changed_files_only": ["src/slugify.ts", "tests/slugify.test.ts"],
//     "max_added_lines": 15,
//     "tests": [{ "command": "pnpm exec vitest run tests/slugify.test.ts", "passed": 4 }] }
//   ```
//
// The verdict comes only from facts the checker gathers itself: the diff, file
// contents, and test commands it re-runs with a JSON report at a path it picks
// after the agent has finished. The agent's own account of its work is never
// consulted. Same format as the AEGIS do_sandbox executor.

export interface TestExpectation {
  command: string;
  passed: number;
  /** Repository-relative directory to run the command in. Defaults to the root. */
  cwd?: string;
}

export interface AcceptanceSpec {
  changed_files_only?: string[];
  changed_files_required?: string[];
  max_added_lines?: number;
  max_deleted_lines?: number;
  file_contains?: Array<{ path: string; text: string }>;
  file_excludes?: Array<{ path: string; text: string }>;
  tests?: TestExpectation[];
}

export type ParsedAcceptance =
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string }
  | { kind: 'spec'; spec: AcceptanceSpec };

export interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
}

export interface AcceptanceFacts {
  listChangedFiles(): Promise<ChangedFile[]>;
  /** Current file content, or null when the file does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Re-run a vitest command with a JSON report; `report` is the report text, or null if none was written. */
  runTests(test: TestExpectation): Promise<{ exitCode: number; report: string | null }>;
}

export interface AcceptanceCheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export interface AcceptanceVerdict {
  status: 'passed' | 'failed' | 'unchecked';
  checks: AcceptanceCheckResult[];
  changedFiles: ChangedFile[];
}

const BLOCK_PATTERN = /```acceptance[ \t]*\r?\n([\s\S]*?)```/g;
const SPEC_KEYS = new Set<keyof AcceptanceSpec>([
  'changed_files_only',
  'changed_files_required',
  'max_added_lines',
  'max_deleted_lines',
  'file_contains',
  'file_excludes',
  'tests',
]);

/** vitest invocations the checker will run. Each passes trailing flags through to vitest. */
const VITEST_RUN = /^(?:pnpm\s+exec|npx|yarn)\s+vitest\s+run(?:\s|$)/;

export function parseAcceptanceSpec(text: string): ParsedAcceptance {
  const blocks = [...text.matchAll(BLOCK_PATTERN)];
  if (blocks.length === 0) {
    return /```acceptance/.test(text)
      ? { kind: 'invalid', error: 'acceptance block is not closed' }
      : { kind: 'absent' };
  }
  if (blocks.length > 1) return { kind: 'invalid', error: 'more than one acceptance block' };

  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0][1]);
  } catch (error) {
    return { kind: 'invalid', error: `acceptance block is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { kind: 'spec', spec: validateSpec(raw) };
  } catch (error) {
    return { kind: 'invalid', error: error instanceof Error ? error.message : String(error) };
  }
}

export function normalizeRepositoryPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('path must be a string');
  const path = value.trim().replace(/^\/+/, '').replace(/\\/g, '/');
  if (!path || path.includes('\0') || path.split('/').some((part) => part === '..')) {
    throw new Error('path must stay within the repository');
  }
  return path;
}

/** A vitest command the checker may run: no shell syntax, no reporter flags of its own. */
export function testCommandError(command: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return 'tests entries need a command';
  const trimmed = command.trim();
  if (/[;&|><`$\\\n\r'"(){}]/.test(trimmed)) return `test command contains shell syntax: ${trimmed}`;
  if (!VITEST_RUN.test(trimmed)) return 'test commands must be `pnpm exec vitest run`, `npx vitest run`, or `yarn vitest run`';
  if (/--(?:reporter|outputFile)\b/.test(trimmed)) return 'test commands must not set a reporter or output file; the checker sets them';
  return null;
}

function validateSpec(raw: unknown): AcceptanceSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('acceptance block must be a JSON object');
  }
  const input = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter((key) => !SPEC_KEYS.has(key as keyof AcceptanceSpec));
  if (unknownKeys.length > 0) throw new Error(`unsupported acceptance keys: ${unknownKeys.join(', ')}`);
  if (Object.keys(input).length === 0) throw new Error('acceptance block declares no checks');

  const spec: AcceptanceSpec = {};
  for (const key of ['changed_files_only', 'changed_files_required'] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} must be a non-empty array of paths`);
    spec[key] = value.map((path) => normalizeRepositoryPath(path));
  }
  for (const key of ['max_added_lines', 'max_deleted_lines'] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer`);
    }
    spec[key] = value;
  }
  for (const key of ['file_contains', 'file_excludes'] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} must be a non-empty array`);
    spec[key] = value.map((entry) => {
      const item = entry as Record<string, unknown> | null;
      if (!item || typeof item.text !== 'string' || !item.text) {
        throw new Error(`${key} entries need a path and non-empty text`);
      }
      return { path: normalizeRepositoryPath(item.path), text: item.text };
    });
  }
  if (input.tests !== undefined) {
    if (!Array.isArray(input.tests) || input.tests.length === 0) throw new Error('tests must be a non-empty array');
    spec.tests = input.tests.map((entry) => {
      const item = entry as Record<string, unknown> | null;
      const commandError = testCommandError(item?.command);
      if (!item || commandError) throw new Error(commandError ?? 'tests entries need a command');
      if (typeof item.passed !== 'number' || !Number.isInteger(item.passed) || item.passed < 1) {
        throw new Error('tests entries need passed as a positive integer');
      }
      const test: TestExpectation = { command: (item.command as string).trim(), passed: item.passed };
      if (item.cwd !== undefined) test.cwd = normalizeRepositoryPath(item.cwd);
      return test;
    });
  }
  return spec;
}

export function parseVitestJsonReport(
  report: string | null,
): { passed: number; failed: number; success: boolean } | null {
  if (!report) return null;
  try {
    const data = JSON.parse(report) as Record<string, unknown>;
    if (typeof data.numPassedTests !== 'number' || typeof data.numFailedTests !== 'number') return null;
    return { passed: data.numPassedTests, failed: data.numFailedTests, success: data.success === true };
  } catch {
    return null;
  }
}

/** Parse `git diff --numstat --no-renames -z`. Binary files count as zero lines. */
export function parseNumstat(output: string): ChangedFile[] {
  if (output && !output.endsWith('\0')) {
    throw new Error('numstat output lost its NUL framing; refusing to evaluate changed files');
  }
  return output
    .split('\0')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [added, deleted, ...path] = record.split('\t');
      return {
        path: path.join('\t'),
        added: added === '-' ? 0 : Number(added),
        deleted: deleted === '-' ? 0 : Number(deleted),
      };
    });
}

export async function evaluateAcceptance(
  spec: AcceptanceSpec | null,
  facts: AcceptanceFacts,
): Promise<AcceptanceVerdict> {
  const changedFiles = await facts.listChangedFiles();
  if (!spec) return { status: 'unchecked', checks: [], changedFiles };

  const checks: AcceptanceCheckResult[] = [];
  const changed = new Set(changedFiles.map((file) => file.path));

  if (spec.changed_files_only) {
    const allowed = new Set(spec.changed_files_only);
    const extra = [...changed].filter((path) => !allowed.has(path));
    checks.push({
      check: 'changed_files_only',
      ok: extra.length === 0,
      detail: extra.length === 0 ? `changed: ${[...changed].join(', ') || '(none)'}` : `unexpected changes: ${extra.join(', ')}`,
    });
  }
  if (spec.changed_files_required) {
    const missing = spec.changed_files_required.filter((path) => !changed.has(path));
    checks.push({
      check: 'changed_files_required',
      ok: missing.length === 0,
      detail: missing.length === 0 ? 'all required files changed' : `not changed: ${missing.join(', ')}`,
    });
  }
  const added = changedFiles.reduce((sum, file) => sum + file.added, 0);
  const deleted = changedFiles.reduce((sum, file) => sum + file.deleted, 0);
  if (spec.max_added_lines !== undefined) {
    checks.push({
      check: 'max_added_lines',
      ok: added <= spec.max_added_lines,
      detail: `${added} added (limit ${spec.max_added_lines})`,
    });
  }
  if (spec.max_deleted_lines !== undefined) {
    checks.push({
      check: 'max_deleted_lines',
      ok: deleted <= spec.max_deleted_lines,
      detail: `${deleted} deleted (limit ${spec.max_deleted_lines})`,
    });
  }
  for (const { path, text } of spec.file_contains ?? []) {
    const content = await facts.readFile(path);
    checks.push({
      check: 'file_contains',
      ok: content !== null && content.includes(text),
      detail: content === null ? `${path} does not exist` : `${path} ${content.includes(text) ? 'contains' : 'lacks'} ${JSON.stringify(text)}`,
    });
  }
  for (const { path, text } of spec.file_excludes ?? []) {
    const content = await facts.readFile(path);
    const present = content !== null && content.includes(text);
    checks.push({
      check: 'file_excludes',
      ok: !present,
      detail: `${path} ${present ? 'still contains' : 'does not contain'} ${JSON.stringify(text)}`,
    });
  }
  for (const test of spec.tests ?? []) {
    const run = await facts.runTests(test);
    const report = parseVitestJsonReport(run.report);
    const ok = run.exitCode === 0 && report !== null && report.success
      && report.failed === 0 && report.passed === test.passed;
    const label = test.cwd ? `${test.command} (in ${test.cwd})` : test.command;
    checks.push({
      check: 'tests',
      ok,
      detail: report
        ? `${label}: exit ${run.exitCode}, ${report.passed} passed, ${report.failed} failed (expected ${test.passed} passed)`
        : `${label}: exit ${run.exitCode}, no JSON test report written`,
    });
  }

  return { status: checks.every((check) => check.ok) ? 'passed' : 'failed', checks, changedFiles };
}

export function formatAcceptanceReport(verdict: AcceptanceVerdict): string {
  if (verdict.status === 'unchecked') {
    return 'Acceptance: **not machine-checked** — no acceptance contract applies to this change. Verify the diff by hand.';
  }
  const passed = verdict.checks.filter((check) => check.ok).length;
  const lines = verdict.checks.map((check) => `- ${check.ok ? '✅' : '❌'} \`${check.check}\` — ${check.detail}`);
  return [`Acceptance: ${passed}/${verdict.checks.length} checks passed (re-run by the checker, not reported by the author).`, '', ...lines].join('\n');
}
