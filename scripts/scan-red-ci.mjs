// scan-red-ci.mjs — collect FAILED `ci` workflow runs from the target repo's history.
//
// This is the corpus source for the auto-fix benchmark. A failed `ci` run = a commit
// whose test suite was red. We pair each with whether a LATER commit in the same branch
// went green (i.e. a fix exists) — that is what makes it a real "fix this" case.
//
// One API call per page (gh run list --status failure), not one per commit — the
// history has 1000+ commits, per-commit check-run scans are too slow.
//
// Output: data/red-ci-runs.json
// Usage:  node scripts/scan-red-ci.mjs [--target owner/name] [--want 120]
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TARGET = opt('target', 'trained-assist/trained-assist-agent');
const WANT = parseInt(opt('want', '120'), 10);

const gh = (a) => JSON.parse(execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 26 }));

const runs = gh(['run', 'list', '-R', TARGET, '--workflow', 'ci.yml', '--status', 'failure',
  '--limit', String(WANT), '--json', 'databaseId,headSha,headBranch,createdAt,conclusion,event']);

// The workflow file may not be literally `ci.yml`; fall back to listing all failed runs.
if (!runs.length) {
  const all = gh(['run', 'list', '-R', TARGET, '--status', 'failure', '--limit', String(WANT),
    '--json', 'databaseId,headSha,headBranch,createdAt,conclusion,event,name,workflowName']);
  runs.push(...all.filter(r => (r.workflowName || r.name || '').toLowerCase().includes('ci')));
}

const out = runs.map(r => ({
  sha: r.headSha,
  branch: r.headBranch,
  createdAt: r.createdAt,
  runId: r.databaseId,
  event: r.event,
}));

writeFileSync(new URL('../data/red-ci-runs.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ target: TARGET, redCiRuns: out.length, sample: out.slice(0, 5) }, null, 2));
