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

for (const id of stale) {
  run('firebase', ['hosting:channel:delete', id, '--force', '--project', project, '--config', 'firebase.json']);
  console.log(`deleted ${id}`);
}
console.log(`${stale.length} closed-PR channel(s) deleted, ${openPrs.size} open PR(s) kept.`);
