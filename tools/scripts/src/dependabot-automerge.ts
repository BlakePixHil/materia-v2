/**
 * `materia-scripts dependabot-automerge` (SEC-02): run by dependabot-automerge.yml after `ci` passes
 * on a pull request. It squash-merges Dependabot's weekly dev-patch group (patch updates of
 * development dependencies; .github/dependabot.yml) and nothing else: every other update waits for
 * review. It reads the pull request through the API and never runs its code.
 *
 * Needs GH_TOKEN, GITHUB_REPOSITORY, HEAD_BRANCH and HEAD_SHA (the commit `ci` tested).
 */

/** The branch Dependabot opens the dev-patch group on (`dependabot/npm_and_yarn/dev-patch-<hash>`). */
const DEV_PATCH_BRANCH = /^dependabot\/npm_and_yarn\/dev-patch-[0-9a-f]+$/;
const DEPENDABOT = 'dependabot[bot]';
/** A dev-patch update changes the manifest and the lockfile, nothing else. */
const ALLOWED_FILES = new Set(['package.json', 'pnpm-lock.yaml']);

export interface PullRequest {
  number: number;
  state: string;
  draft?: boolean;
  title: string;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export interface Commit {
  author: { login: string } | null;
}

export interface AutomergeInput {
  pr: PullRequest;
  /** The paths the pull request changes. */
  files: string[];
  commits: Commit[];
  /** The commit `ci` passed on. */
  testedSha: string;
}

/** Whether to merge, and why not when not: every check must hold. */
export function automergeDecision({ pr, files, commits, testedSha }: AutomergeInput): {
  merge: boolean;
  reason: string;
} {
  const checks: [boolean, string][] = [
    [pr.state === 'open' && !pr.draft, 'it is not an open, ready pull request'],
    [pr.user?.login === DEPENDABOT, `it was opened by ${pr.user?.login ?? 'nobody'}, not Dependabot`],
    [DEV_PATCH_BRANCH.test(pr.head.ref), `${pr.head.ref} is not the dev-patch group's branch`],
    [/\bthe dev-patch group\b/.test(pr.title), `"${pr.title}" is not the dev-patch group`],
    [pr.base.ref === 'main', `it targets ${pr.base.ref}, not main`],
    [pr.head.sha === testedSha, `its head ${pr.head.sha} is not the commit ci passed on (${testedSha})`],
    [
      commits.length > 0 && commits.every((commit) => commit.author?.login === DEPENDABOT),
      'a commit on it is not Dependabot’s',
    ],
    [
      files.length > 0 && files.every((file) => ALLOWED_FILES.has(file)),
      `it changes more than package.json and pnpm-lock.yaml (${files.join(', ')})`,
    ],
  ];
  const failed = checks.find(([ok]) => !ok);
  return failed ? { merge: false, reason: failed[1] } : { merge: true, reason: 'the dev-patch group passed ci' };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function github<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${process.env['GITHUB_API_URL'] ?? 'https://api.github.com'}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export async function main(): Promise<void> {
  const token = required('GH_TOKEN');
  const repo = required('GITHUB_REPOSITORY');
  const branch = required('HEAD_BRANCH');
  const testedSha = required('HEAD_SHA');
  const owner = repo.split('/')[0];

  const prs = await github<PullRequest[]>(
    token,
    'GET',
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  const pr = prs[0];
  if (!pr) {
    console.log(`No open pull request from ${branch}; nothing to merge.`);
    return;
  }
  const files = await github<{ filename: string }[]>(
    token,
    'GET',
    `/repos/${repo}/pulls/${pr.number}/files?per_page=100`,
  );
  const commits = await github<Commit[]>(token, 'GET', `/repos/${repo}/pulls/${pr.number}/commits?per_page=100`);
  const decision = automergeDecision({ pr, files: files.map((file) => file.filename), commits, testedSha });
  if (!decision.merge) {
    console.log(`#${pr.number} waits for review: ${decision.reason}.`);
    return;
  }
  // `sha` makes GitHub refuse the merge if anything was pushed after ci passed.
  await github(token, 'PUT', `/repos/${repo}/pulls/${pr.number}/merge`, {
    merge_method: 'squash',
    sha: testedSha,
    commit_title: `${pr.title} (#${pr.number})`,
  });
  console.log(`Merged #${pr.number} (${pr.title}): ${decision.reason}.`);
}
