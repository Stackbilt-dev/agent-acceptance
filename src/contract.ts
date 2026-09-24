// Where a pull request's contract comes from.
//
// Never the pull request itself: its author is usually the agent, and a
// contract the agent can edit is the agent grading its own work. The contract
// lives in the issue the PR closes, written by someone the repository trusts,
// before the agent ran.

import { parseAcceptanceSpec, type AcceptanceSpec } from './spec.js';

export const DEFAULT_TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

/** Same-repository issue numbers a PR body closes with GitHub's closing keywords. */
export function linkedIssueNumbers(body: string | null | undefined): number[] {
  const numbers = [...(body ?? '').matchAll(CLOSING_REFERENCE)].map((match) => Number(match[1]));
  return [...new Set(numbers)];
}

export interface IssueRecord {
  number: number;
  body: string | null;
  author: string;
  authorAssociation: string;
  isPullRequest: boolean;
}

export type ContractResolution =
  | { kind: 'found'; spec: AcceptanceSpec; source: string; notes: string[] }
  | { kind: 'none'; notes: string[] }
  | { kind: 'error'; error: string; notes: string[] };

export async function resolveContract(options: {
  prBody: string | null | undefined;
  fetchIssue(number: number): Promise<IssueRecord | null>;
  trustedAssociations?: string[];
}): Promise<ContractResolution> {
  const trusted = new Set((options.trustedAssociations ?? DEFAULT_TRUSTED_ASSOCIATIONS).map((value) => value.toUpperCase()));
  const notes: string[] = [];
  const found: Array<{ spec: AcceptanceSpec; source: string }> = [];

  if (/```acceptance/.test(options.prBody ?? '')) {
    notes.push('The PR description contains an acceptance block. It was ignored: contracts are read only from linked issues.');
  }

  for (const number of linkedIssueNumbers(options.prBody)) {
    const issue = await options.fetchIssue(number);
    if (!issue || issue.isPullRequest) {
      notes.push(`#${number} is not an issue in this repository.`);
      continue;
    }
    const parsed = parseAcceptanceSpec(issue.body ?? '');
    if (parsed.kind === 'absent') continue;
    if (!trusted.has(issue.authorAssociation.toUpperCase())) {
      notes.push(`The contract in #${number} was ignored: its author @${issue.author} is ${issue.authorAssociation}, not one of ${[...trusted].join(', ')}.`);
      continue;
    }
    if (parsed.kind === 'invalid') {
      return { kind: 'error', error: `The contract in #${number} is invalid: ${parsed.error}`, notes };
    }
    found.push({ spec: parsed.spec, source: `#${number} by @${issue.author}` });
  }

  if (found.length > 1) {
    return { kind: 'error', error: `More than one linked issue carries a contract (${found.map((entry) => entry.source).join(', ')}). Link exactly one.`, notes };
  }
  if (found.length === 0) return { kind: 'none', notes };
  return { kind: 'found', spec: found[0].spec, source: found[0].source, notes };
}
