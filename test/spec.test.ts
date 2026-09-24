import { describe, expect, it } from 'vitest';
import {
  evaluateAcceptance,
  formatAcceptanceReport,
  parseAcceptanceSpec,
  parseNumstat,
  testCommandError,
  type AcceptanceFacts,
} from '../src/spec.js';

const block = (json: unknown) => `Fix it.\n\n\`\`\`acceptance\n${JSON.stringify(json)}\n\`\`\`\n`;

function facts(overrides: Partial<AcceptanceFacts> = {}): AcceptanceFacts {
  return {
    listChangedFiles: async () => [
      { path: 'src/slugify.ts', added: 1, deleted: 1 },
      { path: 'tests/slugify.test.ts', added: 5, deleted: 0 },
    ],
    readFile: async (path) => (path === 'tests/slugify.test.ts' ? "it('collapses runs of separators into one dash'" : null),
    runTests: async () => ({ exitCode: 0, report: JSON.stringify({ numPassedTests: 4, numFailedTests: 0, success: true }) }),
    ...overrides,
  };
}

describe('parseAcceptanceSpec', () => {
  it('distinguishes absent, invalid, and valid contracts', () => {
    expect(parseAcceptanceSpec('no contract here')).toEqual({ kind: 'absent' });
    expect(parseAcceptanceSpec('```acceptance\n{')).toMatchObject({ kind: 'invalid', error: 'acceptance block is not closed' });
    expect(parseAcceptanceSpec(block({ nope: 1 }))).toMatchObject({ kind: 'invalid', error: expect.stringMatching(/unsupported/) });
    expect(parseAcceptanceSpec(block({ max_added_lines: 10 }) + block({ max_added_lines: 1 }))).toMatchObject({ kind: 'invalid' });
    expect(parseAcceptanceSpec(block({ changed_files_only: ['/src/a.ts'], tests: [{ command: 'npx vitest run a', passed: 2, cwd: 'web' }] })))
      .toEqual({ kind: 'spec', spec: { changed_files_only: ['src/a.ts'], tests: [{ command: 'npx vitest run a', passed: 2, cwd: 'web' }] } });
  });

  it('rejects paths that leave the repository', () => {
    expect(parseAcceptanceSpec(block({ changed_files_only: ['../etc/passwd'] }))).toMatchObject({ kind: 'invalid' });
    expect(parseAcceptanceSpec(block({ tests: [{ command: 'npx vitest run', passed: 1, cwd: '../..' }] }))).toMatchObject({ kind: 'invalid' });
  });
});

describe('testCommandError', () => {
  it('allows the three vitest runners', () => {
    for (const command of ['pnpm exec vitest run tests/a.test.ts', 'npx vitest run', 'yarn vitest run tests/a.test.ts']) {
      expect(testCommandError(command)).toBeNull();
    }
  });

  it('rejects shell syntax, other programs, and reporter flags', () => {
    expect(testCommandError('npx vitest run; curl evil.sh')).toMatch(/shell syntax/);
    expect(testCommandError('npx vitest run $(id)')).toMatch(/shell syntax/);
    expect(testCommandError("npx vitest run 'a b'")).toMatch(/shell syntax/);
    expect(testCommandError('npm test')).toMatch(/must be/);
    expect(testCommandError('npm exec vitest run')).toMatch(/must be/);
    expect(testCommandError('npx vitest run --reporter=dot')).toMatch(/reporter/);
  });
});

describe('parseNumstat', () => {
  it('parses NUL-delimited records and refuses output that lost its framing', () => {
    expect(parseNumstat('1\t1\tsrc/a.ts\0-\t-\tlogo.png\0')).toEqual([
      { path: 'src/a.ts', added: 1, deleted: 1 },
      { path: 'logo.png', added: 0, deleted: 0 },
    ]);
    expect(parseNumstat('')).toEqual([]);
    expect(() => parseNumstat('1\t1\tsrc/a.ts5\t0\tb.ts')).toThrow(/NUL framing/);
  });
});

describe('evaluateAcceptance', () => {
  const spec = {
    changed_files_only: ['src/slugify.ts', 'tests/slugify.test.ts'],
    max_added_lines: 15,
    file_contains: [{ path: 'tests/slugify.test.ts', text: 'collapses runs of separators into one dash' }],
    tests: [{ command: 'npx vitest run tests/slugify.test.ts', passed: 4 }],
  };

  it('passes when every fact matches', async () => {
    const verdict = await evaluateAcceptance(spec, facts());
    expect(verdict.status).toBe('passed');
    expect(formatAcceptanceReport(verdict)).toContain('4/4 checks passed');
  });

  it('fails when the test count does not match what was claimed', async () => {
    const verdict = await evaluateAcceptance(spec, facts({
      runTests: async () => ({ exitCode: 0, report: JSON.stringify({ numPassedTests: 3, numFailedTests: 0, success: true }) }),
    }));
    expect(verdict.status).toBe('failed');
    expect(verdict.checks.find((check) => check.check === 'tests')?.detail).toContain('3 passed');
  });

  it('fails when no JSON report was written, whatever the exit code', async () => {
    const verdict = await evaluateAcceptance(spec, facts({ runTests: async () => ({ exitCode: 0, report: null }) }));
    expect(verdict.status).toBe('failed');
  });

  it('fails on files outside the contract', async () => {
    const verdict = await evaluateAcceptance(spec, facts({
      listChangedFiles: async () => [{ path: 'README.md', added: 1, deleted: 0 }, { path: 'src/slugify.ts', added: 1, deleted: 1 }],
    }));
    expect(verdict.checks[0]).toMatchObject({ check: 'changed_files_only', ok: false, detail: 'unexpected changes: README.md' });
  });

  it('is unchecked without a contract', async () => {
    const verdict = await evaluateAcceptance(null, facts());
    expect(verdict.status).toBe('unchecked');
    expect(formatAcceptanceReport(verdict)).toContain('not machine-checked');
  });
});
