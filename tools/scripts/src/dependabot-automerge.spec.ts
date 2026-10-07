import { automergeDecision, type AutomergeInput, type PullRequest } from './dependabot-automerge.ts';

const SHA = 'a'.repeat(40);

function input(pr: Partial<PullRequest> = {}, rest: Partial<Omit<AutomergeInput, 'pr'>> = {}): AutomergeInput {
  return {
    pr: {
      number: 300,
      state: 'open',
      draft: false,
      title: 'chore(deps-dev): bump the dev-patch group across 1 directory with 3 updates',
      user: { login: 'dependabot[bot]' },
      head: { ref: 'dependabot/npm_and_yarn/dev-patch-1a2b3c4d5e', sha: SHA },
      base: { ref: 'main' },
      ...pr,
    },
    files: ['package.json', 'pnpm-lock.yaml'],
    commits: [{ author: { login: 'dependabot[bot]' } }],
    testedSha: SHA,
    ...rest,
  };
}

describe('dependabot-automerge (SEC-02)', () => {
  it("merges Dependabot's dev-patch group once ci passed on its head", () => {
    expect(automergeDecision(input())).toEqual({ merge: true, reason: 'the dev-patch group passed ci' });
  });

  it.each<[string, AutomergeInput, RegExp]>([
    ['another group', input({ head: { ref: 'dependabot/npm_and_yarn/dev-minor-1a2b3c', sha: SHA } }), /branch/],
    [
      'a production update',
      input({ title: 'chore(deps): bump the prod-minor-and-patch group with 2 updates' }),
      /not the dev-patch group/,
    ],
    ['a person’s pull request', input({ user: { login: 'someone' } }), /not Dependabot/],
    ['a draft', input({ draft: true }), /not an open/],
    ['a closed pull request', input({ state: 'closed' }), /not an open/],
    ['another base branch', input({ base: { ref: 'release' } }), /not main/],
    ['a commit pushed after ci passed', input({}, { testedSha: 'b'.repeat(40) }), /not the commit ci passed on/],
    [
      'a commit by someone else',
      input({}, { commits: [{ author: { login: 'dependabot[bot]' } }, { author: { login: 'someone' } }] }),
      /not Dependabot’s/,
    ],
    ['a commit with no GitHub author', input({}, { commits: [{ author: null }] }), /not Dependabot’s/],
    [
      'a change outside the manifest and lockfile',
      input({}, { files: ['package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml'] }),
      /more than package.json/,
    ],
    ['no files', input({}, { files: [] }), /more than package.json/],
  ])('leaves %s for review', (_name, given, reason) => {
    const decision = automergeDecision(given);
    expect(decision.merge).toBe(false);
    expect(decision.reason).toMatch(reason);
  });
});
