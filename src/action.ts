// GitHub Action entry point. Runs on `pull_request` with a read-only token:
// it reports through the job summary and the check's exit status, and never
// needs write access to the repository.

import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { DEFAULT_TRUSTED_ASSOCIATIONS, resolveContract, type IssueRecord } from './contract.js';
import { checkoutFacts } from './facts.js';
import { evaluateAcceptance, formatAcceptanceReport } from './spec.js';

const run = promisify(execFile);

function input(name: string, fallback = ''): string {
  return (process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? fallback).trim() || fallback;
}

async function setOutput(name: string, value: string): Promise<void> {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function summary(markdown: string): Promise<void> {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

interface PullRequestEvent {
  pull_request?: {
    number: number;
    body: string | null;
    base: { sha: string };
    head: { sha: string };
  };
}

async function main(): Promise<number> {
  const token = input('github-token');
  const requireContract = input('require-contract', 'false') === 'true';
  const trustedAssociations = input('trusted-associations', DEFAULT_TRUSTED_ASSOCIATIONS.join(','))
    .split(',').map((value) => value.trim()).filter(Boolean);
  const root = input('working-directory', process.env.GITHUB_WORKSPACE ?? process.cwd());
  const repository = process.env.GITHUB_REPOSITORY ?? '';

  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as PullRequestEvent;
  const pr = event.pull_request;
  if (!pr) {
    await summary('agent-acceptance runs on `pull_request` events only; nothing to check.');
    return 0;
  }

  // Files and tests are read from the working tree, so it must be the PR head,
  // not the merge commit `actions/checkout` produces by default.
  const checkedOut = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  if (checkedOut !== pr.head.sha) {
    await summary(`❌ The working tree is at \`${checkedOut.slice(0, 12)}\`, not the PR head \`${pr.head.sha.slice(0, 12)}\`. Check out with \`ref: \${{ github.event.pull_request.head.sha }}\` and \`fetch-depth: 0\`.`);
    return 1;
  }

  const fetchIssue = async (number: number): Promise<IssueRecord | null> => {
    const response = await fetch(`https://api.github.com/repos/${repository}/issues/${number}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'stackbilt-agent-acceptance',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`issue #${number} lookup failed (${response.status})`);
    const data = (await response.json()) as {
      number: number;
      body: string | null;
      user?: { login?: string };
      author_association?: string;
      pull_request?: unknown;
    };
    return {
      number: data.number,
      body: data.body,
      author: data.user?.login ?? 'unknown',
      authorAssociation: data.author_association ?? 'NONE',
      isPullRequest: data.pull_request !== undefined,
    };
  };

  const contract = await resolveContract({ prBody: pr.body, fetchIssue, trustedAssociations });
  const notes = contract.notes.map((note) => `> ${note}`).join('\n');

  if (contract.kind === 'error') {
    await setOutput('status', 'failed');
    await summary(`### Agent acceptance\n\n❌ ${contract.error}${notes ? `\n\n${notes}` : ''}`);
    return 1;
  }

  const facts = checkoutFacts({ root, base: pr.base.sha, head: pr.head.sha });
  const verdict = await evaluateAcceptance(contract.kind === 'found' ? contract.spec : null, facts);
  const source = contract.kind === 'found' ? `Contract: ${contract.source}\n\n` : '';
  await setOutput('status', verdict.status);
  await summary(`### Agent acceptance\n\n${source}${formatAcceptanceReport(verdict)}${notes ? `\n\n${notes}` : ''}`);

  if (verdict.status === 'failed') return 1;
  if (verdict.status === 'unchecked' && requireContract) {
    await summary('\n❌ `require-contract` is on and this PR closes no issue with a trusted acceptance contract.');
    return 1;
  }
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(`agent-acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
