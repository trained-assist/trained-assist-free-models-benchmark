// pick-failing-prs.mjs — find candidate FAILING pull requests for the real-world benchmark.
//
// We do NOT want 100 random red PRs: most red PRs are red for reasons a model should not
// be scored on (flaky test, missing secret, infra, someone else's broken dependency).
// We want PRs whose failure is CODE-CAUSED and reproducible from the PR's own diff.
//
// Heuristic this script applies (all via the GitHub API, no cloning):
//   1. PR is open, not draft, from a fork (so the head branch is clonable by anyone)
//   2. has at least one FAILED check run
//   3. the repo's CI runs on `pull_request` (so a green re-run is meaningful)
//   4. the failure is attributed to the PR head SHA (not main), and the PR is small
//      (few files / small diff) — small diffs are what auto-fix is aimed at
// Output: data/corpus.json (candidate list) for scripts/realworld.mjs to consume.
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';

const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26 }));
const REPOS = (process.argv[2] || 'sindresorhus/got,nodejs/undici,expressjs/express,axios/axios,sveltejs/kit,prettier/prettier,vitest-dev/vitest,remix-run/react-router').split(',');
const PER_REPO = parseInt(process.argv[3] || '6', 10);
const MAX_FILES = 8;

const corpus = [];
for (const repo of REPOS) {
  let prs = [];
  try {
    prs = gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '40',
      '--json', 'number,title,headRefName,headRepositoryOwner,isDraft,files,statusCheckRollup,headRefOid']);
  } catch (e) { console.error(`skip ${repo}: ${e.message.slice(0, 80)}`); continue; }

  for (const pr of prs) {
    if (pr.isDraft) continue;
    if (pr.headRepositoryOwner?.login === repo.split('/')[0]) continue; // need a fork to clone
    const failed = (pr.statusCheckRollup || []).filter(c =>
      c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT' || c.state === 'FAILURE');
    if (!failed.length) continue;
    const fileCount = (pr.files || []).length;
    if (fileCount === 0 || fileCount > MAX_FILES) continue;
    corpus.push({
      id: `${repo.replace('/', '-')}-${pr.number}`,
      repo,
      pr: pr.number,
      title: pr.title,
      headRef: pr.headRefName,
      headOwner: pr.headRepositoryOwner?.login,
      headSha: pr.headRefOid,
      files: fileCount,
      failedChecks: failed.map(f => f.name),
      cloneUrl: `https://github.com/${pr.headRepositoryOwner?.login}/${repo.split('/')[1]}.git`,
      verifyCmd: 'npm ci && npm test',
      taskPath: '.',
    });
    if (corpus.filter(c => c.repo === repo).length >= PER_REPO) break;
  }
  console.error(`${repo}: ${corpus.filter(c => c.repo === repo).length} candidates`);
}

writeFileSync(new URL('../data/corpus.json', import.meta.url), JSON.stringify(corpus, null, 2));
console.error(`\nTOTAL: ${corpus.length} candidate failing PRs -> data/corpus.json`);
