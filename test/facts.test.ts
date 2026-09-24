// Integration: a real git repository and a real vitest run.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkoutFacts } from '../src/facts.js';
import { evaluateAcceptance } from '../src/spec.js';

// Inside the package so `npx vitest` resolves this package's vitest install.
const fixtures = resolve(__dirname, '.fixtures');
let root: string;
let base: string;
let head: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

beforeAll(() => {
  mkdirSync(fixtures, { recursive: true });
  root = mkdtempSync(join(fixtures, 'repo-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'vitest.config.mjs'), 'export default { test: { include: ["tests/**/*.test.mjs"] } };\n');
  writeFileSync(join(root, 'src/slugify.mjs'), "export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '-');\n");
  writeFileSync(join(root, 'tests/slugify.test.mjs'), [
    "import { expect, it } from 'vitest';",
    "import { slugify } from '../src/slugify.mjs';",
    "it('lowercases', () => expect(slugify('A')).toBe('a'));",
    '',
  ].join('\n'));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');

  writeFileSync(join(root, 'src/slugify.mjs'), "export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');\n");
  writeFileSync(join(root, 'tests/slugify.test.mjs'), [
    "import { expect, it } from 'vitest';",
    "import { slugify } from '../src/slugify.mjs';",
    "it('lowercases', () => expect(slugify('A')).toBe('a'));",
    "it('collapses separators', () => expect(slugify('a  b')).toBe('a-b'));",
    // A test file can print a fake summary line; the count must come from the JSON report.
    "console.log(' Tests  99 passed (99)');",
    '',
  ].join('\n'));
  git('add', '-A');
  git('commit', '-q', '-m', 'fix');
  head = git('rev-parse', 'HEAD');
});

afterAll(() => {
  execFileSync('rm', ['-rf', root]);
});

describe('checkoutFacts', () => {
  it('lists a multi-file change with correct per-file counts', async () => {
    const files = await checkoutFacts({ root, base, head }).listChangedFiles();
    expect(files).toEqual([
      { path: 'src/slugify.mjs', added: 1, deleted: 1 },
      { path: 'tests/slugify.test.mjs', added: 2, deleted: 0 },
    ]);
  });

  it('re-runs vitest and reads the real count from its JSON report', async () => {
    const verdict = await evaluateAcceptance(
      {
        changed_files_only: ['src/slugify.mjs', 'tests/slugify.test.mjs'],
        max_added_lines: 5,
        tests: [{ command: 'npx vitest run tests/slugify.test.mjs', passed: 2 }],
      },
      checkoutFacts({ root, base, head }),
    );
    expect(verdict.checks.map((check) => [check.check, check.ok])).toEqual([
      ['changed_files_only', true],
      ['max_added_lines', true],
      ['tests', true],
    ]);
    expect(verdict.checks[2].detail).toContain('2 passed, 0 failed');
  });

  it('fails a claimed count the suite does not have', async () => {
    const verdict = await evaluateAcceptance(
      { tests: [{ command: 'npx vitest run tests/slugify.test.mjs', passed: 99 }] },
      checkoutFacts({ root, base, head }),
    );
    expect(verdict.status).toBe('failed');
  });

  it('does not read through a symlink that leaves the checkout', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    expect(await checkoutFacts({ root, base, head }).readFile('link.txt')).toBeNull();
    expect(await checkoutFacts({ root, base, head }).readFile('src/slugify.mjs')).toContain('slugify');
  });
});
