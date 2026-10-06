// Deletes the preview channels (pr-<number>) of pull requests that are no longer open, so the
// dev site stays under Hosting's channel quota. Run by preview.yml with the deployer identity.
// Needs PROJECT, GH_TOKEN and GITHUB_REPOSITORY in the environment.
import { execFileSync } from 'node:child_process';

const project = process.env.PROJECT;
const repo = process.env.GITHUB_REPOSITORY;
if (!project || !repo) throw new Error('PROJECT and GITHUB_REPOSITORY must be set');

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const openPrs = new Set(
  JSON.parse(run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number'])).map(
    (pr) => pr.number,
  ),
);

const listed = JSON.parse(
  run('firebase', ['hosting:channel:list', '--project', project, '--config', 'firebase.json', '--json']),
);
if (listed.status !== 'success') throw new Error(`hosting:channel:list failed: ${JSON.stringify(listed)}`);

const stale = listed.result.channels
  .map((channel) => channel.name.split('/').pop())
  .filter((id) => /^pr-\d+$/.test(id) && !openPrs.has(Number(id.slice(3))));

// Two PRs' preview jobs can prune at the same time, so a channel listed above may already be gone:
// a Not Found on delete counts as deleted. Any other failure still fails the job.
const deleteChannel = (id) => {
  try {
    execFileSync(
      'firebase',
      ['hosting:channel:delete', id, '--force', '--project', project, '--config', 'firebase.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return 'deleted';
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (/not found|404/i.test(output)) return 'already gone';
    process.stderr.write(output);
    throw error;
  }
};

for (const id of stale) console.log(`${id}: ${deleteChannel(id)}`);
console.log(`${stale.length} closed-PR channel(s) removed, ${openPrs.size} open PR(s) kept.`);
