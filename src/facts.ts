// Facts gathered from a local checkout. Nothing here runs through a shell:
// git and vitest are spawned with argument arrays.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseNumstat, type AcceptanceFacts, type TestExpectation } from './spec.js';

const run = promisify(execFile);
const TEST_TIMEOUT_MS = 15 * 60_000;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  return stdout;
}

async function within(root: string, path: string): Promise<string | null> {
  const realRoot = await realpath(root);
  const target = resolve(realRoot, path);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return null;
  }
  return real === realRoot || real.startsWith(realRoot + sep) ? real : null;
}

/** Split a validated vitest command into argv. Validation already rejected quotes and shell syntax. */
export function commandArgv(command: string): string[] {
  return command.trim().split(/\s+/);
}

export function checkoutFacts(options: { root: string; base: string; head: string }): AcceptanceFacts {
  const { root, base, head } = options;
  return {
    // Three-dot diff: changes on the PR side since the merge base, so a stale
    // branch is not blamed for what landed on the base in the meantime.
    listChangedFiles: async () => parseNumstat(await git(root, ['diff', '--numstat', '--no-renames', '-z', `${base}...${head}`])),

    readFile: async (path) => {
      const target = await within(root, path);
      if (!target) return null;
      try {
        return await readFile(target, 'utf8');
      } catch {
        return null;
      }
    },

    runTests: async (test: TestExpectation) => {
      const cwd = test.cwd ? await within(root, test.cwd) : root;
      if (!cwd) return { exitCode: 1, report: null };
      // Chosen now, after the change was made: test code cannot know it in advance.
      const reportPath = join(tmpdir(), `agent-acceptance-${randomUUID()}.json`);
      const [bin, ...args] = commandArgv(test.command);
      let exitCode = 0;
      try {
        await run(bin, [...args, '--reporter=json', `--outputFile=${reportPath}`], {
          cwd,
          timeout: TEST_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        exitCode = typeof code === 'number' ? code : 1;
      }
      try {
        return { exitCode, report: await readFile(reportPath, 'utf8') };
      } catch {
        return { exitCode, report: null };
      } finally {
        await rm(reportPath, { force: true });
      }
    },
  };
}
