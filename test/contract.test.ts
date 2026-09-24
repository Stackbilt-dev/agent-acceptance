import { describe, expect, it } from 'vitest';
import { linkedIssueNumbers, resolveContract, type IssueRecord } from '../src/contract.js';

const contract = '```acceptance\n{"max_added_lines": 10}\n```';

function issues(records: Record<number, Partial<IssueRecord>>) {
  return async (number: number): Promise<IssueRecord | null> => {
    const record = records[number];
    if (!record) return null;
    return { number, body: null, author: 'maintainer', authorAssociation: 'OWNER', isPullRequest: false, ...record };
  };
}

describe('linkedIssueNumbers', () => {
  it('reads GitHub closing keywords, deduplicated', () => {
    expect(linkedIssueNumbers('Fixes #12. Also closes #3 and resolves: #12')).toEqual([12, 3]);
    expect(linkedIssueNumbers('See #4 and refs #5')).toEqual([]);
    expect(linkedIssueNumbers(null)).toEqual([]);
  });
});

describe('resolveContract', () => {
  it('takes the contract from the linked issue', async () => {
    const result = await resolveContract({ prBody: 'Fixes #7', fetchIssue: issues({ 7: { body: contract } }) });
    expect(result).toMatchObject({ kind: 'found', spec: { max_added_lines: 10 }, source: '#7 by @maintainer' });
  });

  it('never reads a contract from the PR body', async () => {
    const result = await resolveContract({ prBody: `Fixes #7\n\n${contract}`, fetchIssue: issues({ 7: { body: 'no contract' } }) });
    expect(result.kind).toBe('none');
    expect(result.notes[0]).toMatch(/ignored/);
  });

  it('ignores contracts written by untrusted authors', async () => {
    const result = await resolveContract({
      prBody: 'Closes #9',
      fetchIssue: issues({ 9: { body: contract, author: 'drive-by', authorAssociation: 'NONE' } }),
    });
    expect(result.kind).toBe('none');
    expect(result.notes.join(' ')).toMatch(/@drive-by is NONE/);
  });

  it('honors a custom trusted list', async () => {
    const result = await resolveContract({
      prBody: 'Closes #9',
      fetchIssue: issues({ 9: { body: contract, authorAssociation: 'CONTRIBUTOR' } }),
      trustedAssociations: ['contributor'],
    });
    expect(result.kind).toBe('found');
  });

  it('errors on an invalid contract or on more than one', async () => {
    expect(await resolveContract({ prBody: 'Fixes #1', fetchIssue: issues({ 1: { body: '```acceptance\n{}\n```' } }) }))
      .toMatchObject({ kind: 'error', error: expect.stringMatching(/#1 is invalid/) });
    expect(await resolveContract({ prBody: 'Fixes #1, fixes #2', fetchIssue: issues({ 1: { body: contract }, 2: { body: contract } }) }))
      .toMatchObject({ kind: 'error', error: expect.stringMatching(/More than one/) });
  });

  it('skips linked pull requests', async () => {
    const result = await resolveContract({ prBody: 'Fixes #4', fetchIssue: issues({ 4: { body: contract, isPullRequest: true } }) });
    expect(result.kind).toBe('none');
  });
});
